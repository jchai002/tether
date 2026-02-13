/**
 * State types for the webview React app.
 *
 * AppState is the single source of truth for the entire webview UI.
 * It replaces the old scattered state across vanilla TS components
 * (ChatState.busy, InputArea.inConversation, SessionList.visible, etc.)
 *
 * MessageItem is a discriminated union of everything that can appear
 * in the message list — chat messages, tool calls, permission prompts,
 * and todo lists. React components switch on `item.kind` to render
 * the right UI for each type.
 */
import type { PermissionModeValue, SessionMeta } from "../types";

/** A regular chat message (user input, Claude response, errors, etc.) */
export interface ChatMessage {
  id: string;
  kind: "chat-message";
  role: "user" | "assistant" | "error" | "info" | "log" | "agent";
  text: string;
}

/** A tool call from Claude (Edit, Read, Bash, etc.) with its result */
export interface ToolCall {
  id: string;
  kind: "tool-call";
  toolCallId: string;
  toolName: string;
  input: string;
  result?: string;
}

/** A permission request waiting for user to Allow/Deny */
export interface PermissionRequestItem {
  id: string;
  kind: "permission-request";
  requestId: string;
  toolName: string;
  input: string;
  reason?: string;
  resolved?: "allow" | "deny";
}

/** A single item in the TodoWrite checklist */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

/** The full TodoWrite list (updated in place when new TodoWrite calls arrive) */
export interface TodoListItem {
  id: string;
  kind: "todo-list";
  toolCallId: string;
  todos: TodoItem[];
}

/** An AskUserQuestion prompt — Claude wants the user to pick from options.
 *  Rendered as clickable option cards with a custom text input at the bottom.
 *  Once answered, `answers` is set and the UI shows the resolved state. */
export interface UserQuestionItem {
  id: string;
  kind: "user-question";
  requestId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
  /** Maps question header → selected option label(s) or custom text.
   *  Set when the user submits their answers. */
  answers?: Record<string, string>;
}

/** A plan review prompt — Claude finished planning and wants user to
 *  accept (with auto or manual approval), continue planning, or provide
 *  custom feedback. Rendered as option cards via UserResponsePanel. */
export interface PlanReviewItem {
  id: string;
  kind: "plan-review";
  requestId: string;
  /** The plan text from ExitPlanMode (markdown) */
  planText: string;
  /** Set when the user makes a choice (e.g., "accept-auto", "accept-manual",
   *  "continue", or custom feedback text). */
  response?: string;
}

/** Everything that can appear in the message list */
export type MessageItem = ChatMessage | ToolCall | PermissionRequestItem | TodoListItem | UserQuestionItem | PlanReviewItem;

/** The complete webview state — managed by useReducer in the Context provider */
export interface AppState {
  busy: boolean;
  statusText: string;
  showWelcome: boolean;
  showSessionList: boolean;
  inConversation: boolean;
  permissionMode: PermissionModeValue;
  messages: MessageItem[];
  sessions: SessionMeta[];
  /** Tracks whether the Claude CLI is ready for use.
   *  null = not yet checked (initial state), object = check completed.
   *  We use null to avoid flashing the setup screen before the check runs. */
  setupStatus: { cliInstalled: boolean; cliAuthenticated: boolean } | null;
  /** Tracks Slack connection status.
   *  null = not yet checked, object = check completed. */
  slackStatus: { connected: boolean; workspaceName?: string } | null;
}

export const initialState: AppState = {
  busy: false,
  statusText: "",
  showWelcome: true,
  showSessionList: false,
  inConversation: false,
  permissionMode: "default",
  messages: [],
  sessions: [],
  setupStatus: null,
  slackStatus: null,
};

/**
 * Reducer actions — discriminated union.
 *
 * ext/* actions come from extension messages (mapped by useExtensionMessage hook).
 * ui/* actions come from user interactions within the webview.
 */
export type Action =
  // From extension messages
  | { type: "ext/progress"; text: string }
  | { type: "ext/status"; text: string }
  | { type: "ext/assistant"; text: string }
  | { type: "ext/error"; text: string }
  | { type: "ext/info"; text: string }
  | { type: "ext/log"; text: string }
  | { type: "ext/agent"; text: string }
  | { type: "ext/agent-error"; text: string }
  | { type: "ext/done"; text: string }
  | { type: "ext/sdk-text"; text: string; messageId: string }
  | { type: "ext/sdk-tool-call"; toolName: string; input: string; toolCallId: string }
  | { type: "ext/sdk-tool-result"; toolCallId: string; result: string }
  | { type: "ext/sdk-done"; cost?: number; duration?: number; result?: string }
  | { type: "ext/sdk-error"; text: string }
  | { type: "ext/permission-request"; requestId: string; toolName: string; input: string; reason?: string }
  | { type: "ext/user-question"; requestId: string; questions: UserQuestionItem["questions"] }
  | { type: "ext/plan-review"; requestId: string; planText: string }
  | { type: "ext/permission-mode"; mode: PermissionModeValue }
  | { type: "ext/setup-status"; cliInstalled: boolean; cliAuthenticated: boolean }
  | { type: "ext/slack-status"; connected: boolean; workspaceName?: string }
  | { type: "ext/session-list"; sessions: SessionMeta[] }
  | { type: "ext/session-opened"; messages: Array<
      | { role: "user"; text: string }
      | { role: "assistant"; text: string }
      | { role: "tool-call"; text: string; toolName: string; toolCallId: string }
      | { role: "tool-result"; text: string; toolCallId: string }
      | { role: "info"; text: string }
      | { role: "error"; text: string }
    > }
  | { type: "ext/session-cleared" }
  // From webview UI interactions
  | { type: "ui/add-user-message"; text: string }
  | { type: "ui/set-busy"; busy: boolean }
  | { type: "ui/toggle-session-list" }
  | { type: "ui/hide-session-list" }
  | { type: "ui/resolve-permission"; requestId: string; behavior: "allow" | "deny" }
  | { type: "ui/answer-question"; requestId: string; answers: Record<string, string> }
  | { type: "ui/plan-response"; requestId: string; response: string };
