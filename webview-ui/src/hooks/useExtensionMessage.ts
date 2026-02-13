/**
 * Hook that listens for postMessage events from the extension host
 * and dispatches them as actions to the state reducer.
 *
 * This is the React equivalent of the old main.ts switch(msg.type) block.
 * It maps each ExtensionToWebviewMessage type to a corresponding ext/* action.
 *
 * Call this once in App.tsx — it registers a window event listener on mount
 * and cleans it up on unmount.
 */
import { useEffect } from "react";
import { useExtensionState } from "../context/ExtensionStateContext";
import type { ExtensionToWebviewMessage } from "../types";

export function useExtensionMessage() {
  const { dispatch, postToExtension } = useExtensionState();

  useEffect(() => {
    function handleMessage(event: MessageEvent<ExtensionToWebviewMessage>) {
      const msg = event.data;
      switch (msg.type) {
        // Pipeline path
        case "progress":
          dispatch({ type: "ext/progress", text: msg.text });
          break;
        case "status":
          dispatch({ type: "ext/status", text: msg.text });
          break;
        case "assistant":
          dispatch({ type: "ext/assistant", text: msg.text });
          break;
        case "error":
          dispatch({ type: "ext/error", text: msg.text });
          break;
        case "info":
          dispatch({ type: "ext/info", text: msg.text });
          break;
        case "log":
          dispatch({ type: "ext/log", text: msg.text });
          break;
        case "agent":
          dispatch({ type: "ext/agent", text: msg.text });
          break;
        case "agent-error":
          dispatch({ type: "ext/agent-error", text: msg.text });
          break;
        case "done":
          dispatch({ type: "ext/done", text: msg.text });
          break;

        // SDK path
        case "sdk-text":
          dispatch({ type: "ext/sdk-text", text: msg.text, messageId: msg.messageId });
          break;
        case "sdk-tool-call":
          dispatch({
            type: "ext/sdk-tool-call",
            toolName: msg.toolName,
            input: msg.input,
            toolCallId: msg.toolCallId,
          });
          break;
        case "sdk-tool-result":
          dispatch({
            type: "ext/sdk-tool-result",
            toolCallId: msg.toolCallId,
            result: msg.result,
          });
          break;
        case "sdk-done":
          dispatch({
            type: "ext/sdk-done",
            cost: msg.cost,
            duration: msg.duration,
            result: msg.result,
          });
          break;
        case "sdk-error":
          dispatch({ type: "ext/sdk-error", text: msg.text });
          break;

        // Setup
        case "setup-status":
          dispatch({
            type: "ext/setup-status",
            cliInstalled: msg.cliInstalled,
            cliAuthenticated: msg.cliAuthenticated,
          });
          break;

        case "slack-status":
          dispatch({
            type: "ext/slack-status",
            connected: msg.connected,
            workspaceName: msg.workspaceName,
          });
          break;

        // Permission
        case "permission-request":
          dispatch({
            type: "ext/permission-request",
            requestId: msg.requestId,
            toolName: msg.toolName,
            input: msg.input,
            reason: msg.reason,
          });
          break;
        case "user-question":
          dispatch({
            type: "ext/user-question",
            requestId: msg.requestId,
            questions: msg.questions,
          });
          break;
        case "plan-review":
          dispatch({
            type: "ext/plan-review",
            requestId: msg.requestId,
            planText: msg.planText,
          });
          break;
        case "permission-mode":
          dispatch({ type: "ext/permission-mode", mode: msg.mode });
          break;

        // Sessions
        case "session-list":
          dispatch({ type: "ext/session-list", sessions: msg.sessions });
          break;
        case "session-opened":
          dispatch({ type: "ext/session-opened", messages: msg.messages });
          break;
        case "session-cleared":
          dispatch({ type: "ext/session-cleared" });
          break;
      }
    }

    window.addEventListener("message", handleMessage);

    // Signal to the extension that the webview is mounted and listening.
    // The extension waits for this before sending initial state (permission
    // mode, most recent session) — avoids a timing race with setTimeout.
    postToExtension({ type: "webview-ready" });

    return () => window.removeEventListener("message", handleMessage);
  }, [dispatch, postToExtension]);
}
