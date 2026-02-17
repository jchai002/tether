/**
 * ConversationalAgent — interface for multi-turn, streaming coding agents.
 *
 * This is the SDK-path counterpart to CodingAgent (the pipeline path).
 * While CodingAgent handles one-shot "send prompt, get result" interactions,
 * ConversationalAgent handles rich, multi-turn conversations with:
 * - Live streaming of text, tool calls, and tool results
 * - Permission prompts (Allow/Deny before running commands)
 * - User questions (AskUserQuestion multi-choice prompts)
 * - Plan reviews (ExitPlanMode approval flow)
 * - Session persistence and resume
 *
 * Each implementation wraps a specific agent's SDK or CLI (Claude, Codex, etc.)
 * and translates its streaming events into Conduit's ExtensionToWebviewMessage
 * protocol so chatPanel.ts stays agent-agnostic.
 *
 * Implementations live in providers/agents/<name>/ alongside CodingAgent impls.
 * Adding a new conversational agent requires exactly 3 changes:
 * 1. Create adapter in providers/agents/<name>/
 * 2. Register in extension.ts activate()
 * 3. Add to package.json config enum
 */
import type { BusinessContextProvider } from "./businessContextProvider";
import type { ExtensionToWebviewMessage, PermissionModeValue } from "../chat/messages";

/** Options for creating a conversation. Agent-agnostic — contains
 *  everything an agent needs to start, regardless of which SDK it wraps. */
export interface ConversationOptions {
  provider: BusinessContextProvider;
  workspaceName: string;
  workingDirectory: string;
  permissionMode?: PermissionModeValue;
}

/**
 * Represents an active multi-turn conversation with an AI agent.
 * Created by ConversationalAgent.createConversation().
 *
 * The conversation manages its own internal state (message history,
 * pending tool calls, etc.). chatPanel only interacts through this
 * interface — it never touches SDK-specific internals.
 */
export interface AgentConversation {
  /** Start a new conversation with the given user message. */
  start(userMessage: string): Promise<void>;
  /** Continue an existing conversation. The agent maintains history internally. */
  followUp(userMessage: string): Promise<void>;
  /** Abort the current request. Safe to call multiple times. */
  cancel(): void;
  /** Respond to a permission prompt (Allow/Deny). */
  handlePermissionResponse(requestId: string, behavior: "allow" | "deny"): void;
  /** Respond to an AskUserQuestion prompt with the user's selections. */
  handleUserQuestionResponse(requestId: string, answers: Record<string, string>): void;
  /** Respond to a plan review prompt (accept/continue/custom feedback). */
  handlePlanReviewResponse(requestId: string, action: string): void;
  /** Update permission mode mid-conversation. */
  setPermissionMode(mode: PermissionModeValue): void;
  /** Whether a query is currently in flight. */
  readonly isRunning: boolean;
  /** The agent-assigned session ID. Null until the first response arrives.
   *  Used for session persistence and conversation resume. */
  readonly sessionId: string | null;
}

/** Setup information for agent-specific install/auth guidance.
 *  Returned by getSetupInfo() so the webview can render instructions
 *  without knowing which specific agent is active. */
export interface AgentSetupInfo {
  /** Human-readable agent name for the setup screen title (e.g. "Claude Code"). */
  displayName: string;
  /** Install command shown to the user (e.g. "npm install -g @anthropic-ai/claude-code"). */
  installCommand: string;
  /** CLI binary name used in instructions (e.g. "claude", "codex"). */
  cliBinaryName: string;
}

/** A streaming callback that receives messages to forward to the webview.
 *  The agent adapter translates its SDK-specific events into these messages. */
export type OnAgentMessage = (msg: ExtensionToWebviewMessage) => void;

/**
 * Interface for any AI coding agent that supports multi-turn conversations
 * with streaming, MCP tool access, and permission handling.
 *
 * How the agent consumes MCP tools is an implementation detail — the interface
 * just provides a BusinessContextProvider in ConversationOptions. The Claude
 * adapter creates an in-process MCP server; a future Codex adapter might
 * pass an MCP server URL. chatPanel doesn't need to know.
 */
export interface ConversationalAgent {
  readonly id: string;
  readonly displayName: string;

  /** Check if the agent's CLI/binary is installed and reachable. */
  isAvailable(): Promise<boolean>;
  /** Check if the agent's CLI is authenticated (has valid credentials). */
  isAuthenticated(): Promise<boolean>;
  /** Check if an error message indicates an authentication failure.
   *  Each agent knows its own auth error patterns (e.g. "not logged in"
   *  for Claude, "not authenticated" for Codex). Used as a runtime
   *  fallback to show the setup screen when credentials expire mid-session. */
  isAuthError(text: string): boolean;
  /** Agent-specific setup instructions for the webview setup screen. */
  getSetupInfo(): AgentSetupInfo;
  /** The CLI command to run for auth/setup (e.g. "claude", "codex --auth").
   *  Used when opening a terminal for the user. */
  getSetupCommand(): string;
  /** Reset any cached binary/path state. Called when user clicks "Check Again"
   *  so the next isAvailable() check picks up a freshly installed CLI. */
  resetCache(): void;

  /** Create a new conversation. Messages stream via the onMessage callback. */
  createConversation(
    options: ConversationOptions,
    onMessage: OnAgentMessage,
  ): AgentConversation;

  /** Create a conversation pre-loaded with an existing session ID for resume.
   *  The agent picks up with full prior context from the session. */
  createConversationForResume(
    options: ConversationOptions,
    onMessage: OnAgentMessage,
    existingSessionId: string,
  ): AgentConversation;
}
