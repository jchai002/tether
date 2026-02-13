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
 * - Manages SDK conversations and buffers messages for session persistence
 *
 * Two code paths exist:
 * - SDK path (codingAgent === "claude-sdk"): Uses ClaudeSDKAgent for a
 *   conversational, multi-turn experience with live streaming
 * - Pipeline path (any other agent): One-shot search → build prompt → execute
 */
import * as vscode from "vscode";
import * as crypto from "crypto";
import { ProviderRegistry } from "../providers/registry";
import { executeQuery } from "../services/queryService";
import { getWebviewHtml } from "../webview/template";
import { ClaudeSDKAgent, SDKConversation } from "../providers/agents/claude-sdk/claudeSDKAgent";
import { SessionStore, StoredMessage } from "./sessionStore";
import type { ExtensionToWebviewMessage, PermissionModeValue, WebviewToExtensionMessage } from "./messages";

export interface ChatPanelConfig {
  contextProvider: string;
  codingAgent: string;
  autoApprove: boolean;
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
  private sdkAgent: ClaudeSDKAgent | null = null;
  private sdkConversation: SDKConversation | null = null;
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

    // Initialize permission mode from config (actual sync happens on "webview-ready")
    const initialConfig = getConfig();
    this.permissionMode = initialConfig.autoApprove ? "bypassPermissions" : "acceptEdits";

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
    if (this.sdkConversation) {
      this.sdkConversation.cancel();
      this.sdkConversation = null;
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
        // Check if Claude CLI is ready before restoring the session.
        // The webview uses setupStatus to decide whether to show the setup
        // screen or the normal chat experience.
        await this.checkSetupStatus();
        await this.checkSlackConnection();
        this.restoreMostRecentSession();
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
        this.sdkConversation?.handlePermissionResponse(
          msg.requestId,
          msg.behavior
        );
        break;
      case "set-permission-mode":
        this.permissionMode = msg.mode;
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

    if (config.codingAgent === "claude-sdk") {
      await this.handleClaudeSDKQuery(text);
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
          autoApprove: config.autoApprove,
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

  /** Starts a new SDK conversation. Creates a session, sets up the conversation
   *  object, and begins streaming. All streamed messages pass through
   *  bufferAndForward() which both shows them in the UI and saves them. */
  private async handleClaudeSDKQuery(text: string) {
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

    if (!this.sdkAgent) {
      this.sdkAgent = new ClaudeSDKAgent();
    }

    // Create a new session
    const tempId = crypto.randomUUID();
    this.sessionStore.createSession(tempId, text);
    this.activeSessionId = tempId;
    this.messageBuffer = [{ role: "user", text, timestamp: Date.now() }];

    this.post({ type: "status", text: "Thinking..." });

    const binaryPath = this.sdkAgent.getClaudeBinaryPath();
    debug(`SDK query starting: provider=${config.contextProvider} workspace=${folders[0].name} binary=${binaryPath} permissionMode=${this.permissionMode}`);

    this.sdkConversation = this.sdkAgent.createConversation(
      {
        provider,
        workspaceName: folders[0].name,
        workingDirectory: folders[0].uri.fsPath,
        permissionMode: this.permissionMode,
      },
      (msg) => this.bufferAndForward(msg)
    );

    try {
      await this.sdkConversation.start(text);
      debug("SDK query completed");
    } catch (err: any) {
      debug(`SDK query error: ${err.message}`);
      // Runtime auth fallback (Tier 2): If the error looks like an auth failure,
      // surface the setup screen so the user can re-authenticate instead of
      // seeing a cryptic error. This catches cases where credentials expire
      // between the initial check and the actual query.
      if (this.isAuthError(err)) {
        debug("Auth error detected — switching to setup screen");
        this.post({ type: "setup-status", cliInstalled: true, cliAuthenticated: false });
      }
      this.post({ type: "error", text: err.message });
    }

    this.post({ type: "status", text: "" });
  }

  private async handleFollowUp(text: string) {
    debug(`handleFollowUp: hasConversation=${!!this.sdkConversation} sessionId=${this.activeSessionId}`);
    if (!this.sdkConversation) {
      this.post({ type: "error", text: "No active conversation. Start a new query first." });
      return;
    }

    this.messageBuffer.push({ role: "user", text, timestamp: Date.now() });

    this.post({ type: "status", text: "Thinking..." });

    try {
      await this.sdkConversation.followUp(text);
    } catch (err: any) {
      if (this.isAuthError(err)) {
        debug("Auth error on follow-up — switching to setup screen");
        this.post({ type: "setup-status", cliInstalled: true, cliAuthenticated: false });
      }
      this.post({ type: "error", text: err.message });
    }

    this.post({ type: "status", text: "" });
  }

  /** Intercepts every message from the SDK conversation. Two jobs:
   *  1. Converts SDK messages into StoredMessages and buffers them
   *  2. Forwards the original message to the webview for live rendering
   *  On sdk-done, flushes the buffer to the SessionStore for persistence. */
  private bufferAndForward(msg: ExtensionToWebviewMessage): void {
    switch (msg.type) {
      case "sdk-text":
        this.messageBuffer.push({ role: "assistant", text: msg.text, timestamp: Date.now() });
        // Runtime auth fallback (Tier 2): The CLI sends "Not logged in · Please
        // run /login" as a text message (not an error), then exits with code 1.
        // Detect it here and switch to the setup screen immediately.
        if (this.isAuthError(msg.text)) {
          debug("Auth error in SDK text — switching to setup screen");
          this.post({ type: "setup-status", cliInstalled: true, cliAuthenticated: false });
        }
        break;
      case "sdk-tool-call":
        this.messageBuffer.push({
          role: "tool-call", text: msg.input.slice(0, 2000), toolName: msg.toolName,
          toolCallId: msg.toolCallId, timestamp: Date.now(),
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
        // Update session ID from SDK if available
        if (this.sdkConversation?.sessionId && this.activeSessionId) {
          const sdkId = this.sdkConversation.sessionId;
          if (sdkId !== this.activeSessionId) {
            this.sessionStore.updateSessionId(this.activeSessionId, sdkId);
            this.activeSessionId = sdkId;
          }
        }
        break;
      case "sdk-error":
        this.messageBuffer.push({ role: "error", text: msg.text, timestamp: Date.now() });
        this.flushMessageBuffer();
        // Runtime auth fallback (Tier 2): The CLI's auth error ("Not logged in")
        // arrives here as a streamed sdk-error, not as a thrown exception. Detect
        // it and switch to the setup screen so the user can re-authenticate.
        if (this.isAuthError(msg.text)) {
          debug("Auth error in SDK stream — switching to setup screen");
          this.post({ type: "setup-status", cliInstalled: true, cliAuthenticated: false });
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
   *  for rendering, and pre-creates an SDK conversation with the session ID
   *  so the next follow-up message resumes the conversation with full context. */
  private async handleOpenSession(sessionId: string): Promise<void> {
    // Cancel any active conversation
    if (this.sdkConversation) {
      this.sdkConversation.cancel();
      this.sdkConversation = null;
    }

    const data = this.sessionStore.getSession(sessionId);
    if (!data) {
      this.post({ type: "error", text: "Session not found." });
      return;
    }

    this.activeSessionId = sessionId;
    this.messageBuffer = [];
    this.post({ type: "session-opened", meta: data.meta, messages: data.messages });

    // Pre-create SDK conversation with existing session ID for resume
    this.recreateConversationForResume(sessionId);
  }

  private handleNewConversation(): void {
    if (this.sdkConversation) {
      this.sdkConversation.cancel();
      this.sdkConversation = null;
    }
    this.activeSessionId = null;
    this.messageBuffer = [];
    this.post({ type: "session-cleared" });
  }

  /** Cancels the active agent query and prepares the conversation for resume.
   *  After cancelling, the user can type a natural language follow-up to
   *  continue the conversation — the SDK session ID is preserved so the
   *  agent picks up where it left off with full prior context. */
  private handleCancel() {
    if (this.sdkConversation) {
      const sessionId = this.sdkConversation.sessionId;
      this.sdkConversation.cancel();
      this.sdkConversation = null;

      // Save any partial messages accumulated before the cancel
      this.flushMessageBuffer();

      // Re-create the conversation so the user can follow up after cancel.
      // Without this, handleFollowUp() would fail with "no active conversation"
      // because cancel() sets sdkConversation to null.
      if (sessionId && this.activeSessionId) {
        this.recreateConversationForResume(sessionId);
      }

      this.post({ type: "status", text: "" });
      this.post({ type: "info", text: "Query cancelled. You can type to continue." });
    }
  }

  /** Creates a new SDK conversation pre-loaded with the given session ID
   *  so the next follow-up message resumes with full prior context. */
  private recreateConversationForResume(sessionId: string): void {
    const config = this.getConfig();
    const provider = this.registry.getBusinessContext(config.contextProvider);
    const folders = vscode.workspace.workspaceFolders;

    if (provider?.isConfigured() && folders && folders.length > 0) {
      if (!this.sdkAgent) {
        this.sdkAgent = new ClaudeSDKAgent();
      }
      this.sdkConversation = this.sdkAgent.createConversationForResume(
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
   * Checks if the Claude Code CLI is installed and authenticated, then
   * sends the result to the webview. The webview decides what to show
   * based on the result (setup screen vs. normal chat).
   *
   * We use isAvailable() (spawns `claude --version` with shell:true) as
   * the primary check because it works regardless of how Claude was
   * installed — npm, brew, winget, installer, scoop, etc. The shell
   * resolves the command from PATH on all platforms.
   *
   * getClaudeBinaryPath() only finds npm-installed binaries on Windows
   * (and uses `which` which doesn't exist on Windows), so it's unreliable
   * as a cross-platform install check. It's still used as an optimization
   * for passing `pathToClaudeCodeExecutable` to the SDK during queries.
   */
  private async checkSetupStatus(): Promise<void> {
    if (!this.sdkAgent) {
      this.sdkAgent = new ClaudeSDKAgent();
    }

    // Reset binary cache so "Check Again" picks up a freshly installed CLI.
    this.sdkAgent.resetBinaryCache();

    // isAvailable() runs `claude --version` with the user's login shell,
    // which works on Unix and Windows regardless of install method.
    const cliInstalled = await this.sdkAgent.isAvailable();
    debug(`checkSetupStatus: cliInstalled=${cliInstalled}`);

    // Auth check: spawn a minimal SDK query and call accountInfo().
    // This is the only cross-platform way to verify auth — macOS stores
    // credentials in Keychain (no file to check), Linux/Windows use a file
    // but we don't want to depend on internal storage details.
    let cliAuthenticated = false;
    if (cliInstalled) {
      cliAuthenticated = await this.sdkAgent.isAuthenticated();
      debug(`checkSetupStatus: cliAuthenticated=${cliAuthenticated}`);
    }

    this.post({ type: "setup-status", cliInstalled, cliAuthenticated });
  }

  /** Checks if an error or message text looks like a Claude CLI authentication
   *  failure. Accepts either an Error object or a plain string.
   *  Used as a runtime fallback (Tier 2) — if credentials expire between the
   *  initial setup check and an actual query, we catch it here and show the
   *  setup screen instead of a cryptic error.
   *
   *  IMPORTANT: These patterns must be specific to Claude CLI auth errors.
   *  Generic words like "authentication" or "unauthorized" match Slack API
   *  errors too, which would falsely kick users to the setup screen. */
  private isAuthError(errOrText: any): boolean {
    const msg = (typeof errOrText === "string" ? errOrText : errOrText?.message || "").toLowerCase();
    return (
      msg.includes("not logged in") ||
      msg.includes("/login") ||
      msg.includes("please run claude login")
    );
  }

  /** Opens a VS Code integrated terminal and runs `claude` to trigger
   *  the browser-based OAuth flow. */
  private openSetupTerminal(): void {
    const terminal = vscode.window.createTerminal({ name: "Claude Setup" });
    terminal.show();
    terminal.sendText("claude");
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
