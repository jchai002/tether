/**
 * React Context for the entire webview state.
 *
 * This replaces the old vanilla TS approach where state was scattered across
 * ChatState (event emitter), InputArea.inConversation, SessionList.visible, etc.
 *
 * Architecture:
 * - AppState holds all UI state in one place
 * - useReducer processes actions (both from extension messages and UI events)
 * - The provider wraps the whole app so any component can read state or dispatch
 * - postToExtension is also provided via context so components can send messages
 *
 * The reducer is the React equivalent of the old switch(msg.type) in main.ts.
 * Each ExtensionToWebviewMessage type maps to an ext/* action.
 */
import { createContext, useContext, useReducer, useCallback, type ReactNode } from "react";
import type {
  AppState,
  Action,
  MessageItem,
  ChatMessage,
  PermissionRequestItem,
  UserQuestionItem,
  PlanReviewItem,
} from "./types";
import { initialState } from "./types";
import type { WebviewToExtensionMessage } from "../types";

// ─── Helpers ────────────────────────────────────────────────

let nextId = 0;
function uid(): string {
  return `msg_${Date.now()}_${nextId++}`;
}

/** Create a ChatMessage item for the message list */
function chatMsg(role: ChatMessage["role"], text: string): ChatMessage {
  return { id: uid(), kind: "chat-message", role, text };
}

/** Creates the appropriate MessageItem for a tool call based on toolName.
 *  Known tools (TodoWrite, AskUserQuestion) get specialized items with custom
 *  renderers. Everything else falls through to a generic ToolCall.
 *
 *  Used by BOTH live sdk-tool-call handling AND session restoration so the
 *  rendering logic stays in one place. */
function toolCallToItem(toolName: string, input: string, toolCallId: string): MessageItem {
  if (toolName === "TodoWrite") {
    try {
      const data = JSON.parse(input);
      if (data.todos && Array.isArray(data.todos)) {
        return { id: uid(), kind: "todo-list", toolCallId, todos: data.todos };
      }
    } catch { /* fall through to generic */ }
  }
  if (toolName === "ExitPlanMode") {
    // Plan review — stored with planText as the text field
    return { id: uid(), kind: "plan-review", requestId: toolCallId, planText: input };
  }
  if (toolName === "AskUserQuestion") {
    try {
      const data = JSON.parse(input);
      // New format: stored as JSON.stringify(questions) → bare array
      // Old format: stored as the full tool input → { questions: [...] }
      const questions = Array.isArray(data) ? data : data?.questions;
      if (Array.isArray(questions)) {
        // Don't pre-set answers here — the tool-result matching in
        // ext/session-opened will fill in the real answers if stored.
        // After the loop, any unanswered questions get a fallback.
        return { id: uid(), kind: "user-question", requestId: toolCallId, questions };
      }
    } catch { /* fall through to generic */ }
  }
  return { id: uid(), kind: "tool-call", toolCallId, toolName, input };
}

// ─── Reducer ────────────────────────────────────────────────

