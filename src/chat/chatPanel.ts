/**
 * ChatPanel — the bridge between the VS Code extension host and the webview UI.
 *
 * VS Code extensions run in a Node.js process (the "extension host"), but the
 * chat UI runs in a sandboxed iframe (the "webview"). They can't share memory —
 * they communicate exclusively via postMessage(), like a browser iframe.
 *
 * This class:
 * - Creates and manages the webview panel (the chat tab in VS Code)
 * - Routes messages from the webview to the right handler
 * - Sends messages back to the webview for rendering
 * - Manages agent conversations and buffers messages for session persistence
 *
 * Two code paths exist:
 * - Conversational path: If the configured agent is registered as a
 *   ConversationalAgent, uses it for multi-turn streaming with MCP tools
 * - Pipeline path (fallback): One-shot search → build prompt → execute
 */
import * as vscode from "vscode";
import * as crypto from "crypto";
import { ProviderRegistry } from "../providers/registry";
import { executeQuery } from "../services/queryService";
import { getWebviewHtml } from "../webview/template";
import type { ConversationalAgent, AgentConversation } from "../providers/conversationalAgent";
import { SessionStore, StoredMessage } from "./sessionStore";
import type { ExtensionToWebviewMessage, PermissionModeValue, WebviewToExtensionMessage } from "./messages";

export interface ChatPanelConfig {
  contextProvider: string;
  codingAgent: string;
  maxSearchResults: number;
  maxThreadMessages: number;
}

/** Debug output channel — visible in Output panel > "Conduit Debug" even without
 *  a debugger attached (Ctrl+F5). Created lazily on first use. */
let debugChannel: vscode.OutputChannel | null = null;
function debug(msg: string) {
  if (!debugChannel) {
    debugChannel = vscode.window.createOutputChannel("Conduit Debug");
  }
  debugChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
  debugChannel.show(true); // true = preserve focus on editor
}

