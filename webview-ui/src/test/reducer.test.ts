/**
 * Tests for the appReducer — the core state management logic.
 *
 * Tests cover all action types: ext/* (from extension messages),
 * ui/* (from webview interactions), and edge cases like TodoWrite
 * update-in-place and session opening with mixed message types.
 */
import { describe, it, expect } from "vitest";
import { appReducer } from "../context/ExtensionStateContext";
import { initialState } from "../context/types";
import type { AppState, Action } from "../context/types";

/** Helper: dispatch a sequence of actions */
function reduce(actions: Action[], start: AppState = initialState): AppState {
  return actions.reduce(appReducer, start);
}

describe("appReducer", () => {
  // ── General messages ──

  it("ext/status updates statusText and clears busy when text is empty", () => {
    const busy = { ...initialState, busy: true };
    const state = appReducer(busy, { type: "ext/status", text: "" });
    expect(state.busy).toBe(false);
    expect(state.statusText).toBe("");
  });

  it("ext/status keeps busy when text is non-empty", () => {
    const busy = { ...initialState, busy: true };
    const state = appReducer(busy, { type: "ext/status", text: "Processing..." });
    expect(state.busy).toBe(true);
  });

  it("ext/error adds error message", () => {
    const state = appReducer(initialState, { type: "ext/error", text: "Something broke" });
    expect(state.messages[0]).toMatchObject({ kind: "chat-message", role: "error" });
  });

  it("ext/info adds info message", () => {
    const state = appReducer(initialState, { type: "ext/info", text: "FYI" });
    expect(state.messages[0]).toMatchObject({ kind: "chat-message", role: "info" });
  });

  // ── Conversational agent messages ──

  it("ext/sdk-text adds assistant message and sets inConversation", () => {
    const state = appReducer(initialState, { type: "ext/sdk-text", text: "Hi", messageId: "m1" });
    expect(state.inConversation).toBe(true);
    expect(state.messages[0]).toMatchObject({ kind: "chat-message", role: "assistant" });
  });

  it("ext/sdk-tool-call adds tool call", () => {
    const state = appReducer(initialState, {
      type: "ext/sdk-tool-call",
      toolName: "Read",
      input: '{"file_path": "/foo"}',
      toolCallId: "tc1",
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      kind: "tool-call",
      toolName: "Read",
      toolCallId: "tc1",
    });
  });

  it("ext/sdk-tool-result updates matching tool call", () => {
    const withCall = appReducer(initialState, {
      type: "ext/sdk-tool-call",
      toolName: "Bash",
      input: '{"command":"ls"}',
      toolCallId: "tc2",
    });
    const state = appReducer(withCall, {
      type: "ext/sdk-tool-result",
      toolCallId: "tc2",
      result: "file1.ts\nfile2.ts",
    });
    const call = state.messages[0];
    expect(call.kind).toBe("tool-call");
    if (call.kind === "tool-call") {
      expect(call.result).toBe("file1.ts\nfile2.ts");
    }
  });

  it("ext/sdk-done clears busy", () => {
    const busy = { ...initialState, busy: true };
    const state = appReducer(busy, { type: "ext/sdk-done" });
    expect(state.busy).toBe(false);
  });

  it("ext/sdk-error adds error message and clears busy", () => {
    const busy = { ...initialState, busy: true };
    const state = appReducer(busy, { type: "ext/sdk-error", text: "SDK failed" });
    expect(state.busy).toBe(false);
    expect(state.messages[0]).toMatchObject({ kind: "chat-message", role: "error" });
  });

  // ── Permission messages ──

  it("ext/permission-request adds permission request item", () => {
    const state = appReducer(initialState, {
      type: "ext/permission-request",
      requestId: "pr1",
      toolName: "Bash",
      input: '{"command":"rm -rf"}',
      reason: "Dangerous command",
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      kind: "permission-request",
      toolName: "Bash",
      reason: "Dangerous command",
    });
  });

  it("ext/permission-mode updates permission mode", () => {
    const state = appReducer(initialState, { type: "ext/permission-mode", mode: "bypassPermissions" });
    expect(state.permissionMode).toBe("bypassPermissions");
  });

  // ── Session messages ──

  it("ext/session-list updates sessions", () => {
    const sessions = [{ sessionId: "s1", title: "Chat 1", updatedAt: Date.now(), messageCount: 5 }];
    const state = appReducer(initialState, { type: "ext/session-list", sessions });
    expect(state.sessions).toEqual(sessions);
  });

  it("ext/session-opened converts stored messages to MessageItems", () => {
    const state = appReducer(initialState, {
      type: "ext/session-opened",
      title: "Hello",
      messages: [
        { role: "user", text: "Hello" },
        { role: "assistant", text: "Hi there" },
        { role: "tool-call", text: '{"command":"ls"}', toolName: "Bash", toolCallId: "tc1" },
        { role: "tool-result", text: "file1.ts", toolCallId: "tc1" },
      ],
    });
    expect(state.messages).toHaveLength(3); // user, assistant, tool-call (result merged)
    expect(state.showSessionList).toBe(false);
    expect(state.inConversation).toBe(true);
    expect(state.currentSessionTitle).toBe("Hello");
    // Tool call should have its result
    const tc = state.messages[2];
    if (tc.kind === "tool-call") {
      expect(tc.result).toBe("file1.ts");
    }
  });

  it("ext/session-cleared resets to welcome state", () => {
    const active = { ...initialState, showWelcome: false, inConversation: true, messages: [{ id: "x", kind: "chat-message" as const, role: "user" as const, text: "hi" }] };
    const state = appReducer(active, { type: "ext/session-cleared" });
    expect(state.showWelcome).toBe(true);
    expect(state.inConversation).toBe(false);
    expect(state.messages).toHaveLength(0);
  });

  // ── UI actions ──

  it("ui/add-user-message adds user message and sets busy", () => {
    const state = appReducer(initialState, { type: "ui/add-user-message", text: "Do something" });
    expect(state.busy).toBe(true);
    expect(state.showWelcome).toBe(false);
    expect(state.messages[0]).toMatchObject({ kind: "chat-message", role: "user", text: "Do something" });
  });

  it("ui/toggle-session-list toggles the flag", () => {
    const state1 = appReducer(initialState, { type: "ui/toggle-session-list" });
    expect(state1.showSessionList).toBe(true);
    const state2 = appReducer(state1, { type: "ui/toggle-session-list" });
    expect(state2.showSessionList).toBe(false);
  });

  it("ui/resolve-permission marks permission as resolved", () => {
    const withPerm = appReducer(initialState, {
      type: "ext/permission-request",
      requestId: "pr1",
      toolName: "Write",
      input: "{}",
    });
    const state = appReducer(withPerm, {
      type: "ui/resolve-permission",
      requestId: "pr1",
      behavior: "allow",
    });
    const perm = state.messages[0];
    if (perm.kind === "permission-request") {
      expect(perm.resolved).toBe("allow");
    }
  });

  // ── TodoWrite special handling ──

  it("TodoWrite creates a new todo list item", () => {
    const state = appReducer(initialState, {
      type: "ext/sdk-tool-call",
      toolName: "TodoWrite",
      input: JSON.stringify({ todos: [{ content: "Task 1", status: "pending" }] }),
      toolCallId: "tw1",
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].kind).toBe("todo-list");
  });

  it("TodoWrite updates existing todo list in place", () => {
    const withTodo = appReducer(initialState, {
      type: "ext/sdk-tool-call",
      toolName: "TodoWrite",
      input: JSON.stringify({ todos: [{ content: "Task 1", status: "pending" }] }),
      toolCallId: "tw1",
    });
    const state = appReducer(withTodo, {
      type: "ext/sdk-tool-call",
      toolName: "TodoWrite",
      input: JSON.stringify({ todos: [
        { content: "Task 1", status: "completed" },
        { content: "Task 2", status: "in_progress" },
      ] }),
      toolCallId: "tw2",
    });
    // Still only one todo-list item — updated in place
    expect(state.messages).toHaveLength(1);
    const todo = state.messages[0];
    if (todo.kind === "todo-list") {
      expect(todo.todos).toHaveLength(2);
      expect(todo.todos[0].status).toBe("completed");
    }
  });

  it("TodoWrite with invalid JSON falls back to regular tool call", () => {
    const state = appReducer(initialState, {
      type: "ext/sdk-tool-call",
      toolName: "TodoWrite",
      input: "not json",
      toolCallId: "tw3",
    });
    expect(state.messages[0].kind).toBe("tool-call");
  });

  // ── Unknown action ──

  it("returns state unchanged for unknown action", () => {
    const state = appReducer(initialState, { type: "unknown-action" } as any);
    expect(state).toBe(initialState);
  });
});