export function appReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    // ── Pipeline path messages ──

    case "ext/progress":
      return { ...state, statusText: action.text };

    case "ext/status":
      return {
        ...state,
        statusText: action.text,
        busy: action.text ? state.busy : false,
      };

    case "ext/assistant":
    case "ext/error":
    case "ext/info":
    case "ext/log": {
      const roleMap = {
        "ext/assistant": "assistant",
        "ext/error": "error",
        "ext/info": "info",
        "ext/log": "log",
      } as const;
      return {
        ...state,
        showWelcome: false,
        messages: [...state.messages, chatMsg(roleMap[action.type], action.text)],
      };
    }

    case "ext/agent":
      return {
        ...state,
        showWelcome: false,
        messages: [...state.messages, chatMsg("agent", action.text)],
      };

    case "ext/agent-error":
      return {
        ...state,
        showWelcome: false,
        messages: [...state.messages, chatMsg("error", "[stderr] " + action.text)],
      };

    case "ext/done":
      return {
        ...state,
        showWelcome: false,
        busy: false,
        messages: [...state.messages, chatMsg("info", action.text)],
      };

    // ── SDK path messages ──

    case "ext/sdk-text":
      return {
        ...state,
        showWelcome: false,
        inConversation: true,
        statusText: "", // Clear compaction or other status — Claude is responding
        messages: [...state.messages, chatMsg("assistant", action.text)],
      };

    case "ext/sdk-tool-call": {
      const item = toolCallToItem(action.toolName, action.input, action.toolCallId);
      return {
        ...state,
        showWelcome: false,
        statusText: "", // Clear compaction or other status — Claude is responding
        messages: [...state.messages, item],
      };
    }

    case "ext/sdk-tool-result": {
      // Find the matching tool call and set its result
      const updated = state.messages.map((item) => {
        if (item.kind === "tool-call" && item.toolCallId === action.toolCallId) {
          return { ...item, result: action.result };
        }
        return item;
      });
      return { ...state, messages: updated };
    }

    case "ext/sdk-done":
      return {
        ...state,
        busy: false,
        // Update context usage if the result includes token data
        contextUsage: action.contextWindow ? {
          contextWindow: action.contextWindow,
          inputTokens: action.inputTokens ?? 0,
          outputTokens: action.outputTokens ?? 0,
          cacheReadTokens: action.cacheReadTokens ?? 0,
          cacheCreationTokens: action.cacheCreationTokens ?? 0,
        } : state.contextUsage,
      };

    case "ext/sdk-compact-summary":
      return {
        ...state,
        showWelcome: false,
        statusText: "", // Clear "Compacting context..." — compaction is done
        messages: [...state.messages, {
          id: uid(), kind: "compact-summary" as const, text: action.text,
        }],
      };

    case "ext/sdk-error":
      return {
        ...state,
        showWelcome: false,
        busy: false,
        messages: [...state.messages, chatMsg("error", action.text)],
      };

    // ── Permission messages ──

    case "ext/permission-request": {
      const perm: PermissionRequestItem = {
        id: uid(),
        kind: "permission-request",
        requestId: action.requestId,
        toolName: action.toolName,
        input: action.input,
        reason: action.reason,
      };
      return {
        ...state,
        showWelcome: false,
        messages: [...state.messages, perm],
      };
    }

    case "ext/user-question": {
      const question: UserQuestionItem = {
        id: uid(),
        kind: "user-question",
        requestId: action.requestId,
        questions: action.questions,
      };
      return {
        ...state,
        showWelcome: false,
        messages: [...state.messages, question],
      };
    }

    case "ext/plan-review": {
      const plan: PlanReviewItem = {
        id: uid(),
        kind: "plan-review",
        requestId: action.requestId,
        planText: action.planText,
      };
      return {
        ...state,
        showWelcome: false,
        messages: [...state.messages, plan],
      };
    }

    case "ext/permission-mode":
      return { ...state, permissionMode: action.mode };

    // ── Setup status ──

    case "ext/setup-status":
      return {
        ...state,
        setupStatus: {
          cliInstalled: action.cliInstalled,
          cliAuthenticated: action.cliAuthenticated,
          setupInfo: action.setupInfo,
        },
      };

    case "ext/slack-status":
      return {
        ...state,
        slackStatus: {
          connected: action.connected,
          workspaceName: action.workspaceName,
        },
      };

    // ── Session messages ──

    case "ext/session-list":
      return { ...state, sessions: action.sessions };

    case "ext/session-opened": {
      // Convert stored messages to MessageItems for rendering
      const items: MessageItem[] = [];
      for (const m of action.messages) {
        switch (m.role) {
          case "user":
          case "assistant":
          case "info":
          case "error":
            items.push(chatMsg(m.role, m.text));
            break;
          case "tool-call":
            items.push(toolCallToItem(m.toolName, m.text, m.toolCallId));
            break;
          case "tool-result": {
            // Find the matching tool call, user-question, or plan-review and attach the result
            const match = items.find(
              (i) =>
                (i.kind === "tool-call" && i.toolCallId === m.toolCallId) ||
                (i.kind === "user-question" && i.requestId === m.toolCallId) ||
                (i.kind === "plan-review" && i.requestId === m.toolCallId)
            );
            if (match?.kind === "tool-call") {
              match.result = m.text;
            } else if (match?.kind === "user-question") {
              try {
                match.answers = JSON.parse(m.text);
              } catch {
                match.answers = { _restored: "true" };
              }
            } else if (match?.kind === "plan-review") {
              match.response = m.text;
            }
            break;
          }
        }
      }
      // Items without stored answers (old sessions before persistence) —
      // mark as resolved so they render dimmed instead of showing buttons.
      for (const item of items) {
        if (item.kind === "user-question" && !item.answers) {
          item.answers = { _restored: "true" };
        }
        if (item.kind === "plan-review" && !item.response) {
          item.response = "_restored";
        }
      }
      return {
        ...state,
        showWelcome: false,
        showSessionList: false,
        inConversation: true,
        currentSessionTitle: action.title,
        messages: items,
      };
    }

    case "ext/session-cleared":
      return {
        ...state,
        showWelcome: true,
        showSessionList: false,
        inConversation: false,
        currentSessionTitle: "",
        contextUsage: null,
        messages: [],
      };

    // ── UI actions ──

    case "ui/add-user-message":
      return {
        ...state,
        showWelcome: false,
        showSessionList: false,
        busy: true,
        // Set the session title from the first user message (same as sessionStore)
        currentSessionTitle: state.currentSessionTitle || action.text.slice(0, 80),
        messages: [...state.messages, chatMsg("user", action.text)],
      };

    case "ui/set-busy":
      return { ...state, busy: action.busy };

    case "ui/toggle-session-list":
      return { ...state, showSessionList: !state.showSessionList };

    case "ui/hide-session-list":
      return { ...state, showSessionList: false };

    case "ui/resolve-permission": {
      const resolved = state.messages.map((item) => {
        if (
          item.kind === "permission-request" &&
          item.requestId === action.requestId
        ) {
          return { ...item, resolved: action.behavior };
        }
        return item;
      });
      return { ...state, messages: resolved };
    }

    case "ui/answer-question": {
      const answered = state.messages.map((item) => {
        if (item.kind === "user-question" && item.requestId === action.requestId) {
          return { ...item, answers: action.answers };
        }
        return item;
      });
      return { ...state, messages: answered };
    }

    case "ui/plan-response": {
      const planResolved = state.messages.map((item) => {
        if (item.kind === "plan-review" && item.requestId === action.requestId) {
          return { ...item, response: action.response };
        }
        return item;
      });
      return { ...state, messages: planResolved };
    }

    default:
      return state;
  }
}