export class ChatPanel {
  /** Singleton — only one chat panel can be open at a time. */
  private static instance: ChatPanel | undefined;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private conversationalAgent: ConversationalAgent | null = null;
  private conversation: AgentConversation | null = null;
  private permissionMode: PermissionModeValue = "acceptEdits";
  private sessionStore: SessionStore;
  private activeSessionId: string | null = null;
  /** Accumulates messages during a conversation turn. Flushed to
   *  SessionStore when Claude finishes (sdk-done) so sessions persist. */
  private messageBuffer: StoredMessage[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private extensionUri: vscode.Uri,
    private context: vscode.ExtensionContext,
    private registry: ProviderRegistry,
    private getConfig: () => ChatPanelConfig
  ) {
    this.panel = panel;
    this.sessionStore = new SessionStore(context.workspaceState);
    this.panel.webview.html = this.getHtml();

    // Permission mode defaults to "acceptEdits" (auto-approve file edits,
    // ask before scripts). User can toggle via the UI at any time.

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  static open(
    context: vscode.ExtensionContext,
    registry: ProviderRegistry,
    getConfig: () => ChatPanelConfig
  ) {
    if (ChatPanel.instance) {
      ChatPanel.instance.panel.reveal();
      return;
    }

    const extensionUri = context.extensionUri;
    const panel = vscode.window.createWebviewPanel(
      "conduit.chat",
      "Conduit",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
      }
    );

    panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "conduit-icon.svg");
    ChatPanel.instance = new ChatPanel(panel, extensionUri, context, registry, getConfig);
  }

  private dispose() {
    if (this.conversation) {
      this.conversation.cancel();
      this.conversation = null;
    }
    ChatPanel.instance = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  /** Sends a typed message to the webview. This is the only way to communicate
   *  with the webview — you can't call functions or share objects directly. */
  private post(msg: ExtensionToWebviewMessage) {
    this.panel.webview.postMessage(msg);
  }

  /** Central message router. Every postMessage from the webview arrives here. */
  private async handleMessage(msg: WebviewToExtensionMessage) {
    debug(`handleMessage: ${msg.type}`);
    switch (msg.type) {
      case "webview-ready":
        // The webview's React app is mounted and listening for messages.
        // Send initial state that was deferred until we know it won't be dropped.
        this.post({ type: "permission-mode", mode: this.permissionMode });
       
        this.restoreMostRecentSession();
        this.checkSetupStatus();
        this.checkSlackConnection();
        break;
      case "query":
        await this.handleQuery(msg.text);
        break;
      case "search":
        await this.handleSearch(msg.text);
        break;
      case "followup":
        await this.handleFollowUp(msg.text);
        break;
      case "cancel":
        this.handleCancel();
        break;
      case "permission-response":
        this.conversation?.handlePermissionResponse(
          msg.requestId,
          msg.behavior
        );
        break;
      case "user-question-response":
        this.conversation?.handleUserQuestionResponse(
          msg.requestId,
          msg.answers
        );
        // Persist the answer so it survives session restoration.
        // Stored as a tool-result keyed by the question's requestId.
        this.messageBuffer.push({
          role: "tool-result",
          text: JSON.stringify(msg.answers).slice(0, 2000),
          toolCallId: msg.requestId,
          timestamp: Date.now(),
        });
        break;
      case "plan-review-response":
        this.conversation?.handlePlanReviewResponse(msg.requestId, msg.action);
        // Persist the user's choice so it survives session restoration.
        this.messageBuffer.push({
          role: "tool-result",
          text: msg.action.slice(0, 2000),
          toolCallId: msg.requestId,
          timestamp: Date.now(),
        });
        break;
      case "set-permission-mode":
        this.permissionMode = msg.mode;
        // Update the active conversation so the next query uses the new mode
        this.conversation?.setPermissionMode(msg.mode);
        // Echo back so the webview updates its UI state
        this.post({ type: "permission-mode", mode: msg.mode });
        break;
      case "check-setup":
        // User clicked "Check Again" — re-check CLI status.
        // checkSetupStatus() uses isAvailable() which spawns a fresh process
        // each time (no caching), so it always gets the latest state.
        await this.checkSetupStatus();
        break;
      case "open-setup-terminal":
        this.openSetupTerminal();
        break;
      case "check-slack-connection":
        await this.checkSlackConnection();
        break;
      case "connect-slack":
        await this.connectSlack();
        break;
      case "disconnect-slack":
        await this.disconnectSlack();
        break;
      case "load-session-list":
        this.post({ type: "session-list", sessions: this.sessionStore.getIndex() });
        break;
      case "open-session":
        await this.handleOpenSession(msg.sessionId);
        break;
      case "new-conversation":
        this.handleNewConversation();
        break;
      case "delete-session":
        this.sessionStore.deleteSession(msg.sessionId);
        this.post({ type: "session-list", sessions: this.sessionStore.getIndex() });
        break;
    }
  }

  private async handleQuery(text: string) {
    const config = this.getConfig();
    debug(`handleQuery config: ${JSON.stringify(config)}`);

    // If the configured agent is registered as a conversational agent,
    // use the multi-turn streaming path. Otherwise fall through to pipeline.
    const convAgent = this.registry.getConversationalAgent(config.codingAgent);
    if (convAgent) {
      await this.handleConversationalQuery(text, convAgent);
      return;
    }

    const provider = this.registry.getBusinessContext(config.contextProvider);
    const agent = this.registry.getCodingAgent(config.codingAgent);

    if (!provider) {
      this.post({ type: "error", text: `Context provider "${config.contextProvider}" not found.` });
      return;
    }
    if (!provider.isConfigured()) {
      this.post({ type: "error", text: `${provider.displayName} is not configured. Run "Conduit: Configure" from the command palette.` });
      return;
    }
    if (!agent) {
      this.post({ type: "error", text: `Coding agent "${config.codingAgent}" not found.` });
      return;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      this.post({ type: "error", text: "No workspace folder open. Open a project folder first." });
      return;
    }
    const workDir = folders[0].uri.fsPath;

    this.post({ type: "status", text: "Searching..." });

    try {
      const result = await executeQuery({
        userInput: text,
        provider,
        agent,
        workDir,
        config: {
          maxSearchResults: config.maxSearchResults,
          maxThreadMessages: config.maxThreadMessages,
        },
        progress: {
          report: (msg) => this.post({ type: "progress", text: msg }),
        },
        mentionResolver: {
          resolveAmbiguousUser: async (rawUser, matches) => {
            this.post({
              type: "info",
              text: `Multiple matches for @${rawUser} — using ${matches[0].realName} (${matches[0].name})`,
            });
            return matches[0].name;
          },
          resolveAmbiguousChannel: async (rawChannel, matches) => {
            this.post({
              type: "info",
              text: `Multiple matches for #${rawChannel} — using #${matches[0].name}`,
            });
            return matches[0].name;
          },
        },
        disambiguation: {
          disambiguate: async (clusters) => {
            const lines = clusters
              .map((c, i) => `${i + 1}. **${c.label}** — ${c.description} (${c.messages.length} messages)`)
              .join("\n");
            this.post({
              type: "info",
              text: `Found multiple topics:\n${lines}\n\nIncluding all topics.`,
            });
            return clusters;
          },
        },
        output: {
          log: (text) => this.post({ type: "log", text }),
          agentOutput: (text) => this.post({ type: "agent", text }),
          agentError: (text) => this.post({ type: "agent-error", text }),
        },
        isCancelled: () => false,
      });

      if (result.messagesFound === 0 && result.success) {
        this.post({ type: "assistant", text: "No messages found matching your query. Try being more specific." });
      } else if (result.success) {
        this.post({ type: "done", text: `Completed. Found ${result.messagesFound} messages, ${result.threadsFound} threads.` });
      } else if (result.error) {
        this.post({ type: "error", text: result.error });
      }
    } catch (err: any) {
      this.post({ type: "error", text: err.message });
    }

    this.post({ type: "status", text: "" });
  }

  private async handleSearch(text: string) {
    const config = this.getConfig();
    const provider = this.registry.getBusinessContext(config.contextProvider);

    if (!provider || !provider.isConfigured()) {
      this.post({ type: "error", text: "Provider not configured." });
      return;
    }

    this.post({ type: "status", text: "Searching..." });

    try {
      const results = await provider.searchMessages({
        query: text,
        maxResults: config.maxSearchResults,
      });

      if (results.length === 0) {
        this.post({ type: "assistant", text: "No messages found. Try a different query." });
      } else {
        const formatted = results
          .map((m) => `**${m.author}** in #${m.channel}\n> ${m.text}`)
          .join("\n\n---\n\n");
        this.post({
          type: "assistant",
          text: `Found ${results.length} messages:\n\n${formatted}`,
        });
      }
    } catch (err: any) {
      this.post({ type: "error", text: err.message });
    }

    this.post({ type: "status", text: "" });
  }

  /** Starts a new conversational agent query. Creates a session, sets up the
   *  conversation object, and begins streaming. All streamed messages pass
   *  through bufferAndForward() which both shows them in the UI and saves them. */
  private async handleConversationalQuery(text: string, agent: ConversationalAgent) {
    const config = this.getConfig();
    const provider = this.registry.getBusinessContext(config.contextProvider);

    if (!provider) {
      this.post({ type: "error", text: `Context provider "${config.contextProvider}" not found.` });
      return;
    }
    if (!provider.isConfigured()) {
      this.post({ type: "error", text: `${provider.displayName} is not configured. Run "Conduit: Configure" from the command palette.` });
      return;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      this.post({ type: "error", text: "No workspace folder open. Open a project folder first." });
      return;
    }

    this.conversationalAgent = agent;

    // Create a new session
    const tempId = crypto.randomUUID();
    this.sessionStore.createSession(tempId, text);
    this.activeSessionId = tempId;
    this.messageBuffer = [{ role: "user", text, timestamp: Date.now() }];

    this.post({ type: "status", text: "Thinking..." });

    debug(`Conversational query starting: agent=${agent.displayName} provider=${config.contextProvider} workspace=${folders[0].name} permissionMode=${this.permissionMode}`);

    this.conversation = agent.createConversation(
      {
        provider,
        workspaceName: folders[0].name,
        workingDirectory: folders[0].uri.fsPath,
        permissionMode: this.permissionMode,
      },
      (msg) => this.bufferAndForward(msg)
    );

    try {
      await this.conversation.start(text);
      debug("Conversational query completed");
    } catch (err: any) {
      debug(`Conversational query error: ${err.message}`);
      // Runtime auth fallback: If the error looks like an auth failure,
      // surface the setup screen so the user can re-authenticate instead of
      // seeing a cryptic error. Each agent knows its own auth error patterns.
      if (agent.isAuthError(err.message ?? "")) {
        debug("Auth error detected — switching to setup screen");
        this.post({ type: "setup-status", cliInstalled: true, cliAuthenticated: false, setupInfo: agent.getSetupInfo() });
      }
      this.post({ type: "error", text: err.message });
    }

    this.post({ type: "status", text: "" });
  }

  private async handleFollowUp(text: string) {
    debug(`handleFollowUp: hasConversation=${!!this.conversation} sessionId=${this.activeSessionId}`);
    if (!this.conversation) {
      this.post({ type: "error", text: "No active conversation. Start a new query first." });
      return;
    }

    this.messageBuffer.push({ role: "user", text, timestamp: Date.now() });

    this.post({ type: "status", text: "Thinking..." });

    try {
      await this.conversation.followUp(text);
    } catch (err: any) {
      if (this.conversationalAgent?.isAuthError(err.message ?? "")) {
        debug("Auth error on follow-up — switching to setup screen");
        this.post({ type: "setup-status", cliInstalled: true, cliAuthenticated: false, setupInfo: this.conversationalAgent.getSetupInfo() });
      }
      this.post({ type: "error", text: err.message });
    }

    this.post({ type: "status", text: "" });
  }

  /** Intercepts every message from the conversational agent. Two jobs:
   *  1. Converts agent messages into StoredMessages and buffers them
   *  2. Forwards the original message to the webview for live rendering
   *  On sdk-done, flushes the buffer to the SessionStore for persistence. */
  private bufferAndForward(msg: ExtensionToWebviewMessage): void {
    switch (msg.type) {
      case "sdk-text":
        this.messageBuffer.push({ role: "assistant", text: msg.text, timestamp: Date.now() });
        // Runtime auth fallback: The CLI sends "Not logged in · Please
        // run /login" as a text message (not an error), then exits with code 1.
        // Detect it here and switch to the setup screen immediately.
        if (this.conversationalAgent?.isAuthError(msg.text)) {
          debug("Auth error in agent text — switching to setup screen");
          this.post({ type: "setup-status", cliInstalled: true, cliAuthenticated: false, setupInfo: this.conversationalAgent.getSetupInfo() });
        }
        break;
      case "sdk-tool-call":
        this.messageBuffer.push({
          role: "tool-call", text: msg.input.slice(0, 2000), toolName: msg.toolName,
          toolCallId: msg.toolCallId, timestamp: Date.now(),
        });
        break;
      case "user-question":
        // Persist AskUserQuestion as a tool-call so it shows in session history
        this.messageBuffer.push({
          role: "tool-call", text: JSON.stringify(msg.questions).slice(0, 2000),
          toolName: "AskUserQuestion", toolCallId: msg.requestId, timestamp: Date.now(),
        });
        break;
      case "plan-review":
        // Persist ExitPlanMode as a tool-call so it shows in session history
        this.messageBuffer.push({
          role: "tool-call", text: msg.planText,
          toolName: "ExitPlanMode", toolCallId: msg.requestId, timestamp: Date.now(),
        });
        break;
      case "sdk-tool-result":
        this.messageBuffer.push({
          role: "tool-result", text: msg.result.slice(0, 200),
          toolCallId: msg.toolCallId, timestamp: Date.now(),
        });
        break;
      case "sdk-done":
        this.flushMessageBuffer();
        // Update session ID from agent if available
        if (this.conversation?.sessionId && this.activeSessionId) {
          const agentSessionId = this.conversation.sessionId;
          if (agentSessionId !== this.activeSessionId) {
            this.sessionStore.updateSessionId(this.activeSessionId, agentSessionId);
            this.activeSessionId = agentSessionId;
          }
        }
        break;
      case "sdk-compact-summary":
        this.messageBuffer.push({ role: "info", text: "[compact] " + msg.text.slice(0, 2000), timestamp: Date.now() });
        break;
      case "sdk-error":
        this.messageBuffer.push({ role: "error", text: msg.text, timestamp: Date.now() });
        this.flushMessageBuffer();
        // Runtime auth fallback: The CLI's auth error ("Not logged in")
        // arrives here as a streamed sdk-error, not as a thrown exception. Detect
        // it and switch to the setup screen so the user can re-authenticate.
        if (this.conversationalAgent?.isAuthError(msg.text)) {
          debug("Auth error in agent stream — switching to setup screen");
          this.post({ type: "setup-status", cliInstalled: true, cliAuthenticated: false, setupInfo: this.conversationalAgent.getSetupInfo() });
        }
        break;
    }
    this.post(msg);
  }

  private flushMessageBuffer(): void {
    if (this.activeSessionId && this.messageBuffer.length > 0) {
      this.sessionStore.appendMessages(this.activeSessionId, this.messageBuffer);
      this.messageBuffer = [];
    }
  }

  /** Restores a past session: loads stored messages, sends them to the webview
   *  for rendering, and pre-creates an agent conversation with the session ID
   *  so the next follow-up message resumes the conversation with full context. */
  private async handleOpenSession(sessionId: string): Promise<void> {
    // Cancel any active conversation
    if (this.conversation) {
      this.conversation.cancel();
      this.conversation = null;
    }

    const data = this.sessionStore.getSession(sessionId);
    if (!data) {
      this.post({ type: "error", text: "Session not found." });
      return;
    }

    this.activeSessionId = sessionId;
    this.messageBuffer = [];
    this.post({ type: "session-opened", meta: data.meta, messages: data.messages });

    // Pre-create conversation with existing session ID for resume
    this.recreateConversationForResume(sessionId);
  }

  private handleNewConversation(): void {
    if (this.conversation) {
      this.conversation.cancel();
      this.conversation = null;
    }
    this.activeSessionId = null;
    this.messageBuffer = [];
    this.post({ type: "session-cleared" });
  }

  /** Cancels the active agent query and prepares the conversation for resume.
   *  After cancelling, the user can type a natural language follow-up to
   *  continue the conversation — the agent session ID is preserved so the
   *  agent picks up where it left off with full prior context. */
  private handleCancel() {
    if (this.conversation) {
      const sessionId = this.conversation.sessionId;
      this.conversation.cancel();
      this.conversation = null;

      // Save any partial messages accumulated before the cancel
      this.flushMessageBuffer();

      // Re-create the conversation so the user can follow up after cancel.
      // Without this, handleFollowUp() would fail with "no active conversation"
      // because cancel() sets conversation to null.
      if (sessionId && this.activeSessionId) {
        this.recreateConversationForResume(sessionId);
      }

      this.post({ type: "status", text: "" });
      this.post({ type: "info", text: "Query cancelled. You can type to continue." });
    }
  }

  /** Creates a new conversation pre-loaded with the given session ID
   *  so the next follow-up message resumes with full prior context. */
  private recreateConversationForResume(sessionId: string): void {
    const config = this.getConfig();
    const provider = this.registry.getBusinessContext(config.contextProvider);
    const folders = vscode.workspace.workspaceFolders;
    const agent = this.conversationalAgent ?? this.registry.getConversationalAgent(config.codingAgent);

    if (agent && provider?.isConfigured() && folders && folders.length > 0) {
      this.conversationalAgent = agent;
      this.conversation = agent.createConversationForResume(
        {
          provider,
          workspaceName: folders[0].name,
          workingDirectory: folders[0].uri.fsPath,
          permissionMode: this.permissionMode,
        },
        (msg) => this.bufferAndForward(msg),
        sessionId,
      );
    }
  }

  /** On startup, loads the most recent session so the user sees their last
   *  conversation instead of a blank welcome screen. Skips sessions with
   *  no meaningful content — requires at least one assistant response (not
   *  just errors, which indicate a failed query like auth failure). */
  private restoreMostRecentSession(): void {
    const index = this.sessionStore.getIndex();
    for (const entry of index) {
      const data = this.sessionStore.getSession(entry.sessionId);
      if (!data) continue;
      // Require an actual assistant response — error-only sessions (e.g. "Not
      // logged in") shouldn't be restored as they show stale failure messages.
      const hasAssistantResponse = data.messages.some((m) => m.role === "assistant");
      if (hasAssistantResponse) {
        this.handleOpenSession(entry.sessionId);
        return;
      }
    }
  }

  /**
   * Checks if the configured conversational agent's CLI is installed and
   * authenticated, then sends the result to the webview. The webview decides
   * what to show based on the result (setup screen vs. normal chat).
   */
  private async checkSetupStatus(): Promise<void> {
    const config = this.getConfig();
    const agent = this.registry.getConversationalAgent(config.codingAgent);

    if (!agent) {
      // No conversational agent configured — skip setup check (pipeline agents
      // don't need CLI detection; they're checked at query time).
      this.post({ type: "setup-status", cliInstalled: true, cliAuthenticated: true });
      return;
    }

    this.conversationalAgent = agent;

    // Reset cached state so "Check Again" picks up a freshly installed CLI.
    agent.resetCache();

    const cliInstalled = await agent.isAvailable();
    debug(`checkSetupStatus: agent=${agent.displayName} cliInstalled=${cliInstalled}`);

    let cliAuthenticated = false;
    if (cliInstalled) {
      cliAuthenticated = await agent.isAuthenticated();
      debug(`checkSetupStatus: cliAuthenticated=${cliAuthenticated}`);
    }

    this.post({ type: "setup-status", cliInstalled, cliAuthenticated, setupInfo: agent.getSetupInfo() });
  }

  /** Opens a VS Code integrated terminal and runs the agent's setup command
   *  to trigger authentication (e.g. `claude` for Claude, `codex --auth` for Codex). */
  private openSetupTerminal(): void {
    const agent = this.conversationalAgent;
    const command = agent?.getSetupCommand() ?? "claude";
    const name = agent?.getSetupInfo().displayName ?? "Agent";
    const terminal = vscode.window.createTerminal({ name: `${name} Setup` });
    terminal.show();
    terminal.sendText(command);
  }

  /** Checks Slack connection status and sends it to the webview. */
  private async checkSlackConnection(): Promise<void> {
    const slackProvider = this.registry.getBusinessContext("slack");
    if (!slackProvider) {
      this.post({ type: "slack-status", connected: false });
      return;
    }

    // SlackProvider has getConnectionStatus method from OAuth implementation
    const status = await (slackProvider as any).getConnectionStatus();
    this.post({ type: "slack-status", ...status });
  }

  /** Static method to notify webview of Slack connection status change.
   *  Called from extension.ts after OAuth callback completes. */
  static checkSlackConnection(): void {
    if (ChatPanel.instance) {
      ChatPanel.instance.checkSlackConnection();
    }
  }

  /** Initiates Slack OAuth flow by opening browser to authorization URL. */
  private async connectSlack(): Promise<void> {
    const slackProvider = this.registry.getBusinessContext("slack");
    if (!slackProvider) {
      vscode.window.showErrorMessage("Slack provider not available");
      return;
    }

    try {
      await (slackProvider as any).initiateOAuth(this.context);
      // Status will be updated via URI handler callback
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to start Slack auth: ${err.message}`);
    }
  }

  /** Disconnects Slack by clearing token and workspace name. */
  private async disconnectSlack(): Promise<void> {
    const slackProvider = this.registry.getBusinessContext("slack");
    if (!slackProvider) return;

    await (slackProvider as any).disconnect();
    await this.checkSlackConnection(); // Send updated status to webview
    vscode.window.showInformationMessage("Slack disconnected");
  }

  private getHtml(): string {
    const webview = this.panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js")
    ).toString();
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.css")
    ).toString();
    const nonce = getNonce();
    return getWebviewHtml({
      scriptUri,
      styleUri,
      nonce,
      cspSource: webview.cspSource,
    });
  }
}

function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
