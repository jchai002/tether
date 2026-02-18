/**
 * Input area — textarea, permission toggle, send/stop button, and slash command menu.
 *
 * Layout (inspired by Claude Code):
 * ┌────────────────────────────────────┐
 * │ [SlashCommandMenu popup]          │  ← appears above input when "/" is typed
 * │ [textarea]                         │
 * │─────────── subtle divider ─────────│
 * │ [permission toggle]    [send/stop] │
 * └────────────────────────────────────┘
 *
 * Behavior:
 * - Enter sends the message (Shift+Enter for newline)
 * - Textarea auto-resizes up to 120px as user types
 * - Send = arrow-up icon, Stop = square icon (like Claude Code)
 * - Permission toggle on the left, send/stop right-aligned
 * - Typing "/" or "/mo" etc. shows the slash command popup
 *
 * Sends "query" for first message, "followup" for subsequent messages.
 */
import { useRef, useState, useCallback } from "react";
import { useExtensionState } from "../../context/ExtensionStateContext";
import { usePostMessage } from "../../hooks/usePostMessage";
import { PermissionToggle } from "../PermissionToggle";
import { ContextUsage } from "../ContextUsage";
import { SlashCommandMenu } from "./SlashCommandMenu";
import { BusinessContextMenu } from "./BusinessContextMenu";

export function InputArea() {
  const { state, dispatch } = useExtensionState();
  const post = usePostMessage();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");

  // Detect slash command prefix: "/" optionally followed by lowercase letters.
  // Examples: "/" → shows all, "/mo" → filters to "model", "/compact" → filters to "compact"
  const slashMatch = /^\/([a-z]*)$/.exec(text.trim());
  const showSlashMenu = slashMatch !== null;
  const slashFilter = slashMatch?.[1] ?? "";

  /** Sends the current text as a query or followup message. */
  const sendMessage = useCallback((messageText: string) => {
    const trimmed = messageText.trim();
    if (!trimmed || state.busy) return;

    dispatch({ type: "ui/add-user-message", text: trimmed });

    const msgType = state.inConversation ? "followup" : "query";
    post({ type: msgType, text: trimmed } as any);

    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [state.busy, state.inConversation, dispatch, post]);

  const send = useCallback(() => {
    sendMessage(text);
  }, [text, sendMessage]);

  /** Sends cancel message to extension — the agent stops and the
   *  conversation is preserved so the user can resume with a follow-up. */
  const stop = useCallback(() => {
    post({ type: "cancel" } as any);
  }, [post]);

  function handleKeyDown(e: React.KeyboardEvent) {
    // Suppress Enter when the slash menu is open — let the menu handle interaction
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!showSlashMenu) {
        send();
      }
    }
    // Escape closes the slash menu
    if (e.key === "Escape" && showSlashMenu) {
      setText("");
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value);
    // Auto-resize textarea
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }

  /** Called when user picks a model from the /model slash command picker. */
  function handleSelectModel(modelId: string) {
    post({ type: "set-model", modelId } as any);
    setText("");
  }

  /** Called when user clicks an action command (compact, review, etc.). */
  function handleSendCommand(commandText: string) {
    sendMessage(commandText);
  }

  /** Called when the slash menu should close (click outside, etc.). */
  function handleCloseSlashMenu() {
    setText("");
  }

  return (
    <div id="input-area">
      {/* Slash command popup — appears above the textarea when "/" is typed */}
      {showSlashMenu && (
        <SlashCommandMenu
          filter={slashFilter}
          models={state.availableModels}
          currentModel={state.currentModel}
          onSelectModel={handleSelectModel}
          onSendCommand={handleSendCommand}
          onClose={handleCloseSlashMenu}
        />
      )}
      <textarea
        ref={textareaRef}
        id="input"
        rows={1}
        placeholder={
          state.inConversation
            ? "Follow up or ask a question..."
            : "Describe what you need..."
        }
        value={text}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        autoFocus
      />
      {/* Toolbar: permission toggle left, send/stop right */}
      <div className="input-toolbar">
        <div className="input-toolbar-left">
          <PermissionToggle />
          <ContextUsage />
          <BusinessContextMenu />
        </div>
        <div className="input-toolbar-right">
          {state.busy ? (
            <button className="input-action-btn stop-btn" onClick={stop} title="Stop">
              {/* Square icon */}
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                <rect x="2" y="2" width="10" height="10" rx="1.5" />
              </svg>
            </button>
          ) : (
            <button className="input-action-btn send-btn" onClick={send} title="Send">
              {/* Arrow-up icon */}
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="7" y1="12" x2="7" y2="3" />
                <polyline points="3,6 7,2 11,6" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