// ─── Context ────────────────────────────────────────────────

interface ExtensionStateContextValue {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  postToExtension: (msg: WebviewToExtensionMessage) => void;
}

const ExtensionStateContext = createContext<ExtensionStateContextValue | null>(null);

interface ProviderProps {
  vscodeApi: { postMessage(msg: unknown): void };
  children: ReactNode;
}

/** Wraps the app with state management and the VS Code API handle */
export function ExtensionStateProvider({ vscodeApi, children }: ProviderProps) {
  const [state, dispatch] = useReducer(appReducer, initialState);

  // useCallback keeps the reference stable across re-renders so hooks that
  // depend on postToExtension (like useExtensionMessage) don't re-fire.
  const postToExtension = useCallback(
    (msg: WebviewToExtensionMessage) => { vscodeApi.postMessage(msg); },
    [vscodeApi]
  );

  return (
    <ExtensionStateContext.Provider value={{ state, dispatch, postToExtension }}>
      {children}
    </ExtensionStateContext.Provider>
  );
}

/** Hook to access state, dispatch, and postToExtension from any component */
export function useExtensionState() {
  const ctx = useContext(ExtensionStateContext);
  if (!ctx) {
    throw new Error("useExtensionState must be used within ExtensionStateProvider");
  }
  return ctx;
}
