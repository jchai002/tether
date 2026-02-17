/**
 * Claude SDK Agent — the primary AI integration path.
 *
 * How it works at a high level:
 * 1. The SDK spawns Claude Code CLI as a subprocess (we don't manage the process)
 * 2. We send a prompt via `query()`, which returns an async stream of messages
 * 3. Claude can call tools (read files, edit code, etc.) AND our custom MCP tools
 * 4. We forward each streamed message to the webview for live rendering
 * 5. The user can send follow-up messages using `resume` (the SDK tracks history)
 *
 * Key concepts:
 * - MCP (Model Context Protocol): Lets us give Claude access to custom tools
 *   (like searching Slack) alongside its built-in tools (like reading files).
 *   Think of it as a plugin API for AI models.
 * - Session: A conversation with Claude. The SDK assigns a session_id that
 *   we store so the user can resume conversations later.
 * - Permissions: Claude asks permission before dangerous actions (editing files,
 *   running commands). We forward these to the webview as UI prompts.
 */
import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { execSync, spawn as nodeSpawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import type { BusinessContextProvider } from "../../businessContextProvider";
import type { ConversationalAgent, AgentConversation, AgentSetupInfo, ConversationOptions, OnAgentMessage } from "../../conversationalAgent";
import { createSearchTool, createGetThreadTool, getToolNames } from "./mcpTools";
import { buildSystemPrompt } from "./systemPrompt";
import type { ExtensionToWebviewMessage } from "../../../chat/messages";

/**
 * Returns the user's default shell from $SHELL (falls back to /bin/bash).
 * Used so we source the right init files (.zshrc vs .bashrc, etc.).
 */
function getUserShell(): string {
  return process.env.SHELL || "/bin/bash";
}

/**
 * Gets the user's full shell PATH by spawning their default shell with
 * -lic (login + interactive + command). This loads init files like .zshrc
 * and .bashrc which add tools like nvm, brew, cargo, etc. to PATH.
 *
 * The VS Code extension host inherits a stripped-down system PATH that
 * misses user-installed tools. This function bridges that gap.
 *
 * Cached — only runs once per extension activation.
 * On Windows, returns undefined (cmd.exe inherits the full user PATH).
 */
let cachedLoginShellPath: string | undefined;
let loginShellPathResolved = false;

function getLoginShellPath(): string | undefined {
  if (loginShellPathResolved) return cachedLoginShellPath;
  loginShellPathResolved = true;
  if (process.platform === "win32") return undefined;
  try {
    const shell = getUserShell();
    // -lic = login + interactive + command. Interactive is needed because
    // .bashrc/.zshrc often guard against non-interactive shells.
    // Use a marker prefix so we can parse the PATH from noisy shell output.
    const result = execSync(`${shell} -lic 'echo __CONDUIT_PATH__=$PATH'`, {
      encoding: "utf-8",
      timeout: 5000,
    });
    const match = result.match(/__CONDUIT_PATH__=(.+)/);
    cachedLoginShellPath = match?.[1]?.trim();
    return cachedLoginShellPath;
  } catch {
    return undefined;
  }
}

/**
 * Locates the Claude Code CLI binary using the user's login shell.
 *
 * On Windows, checks the npm global prefix for the .js entry point
 * (because .cmd wrappers can't be spawned without shell:true).
 */
function findClaudeBinary(): string | undefined {
  try {
    if (process.platform === "win32") {
      const prefix = execSync("npm prefix -g", {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      const entryPoint = path.join(
        prefix,
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "cli.js"
      );
      if (fs.existsSync(entryPoint)) {
        return entryPoint;
      }
    }

    // Unix: use the user's actual shell so their init scripts are sourced.
    const shell = getUserShell();
    const result = execSync(`${shell} -lic 'which claude'`, {
      encoding: "utf-8",
      timeout: 5000,
    });
    // Interactive shells may print noise (motd, warnings). The `which` output
    // is a path starting with `/`, so grab the last such line.
    const lines = result.split("\n");
    const pathLine = lines.reverse().find((l) => l.trim().startsWith("/"));
    return pathLine?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Factory that creates SDK conversations. Caches expensive resources that
 * don't change between conversations:
 * - Claude binary path (avoids `execSync` on every conversation)
 * - MCP server + tools (reused as long as the provider hasn't changed)
 * - System prompt (reused as long as the workspace hasn't changed)
 */
export class ClaudeSDKAgent implements ConversationalAgent {
  readonly id = "claude-sdk";
  readonly displayName = "Claude Code (SDK)";

  /** Cached Claude CLI path — resolved once via execSync, reused forever. */
  private cachedBinaryPath: string | undefined;
  private binaryPathResolved = false;

  /** Cached MCP server — reused across conversations with the same provider. */
  private cachedMcpServer: ReturnType<typeof createSdkMcpServer> | null = null;
  private cachedProviderId: string | null = null;

  /** Cached system prompt — reused across conversations with same workspace + provider. */
  private cachedSystemPrompt: string | null = null;
  private cachedSystemPromptKey: string | null = null;

  // ── ConversationalAgent interface methods ──────────────────

  getSetupInfo(): AgentSetupInfo {
    return {
      displayName: "Claude Code",
      installCommand: "npm install -g @anthropic-ai/claude-code",
      cliBinaryName: "claude",
    };
  }

  getSetupCommand(): string {
    return "claude";
  }

  resetCache(): void {
    this.binaryPathResolved = false;
    this.cachedBinaryPath = undefined;
  }

  /** Checks if an error message looks like a Claude CLI auth failure.
   *  Patterns must be specific to Claude — generic words like "unauthorized"
   *  would falsely match Slack API errors. */
  isAuthError(text: string): boolean {
    const msg = text.toLowerCase();
    return (
      msg.includes("not logged in") ||
      msg.includes("/login") ||
      msg.includes("please run claude login")
    );
  }

  /**
   * Checks if the Claude CLI is available by running `claude --version`.
   *
   * Uses the user's default shell with -lic (login + interactive + command)
   * so init files (.zshrc, .bashrc) are sourced and tools like nvm are loaded.
   */
  async isAvailable(): Promise<boolean> {
    const { spawn } = await import("child_process");
    return new Promise((resolve) => {
      try {
        const isWin = process.platform === "win32";
        const child = isWin
          ? spawn("claude", ["--version"], { shell: true })
          : spawn(getUserShell(), ["-lic", "claude --version"]);

        const timeout = setTimeout(() => {
          child.kill();
          resolve(false);
        }, 10_000);
        child.on("close", (code) => {
          clearTimeout(timeout);
          resolve(code === 0);
        });
        child.on("error", () => {
          clearTimeout(timeout);
          resolve(false);
        });
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * Checks if the Claude CLI is authenticated by spawning a minimal SDK
   * query (maxTurns: 0) and iterating the stream. If the CLI is not logged
   * in, the first streamed message will be "Not logged in · Please run /login"
   * followed by exit code 1.
   *
   * We originally used accountInfo() but it returns cached local data even
   * when the user is logged out, so it can't detect auth status reliably.
   *
   * Requires the CLI to be installed first (call isAvailable() before this).
   */
  async isAuthenticated(): Promise<boolean> {
    try {
      const binaryPath = this.getClaudeBinaryPath();
      const loginPath = getLoginShellPath();
      const abortController = new AbortController();
      const q = query({
        prompt: "test",
        options: {
          maxTurns: 0,
          abortController,
          ...(binaryPath ? { pathToClaudeCodeExecutable: binaryPath } : {}),
          // Same custom spawn as real queries — needs the login shell PATH.
          spawnClaudeCodeProcess: (spawnOpts: {
            command: string;
            args: string[];
            cwd?: string;
            env: Record<string, string | undefined>;
            signal: AbortSignal;
          }) => {
            const env = { ...spawnOpts.env };
            if (loginPath) {
              env.PATH = loginPath;
            }
            const child = nodeSpawn(spawnOpts.command, spawnOpts.args, {
              cwd: spawnOpts.cwd,
              env,
              stdio: ["pipe", "pipe", "pipe"],
            });
            spawnOpts.signal.addEventListener("abort", () => child.kill(), { once: true });
            return child;
          },
        },
      });

      // Iterate the stream. If not authenticated, the CLI sends "Not logged in"
      // as a text message then exits. If authenticated, we get a normal result.
      for await (const msg of q) {
        if (msg.type === "assistant") {
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text") {
                const text = (block.text || "").toLowerCase();
                if (text.includes("not logged in") || text.includes("/login")) {
                  abortController.abort();
                  return false;
                }
              }
            }
          }
        }
        // result message = query completed (success or error)
        if (msg.type === "result") {
          return msg.subtype === "success";
        }
      }
      return true;
    } catch {
      // If the CLI exits with code 1 (auth failure), the stream throws.
      return false;
    }
  }

  /** Returns the cached binary path, resolving it only on the first call.
   *  Internal — used as an optimization for pathToClaudeCodeExecutable in queries. */
  private getClaudeBinaryPath(): string | undefined {
    if (!this.binaryPathResolved) {
      this.cachedBinaryPath = findClaudeBinary();
      this.binaryPathResolved = true;
    }
    return this.cachedBinaryPath;
  }

  /** Returns a cached MCP server, re-creating only if the provider changed.
   *  Internal — called by SDKConversationImpl to inject tools into queries. */
  private getMcpServer(provider: BusinessContextProvider): ReturnType<typeof createSdkMcpServer> {
    if (this.cachedMcpServer && this.cachedProviderId === provider.id) {
      return this.cachedMcpServer;
    }
    const searchTool = createSearchTool(provider);
    const getThreadTool = createGetThreadTool(provider);
    this.cachedMcpServer = createSdkMcpServer({
      name: "conduit-context",
      tools: [searchTool, getThreadTool],
    });
    this.cachedProviderId = provider.id;
    return this.cachedMcpServer;
  }

  /** Returns a cached system prompt, re-creating only if workspace or provider changed.
   *  Internal — called by SDKConversationImpl for query options. */
  private getSystemPrompt(workspaceName: string, providerName: string): string {
    const key = `${workspaceName}::${providerName}`;
    if (this.cachedSystemPrompt && this.cachedSystemPromptKey === key) {
      return this.cachedSystemPrompt;
    }
    this.cachedSystemPrompt = buildSystemPrompt(workspaceName, providerName);
    this.cachedSystemPromptKey = key;
    return this.cachedSystemPrompt;
  }

  /** Creates a new conversation. The first call to start() begins a fresh session. */
  createConversation(
    options: ConversationOptions,
    onMessage: OnAgentMessage,
  ): AgentConversation {
    return new SDKConversationImpl(options, onMessage, this);
  }

  /** Creates a conversation pre-loaded with an existing session ID.
   *  Used when restoring a past session — the next followUp() will
   *  pass `resume: sessionId` so Claude has the full prior context. */
  createConversationForResume(
    options: ConversationOptions,
    onMessage: OnAgentMessage,
    existingSessionId: string,
  ): AgentConversation {
    return new SDKConversationImpl(options, onMessage, this, existingSessionId);
  }
}

/**
 * The actual conversation implementation. Manages:
 * - An in-process MCP server that exposes business context search tools to Claude
 * - The async message stream from the SDK
 * - Permission request/response flow between Claude and the webview UI
 * - Session tracking for conversation resume
 */
class SDKConversationImpl implements AgentConversation {
  private _isRunning = false;
  /** Set by cancel() so the catch block in sendQuery() knows the abort was
   *  intentional and can suppress the error (not all abort errors have
   *  name === "AbortError" — the CLI subprocess error may be a plain Error). */
  private _cancelled = false;
  private abortController: AbortController | null = null;
  private _sessionId: string | null = null;
  /** Tracks permission requests waiting for the user to click Allow/Deny.
   *  Key is a unique requestId, value holds a Promise resolve function.
   *  When the user responds in the webview, handlePermissionResponse()
   *  resolves the Promise and the SDK continues. */
  private pendingPermissions = new Map<
    string,
    {
      toolUseID: string;
      input: Record<string, unknown>;
      resolve: (result: { behavior: "allow"; updatedInput: Record<string, unknown>; toolUseID: string } | { behavior: "deny"; message: string; toolUseID: string }) => void;
    }
  >();

  constructor(
    private options: ConversationOptions,
    private onMessage: OnAgentMessage,
    /** Parent agent — holds cached MCP server, binary path, and system prompt
     *  so they're resolved once and reused across conversations. */
    private agent: ClaudeSDKAgent,
    existingSessionId?: string,
  ) {
    if (existingSessionId) {
      this._sessionId = existingSessionId;
    }
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  async start(userMessage: string): Promise<void> {
    this._sessionId = null;
    await this.sendQuery(userMessage);
  }

  async followUp(userMessage: string): Promise<void> {
    await this.sendQuery(userMessage);
  }

  cancel(): void {
    this._cancelled = true;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this._isRunning = false;
    // Deny all pending permission requests on cancel
    for (const [id, entry] of this.pendingPermissions) {
      entry.resolve({ behavior: "deny", message: "Operation cancelled", toolUseID: entry.toolUseID });
      this.pendingPermissions.delete(id);
    }
  }

  handlePermissionResponse(requestId: string, behavior: "allow" | "deny"): void {
    const entry = this.pendingPermissions.get(requestId);
    if (!entry) return;
    this.pendingPermissions.delete(requestId);
    if (behavior === "allow") {
      entry.resolve({ behavior: "allow", updatedInput: entry.input, toolUseID: entry.toolUseID });
    } else {
      entry.resolve({ behavior: "deny", message: "User denied permission", toolUseID: entry.toolUseID });
    }
  }

  /** Resolves an AskUserQuestion prompt by injecting the user's answers into
   *  the tool input. The SDK then executes the tool with answers already filled. */
  handleUserQuestionResponse(requestId: string, answers: Record<string, string>): void {
    const entry = this.pendingPermissions.get(requestId);
    if (!entry) return;
    this.pendingPermissions.delete(requestId);
    const updatedInput = { ...entry.input, answers };
    entry.resolve({ behavior: "allow", updatedInput, toolUseID: entry.toolUseID });
  }

  /** Updates the permission mode so the next query/followUp uses it.
   *  Called when the user toggles the permission mode in the UI mid-conversation. */
  setPermissionMode(mode: "default" | "acceptEdits" | "bypassPermissions"): void {
    this.options = { ...this.options, permissionMode: mode };
  }

  /** Resolves a plan review prompt based on the user's chosen action.
   *  "accept" → allow (uses whatever permission mode the user has set globally),
   *  "continue" → deny (keep planning), custom text → deny with feedback. */
  handlePlanReviewResponse(requestId: string, action: string): void {
    const entry = this.pendingPermissions.get(requestId);
    if (!entry) return;
    this.pendingPermissions.delete(requestId);

    if (action === "accept") {
      entry.resolve({ behavior: "allow", updatedInput: entry.input, toolUseID: entry.toolUseID });
    } else if (action === "continue") {
      entry.resolve({ behavior: "deny", message: "Continue refining the plan before proceeding.", toolUseID: entry.toolUseID });
    } else {
      // Custom feedback text from the user
      entry.resolve({ behavior: "deny", message: action, toolUseID: entry.toolUseID });
    }
  }

  /**
   * Core method — sends a message to Claude and streams back the response.
   *
   * The flow:
   * 1. Call `query()` from the SDK, which spawns Claude Code as a subprocess
   * 2. The SDK returns an async generator that yields messages as they arrive
   * 3. We iterate over the stream with `for await` and forward each message
   *    to the webview via onMessage() for live rendering
   *
   * Message types we handle:
   * - "assistant": Claude's response — contains text blocks and tool_use blocks
   * - "user": Tool results being fed back to Claude (we show these as tool output)
   * - "result": Final summary when Claude is done (cost, duration, etc.)
   */
  private async sendQuery(userMessage: string): Promise<void> {
    if (this._isRunning) {
      this.onMessage({ type: "sdk-error", text: "A query is already running." });
      return;
    }

    this._isRunning = true;
    this._cancelled = false;
    this.abortController = new AbortController();

    try {
      // Derive tool names from the provider (e.g. "slack" → "search_slack")
      // so allowedTools stays in sync with whatever mcpTools.ts generates.
      const toolNames = getToolNames(this.options.provider);

      // query() is the main SDK entry point. It spawns Claude Code CLI
      // and returns an async generator we iterate over for streamed responses.
      const q = query({
        prompt: userMessage,
        options: {
          cwd: this.options.workingDirectory,
          // MCP server is always available — the system prompt tells Claude
          // to only use context tools when the user references discussions/people.
          mcpServers: { "conduit-context": this.agent.getMcpServer(this.options.provider) },
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: this.agent.getSystemPrompt(this.options.workspaceName, this.options.provider.displayName),
          },
          // allowedTools bypasses permission checks for these specific tools.
          // Our MCP tools are safe (read-only search), so no need to prompt.
          // Format: "mcp__<server-name>__<tool-name>"
          allowedTools: [
            `mcp__conduit-context__${toolNames.search}`,
            `mcp__conduit-context__${toolNames.getThread}`,
          ],
          abortController: this.abortController,
          permissionMode: this.options.permissionMode ?? "default",
          ...(this.options.permissionMode === "bypassPermissions"
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          // canUseTool: Called by the SDK when Claude wants to use a tool that
          // isn't in allowedTools. We show a permission prompt in the webview
          // and wait for the user to Allow or Deny before continuing.
          ...(this.options.permissionMode !== "bypassPermissions"
            ? {
                canUseTool: async (
                  toolName: string,
                  input: Record<string, unknown>,
                  options: { decisionReason?: string; toolUseID: string }
                ) => {
                  // Emit the tool call to the webview so the user sees it.
                  // We emit HERE instead of the streaming handler so tool calls
                  // appear one at a time — the streaming handler would dump ALL
                  // tool calls at once before any permission prompt is resolved.
                  // Suppressed tools (AskUserQuestion, ExitPlanMode, etc.) have
                  // their own custom UI messages emitted below.
                  const suppressedTools = new Set([
                    "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "Task",
                  ]);
                  if (!suppressedTools.has(toolName)) {
                    this.onMessage({
                      type: "sdk-tool-call",
                      toolName,
                      input: JSON.stringify(input, null, 2),
                      toolCallId: options.toolUseID,
                    });
                  }

                  // AskUserQuestion: render an interactive multiple-choice UI in
                  // the webview instead of the generic Allow/Deny permission prompt.
                  // The user's selections are injected back into the tool input via
                  // `updatedInput.answers`, then the SDK executes the tool normally.
                  // ExitPlanMode: render a plan review UI with accept/reject/feedback
                  // options instead of the generic Allow/Deny permission prompt.
                  if (toolName === "ExitPlanMode") {
                    const requestId = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                    const planText = typeof input.plan === "string" ? input.plan : "";
                    this.onMessage({ type: "plan-review", requestId, planText });
                    const toolUseID = options.toolUseID;
                    return new Promise((resolve) => {
                      this.pendingPermissions.set(requestId, { toolUseID, input, resolve });
                      setTimeout(() => {
                        if (this.pendingPermissions.has(requestId)) {
                          this.pendingPermissions.delete(requestId);
                          resolve({ behavior: "deny", message: "Plan review timed out", toolUseID });
                        }
                      }, 5 * 60 * 1000);
                    });
                  }

                  if (toolName === "AskUserQuestion") {
                    const requestId = `ask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                    const questions = Array.isArray(input.questions) ? input.questions : [];
                    this.onMessage({ type: "user-question", requestId, questions });
                    const toolUseID = options.toolUseID;
                    return new Promise((resolve) => {
                      this.pendingPermissions.set(requestId, { toolUseID, input, resolve });
                      setTimeout(() => {
                        if (this.pendingPermissions.has(requestId)) {
                          this.pendingPermissions.delete(requestId);
                          resolve({ behavior: "deny", message: "Question timed out", toolUseID });
                        }
                      }, 5 * 60 * 1000);
                    });
                  }

                  // All other tools: show the generic permission prompt.
                  const requestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                  this.onMessage({
                    type: "permission-request",
                    requestId,
                    toolName,
                    input: JSON.stringify(input, null, 2),
                    reason: options.decisionReason,
                  });
                  const toolUseID = options.toolUseID;
                  return new Promise((resolve) => {
                    this.pendingPermissions.set(requestId, { toolUseID, input, resolve });
                    setTimeout(() => {
                      if (this.pendingPermissions.has(requestId)) {
                        this.pendingPermissions.delete(requestId);
                        resolve({ behavior: "deny", message: "Permission request timed out", toolUseID });
                      }
                    }, 5 * 60 * 1000);
                  });
                },
              }
            : {}),
          maxTurns: 20,
          // Binary path is cached on the agent — resolved once via execSync.
          ...(this.agent.getClaudeBinaryPath()
            ? { pathToClaudeCodeExecutable: this.agent.getClaudeBinaryPath() }
            : {}),
          // Custom spawn: uses the user's login shell PATH so `node` and
          // `claude` resolve correctly regardless of install method (nvm, brew,
          // cargo, snap, etc.). The extension host's default PATH misses these.
          spawnClaudeCodeProcess: (spawnOpts: {
            command: string;
            args: string[];
            cwd?: string;
            env: Record<string, string | undefined>;
            signal: AbortSignal;
          }) => {
            const loginPath = getLoginShellPath();
            const env = { ...spawnOpts.env };
            if (loginPath) {
              env.PATH = loginPath;
            }
            const child = nodeSpawn(spawnOpts.command, spawnOpts.args, {
              cwd: spawnOpts.cwd,
              env,
              stdio: ["pipe", "pipe", "pipe"],
            });
            spawnOpts.signal.addEventListener("abort", () => child.kill(), { once: true });
            return child;
          },
          ...(this._sessionId ? { resume: this._sessionId } : {}),
        },
      });

      console.log("[Conduit] SDK query() called, streaming messages...");

      // Stream messages from Claude as they arrive.
      // Each `msg` is one step in the conversation — Claude thinking,
      // calling a tool, or delivering the final result.
      for await (const msg of q) {
        console.log("[Conduit] SDK message:", msg.type);
        if (this.abortController?.signal.aborted) break;

        switch (msg.type) {
          // "assistant" = Claude's turn. Contains an array of content blocks:
          // text blocks (Claude's words) and tool_use blocks (Claude calling a tool).
          case "assistant": {
            // Save session_id on first response so we can resume this conversation later
            if (msg.session_id && !this._sessionId) {
              this._sessionId = msg.session_id;
            }

            const { content } = msg.message;
            if (!Array.isArray(content)) break;

            for (const block of content) {
              if (block.type === "text" && block.text) {
                this.onMessage({
                  type: "sdk-text",
                  text: block.text,
                  messageId: msg.uuid ?? "",
                });
              } else if (block.type === "compaction") {
                // Compaction summary — the SDK compacted the conversation context
                // and produced a summary. Show it as a distinct UI block.
                const summary = typeof block.content === "string" ? block.content : "";
                if (summary) {
                  this.onMessage({ type: "sdk-compact-summary", text: summary });
                }
              } else if (block.type === "tool_use") {
                // Tools with custom UI or suppressed output — never emit as
                // generic sdk-tool-call (they have their own messages).
                if (block.name === "AskUserQuestion") break;
                if (block.name === "EnterPlanMode") break;
                if (block.name === "ExitPlanMode") break;

                // Skip Task tool calls — subagents produce their own streamed
                // output (sdk-text, sdk-tool-call, etc.), so the outer Task
                // JSON is noise. The todo list and results are what matter.
                if (block.name === "Task") break;

                // When canUseTool is active (default/acceptEdits), we emit
                // sdk-tool-call from canUseTool so tool calls appear one at a
                // time alongside their permission prompts. Emitting here would
                // show ALL tool calls at once before any permission is resolved.
                // In bypassPermissions mode there's no canUseTool, so emit here.
                if (this.options.permissionMode === "bypassPermissions") {
                  this.onMessage({
                    type: "sdk-tool-call",
                    toolName: block.name,
                    input: JSON.stringify(block.input, null, 2),
                    toolCallId: block.id,
                  });
                }
              }
            }
            break;
          }

          // "user" = Tool results being sent back to Claude. The SDK auto-executes
          // tools and feeds results back. We intercept to show them in the webview.
          case "user": {
            const { content } = msg.message;
            if (!Array.isArray(content)) break;

            for (const block of content) {
              if (block.type === "tool_result") {
                const resultText =
                  typeof block.content === "string"
                    ? block.content
                    : Array.isArray(block.content)
                      ? block.content
                          .filter((c): c is { type: "text"; text: string } => c.type === "text")
                          .map((c) => c.text)
                          .join("\n")
                      : JSON.stringify(block.content);
                this.onMessage({
                  type: "sdk-tool-result",
                  toolCallId: block.tool_use_id ?? "",
                  result:
                    resultText.length > 500
                      ? resultText.slice(0, 500) + "..."
                      : resultText,
                });
              }
            }
            break;
          }

          // "result" = Conversation finished. Contains cost, duration, and
          // a text summary. subtype distinguishes success from error/timeout.
          case "result": {
            if (msg.session_id && !this._sessionId) {
              this._sessionId = msg.session_id;
            }

            // Extract context window usage from modelUsage — pick the first
            // model's data (there's usually only one model per conversation).
            const modelUsages = msg.modelUsage ? Object.values(msg.modelUsage) : [];
            const mu = modelUsages[0];

            const successResult = msg.subtype === "success" ? msg.result : undefined;
            this.onMessage({
              type: "sdk-done",
              cost: msg.total_cost_usd,
              duration: msg.duration_ms,
              result: successResult,
              contextWindow: mu?.contextWindow,
              inputTokens: mu?.inputTokens,
              outputTokens: mu?.outputTokens,
              cacheReadTokens: mu?.cacheReadInputTokens,
              cacheCreationTokens: mu?.cacheCreationInputTokens,
            });
            break;
          }

          // "system" = Internal SDK events (compaction, status changes, init, etc.)
          case "system": {
            if ((msg as any).subtype === "status") {
              const status = (msg as any).status as string | null;
              if (status === "compacting") {
                this.onMessage({ type: "status", text: "Compacting context..." });
              }
            }
            break;
          }
        }
      }
    } catch (err: any) {
      console.error("[Conduit] SDK sendQuery error:", err.name, err.message, err);
      // Suppress errors from intentional cancellation — the CLI subprocess
      // may throw a plain Error (not AbortError) when killed by abort signal.
      if (err.name !== "AbortError" && !this._cancelled) {
        this.onMessage({
          type: "sdk-error",
          text: `SDK error: ${err.message}`,
        });
      }
    } finally {
      this._isRunning = false;
      this.abortController = null;
    }
  }
}
