/**
 * Message protocol between the extension host and the webview.
 *
 * Since VS Code webviews are sandboxed iframes, the ONLY way to communicate
 * is via postMessage(). This file defines every message type that can be sent
 * in both directions. Both sides import from here for compile-time safety.
 *
 * The types are discriminated unions — TypeScript narrows the type based on
 * the `type` field, so a `switch (msg.type)` gives you full type safety
 * on the fields available in each case.
 */

import type { SessionMeta, StoredMessage } from "./sessionStore";
import type { ModelOption } from "../providers/codingAgent";
// Re-export so the webview can access it via @shared/messages
export type { ModelOption };

export type PermissionModeValue = "default" | "acceptEdits" | "bypassPermissions";

/** A single option in an AskUserQuestion prompt (label + description). */
export interface UserQuestionOption {
  label: string;
  description: string;
}

/** A single question within an AskUserQuestion tool call.
 *  Claude can ask 1–4 questions at once, each with its own header and options. */
export interface UserQuestionData {
  question: string;
  header: string;
  options: UserQuestionOption[];
  multiSelect: boolean;
}

/** Messages sent FROM the webview TO the extension host (user actions). */
export type WebviewToExtensionMessage =
  | { type: "webview-ready" }
  | { type: "query"; text: string }
  | { type: "followup"; text: string }
  | { type: "cancel" }
  | { type: "permission-response"; requestId: string; behavior: "allow" | "deny" }
  // AskUserQuestion — user selected options or typed custom text
  | { type: "user-question-response"; requestId: string; answers: Record<string, string> }
  // Plan review — user accepted, rejected, or gave feedback on a plan
  | { type: "plan-review-response"; requestId: string; action: string }
  | { type: "set-permission-mode"; mode: PermissionModeValue }
  // Setup detection — user clicked "Check Again" or "Open Terminal" on setup screen
  | { type: "check-setup" }
  | { type: "open-setup-terminal" }
  // Provider connection — user clicked "Connect" or "Disconnect" for Slack
  | { type: "check-slack-connection" }
  | { type: "connect-slack" }
  | { type: "disconnect-slack" }
  // Session management
  | { type: "load-session-list" }
  | { type: "open-session"; sessionId: string }
  | { type: "new-conversation" }
  | { type: "delete-session"; sessionId: string }
  // Model switching — user picked a model via /model slash command
  | { type: "set-model"; modelId: string };

/** Messages sent FROM the extension host TO the webview (data & events). */
export type ExtensionToWebviewMessage =
  // General messages (used by chatPanel for status, errors, and info)
  | { type: "status"; text: string }
  | { type: "error"; text: string }
  | { type: "info"; text: string }
  // Conversational agent messages (streamed from agent conversation)
  | { type: "sdk-text"; text: string; messageId: string }
  | { type: "sdk-tool-call"; toolName: string; input: string; toolCallId: string }
  | { type: "sdk-tool-result"; toolCallId: string; result: string }
  | { type: "sdk-done"; cost?: number; duration?: number; result?: string;
      contextWindow?: number; inputTokens?: number; outputTokens?: number;
      cacheReadTokens?: number; cacheCreationTokens?: number }
  | { type: "sdk-error"; text: string }
  // Typed auth failure — the SDK reported authentication_failed on an
  // assistant message or auth_status event (no brittle text matching needed)
  | { type: "sdk-auth-error" }
  // Compaction summary — shown when the SDK compacts the conversation context
  | { type: "sdk-compact-summary"; text: string }
  // Permission prompt
  | { type: "permission-request"; requestId: string; toolName: string; input: string; reason?: string }
  // AskUserQuestion — Claude wants the user to pick from options or type custom text
  | { type: "user-question"; requestId: string; questions: UserQuestionData[] }
  // Plan review — Claude finished planning and wants user to accept/reject/give feedback
  | { type: "plan-review"; requestId: string; planText: string }
  // Permission mode sync
  | { type: "permission-mode"; mode: PermissionModeValue }
  // Setup status — sent on webview-ready and when user clicks "Check Again".
  // Tells the webview whether the Claude CLI is installed and authenticated
  // so it can show the setup screen or transition to the normal chat experience.
  | { type: "setup-status"; cliInstalled: boolean; cliAuthenticated: boolean;
      setupInfo?: { displayName: string; installCommand: string; cliBinaryName: string } }
  // Provider connection status — sent on webview-ready and when connection state changes
  | { type: "slack-status"; connected: boolean; workspaceName?: string }
  // Session management
  | { type: "session-list"; sessions: SessionMeta[] }
  | { type: "session-opened"; meta: SessionMeta; messages: StoredMessage[] }
  | { type: "session-cleared" }
  // Model status — sent on webview-ready and after model changes
  | { type: "model-status"; currentModel: string | null; availableModels: ModelOption[] };
