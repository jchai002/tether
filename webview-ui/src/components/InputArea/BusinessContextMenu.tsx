/**
 * Business context drop-up menu — compact toolbar button that expands
 * to show available business context providers (Slack, Teams, etc.)
 * with their connection status and connect/disconnect actions.
 *
 * Collapsed: "Sources" button with a colored dot (green = connected, gray = none)
 * Expanded: Drop-up popup listing each provider with icon, name, status, and action
 *
 * Uses the same click-outside-to-close pattern as Header.tsx session dropdown.
 * Positioned as a drop-up (opens upward) since it sits in the bottom toolbar.
 */
import { useState, useRef, useEffect } from "react";
import { useExtensionState } from "../../context/ExtensionStateContext";
import { usePostMessage } from "../../hooks/usePostMessage";

export function BusinessContextMenu() {
  const { state } = useExtensionState();
  const post = usePostMessage();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on click outside — same pattern as Header.tsx
  useEffect(() => {
    if (!isOpen) return;
    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [isOpen]);

  const slackStatus = state.slackStatus;
  const anyConnected = slackStatus?.connected === true;

  return (
    <div className="biz-ctx-wrapper" ref={containerRef}>
      {/* Toolbar trigger button */}
      <button
        className="biz-ctx-trigger"
        onClick={() => setIsOpen(!isOpen)}
        title="Connect business context sources"
      >
        <span
          className="biz-ctx-dot"
          style={{
            background: anyConnected
              ? "var(--vscode-terminal-ansiGreen, #4d9375)"
              : "var(--vscode-descriptionForeground, #5c6370)",
          }}
        />
        Business Context Sources
      </button>

      {/* Drop-up popup */}
      {isOpen && (
        <div className="biz-ctx-popup">
          {/* Slack — real provider */}
          <div className="biz-ctx-row">
            <div className="biz-ctx-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
              </svg>
            </div>
            <div className="biz-ctx-info">
              <span className="biz-ctx-name">Slack</span>
              {slackStatus?.connected ? (
                <span className="biz-ctx-status connected">
                  Connected to {slackStatus.workspaceName || "workspace"}
                </span>
              ) : (
                <span className="biz-ctx-status">Not connected</span>
              )}
            </div>
            <div className="biz-ctx-action">
              {slackStatus?.connected ? (
                <button
                  className="provider-btn provider-btn-secondary"
                  onClick={() => post({ type: "disconnect-slack" })}
                >
                  Disconnect
                </button>
              ) : (
                <button
                  className="provider-btn provider-btn-primary"
                  onClick={() => post({ type: "connect-slack" })}
                >
                  Connect
                </button>
              )}
            </div>
          </div>

          {/* Teams — stub for visual validation */}
          <div className="biz-ctx-row">
            <div className="biz-ctx-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.625 8.5h-1.125V6.25a2.25 2.25 0 0 0-2.25-2.25h-1.688a3 3 0 1 0-3.187 0H10.5a2.25 2.25 0 0 0-2.25 2.25V8.5H3.375A1.875 1.875 0 0 0 1.5 10.375v5.25A1.875 1.875 0 0 0 3.375 17.5H8.25v.75a2.25 2.25 0 0 0 2.25 2.25h6.75a2.25 2.25 0 0 0 2.25-2.25v-3h1.125A1.875 1.875 0 0 0 22.5 13.375v-3A1.875 1.875 0 0 0 20.625 8.5z" />
              </svg>
            </div>
            <div className="biz-ctx-info">
              <span className="biz-ctx-name">Teams</span>
              <span className="biz-ctx-status">Not connected</span>
            </div>
            <div className="biz-ctx-action">
              <button className="provider-btn provider-btn-disabled" disabled>
                Coming soon
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
