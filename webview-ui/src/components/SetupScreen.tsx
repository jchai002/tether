/**
 * Setup screen — shown instead of the welcome/chat when the Claude Code
 * CLI is not installed or not authenticated.
 *
 * Displays a two-step checklist:
 * 1. Install Claude Code CLI (with npm install command)
 * 2. Authenticate with Claude (with "Open Terminal" button)
 *
 * Each step has a visual indicator: checkmark (done), number (current/pending).
 * The "Check Again" button re-runs detection after the user completes a step.
 *
 * Communication flow:
 * - "Open Terminal" sends { type: "open-setup-terminal" } to the extension,
 *   which opens a VS Code integrated terminal running `claude`.
 * - "Check Again" sends { type: "check-setup" } to the extension,
 *   which re-checks CLI status and sends back { type: "setup-status" }.
 */
import { useExtensionState } from "../context/ExtensionStateContext";
import { usePostMessage } from "../hooks/usePostMessage";

export function SetupScreen() {
  const { state } = useExtensionState();
  const post = usePostMessage();

  const status = state.setupStatus;
  // Still checking — don't render anything to avoid a flash
  if (!status) return null;

  const { cliInstalled, cliAuthenticated } = status;
  // Use agent-specific setup info if available, with Claude defaults as fallback
  const displayName = status.setupInfo?.displayName ?? "Claude Code";
  const installCommand = status.setupInfo?.installCommand ?? "npm install -g @anthropic-ai/claude-code";
  const cliBinaryName = status.setupInfo?.cliBinaryName ?? "claude";

  return (
    <div className="setup-screen">
      <h2 className="setup-title">Setup Required</h2>
      <p className="setup-subtitle">
        Conduit needs the {displayName} CLI to work. Let's get you set up.
      </p>

      <div className="setup-steps">
        {/* Step 1: Install the CLI */}
        <div
          className={`setup-step ${cliInstalled ? "setup-step-done" : "setup-step-current"}`}
        >
          <span className="setup-step-indicator">
            {cliInstalled ? "\u2713" : "1"}
          </span>
          <div className="setup-step-content">
            <div className="setup-step-label">Install {displayName} CLI</div>
            {!cliInstalled && (
              <div className="setup-step-detail">
                <code className="setup-command">
                  {installCommand}
                </code>
              </div>
            )}
          </div>
        </div>

        {/* Step 2: Authenticate */}
        <div
          className={`setup-step ${
            cliAuthenticated
              ? "setup-step-done"
              : cliInstalled
                ? "setup-step-current"
                : "setup-step-pending"
          }`}
        >
          <span className="setup-step-indicator">
            {cliAuthenticated ? "\u2713" : "2"}
          </span>
          <div className="setup-step-content">
            <div className="setup-step-label">Authenticate with {displayName}</div>
            {cliInstalled && !cliAuthenticated && (
              <div className="setup-step-detail">
                <p className="setup-step-hint">
                  Run <code>{cliBinaryName}</code> and follow the CLI instructions to
                  authenticate.
                </p>
                <button
                  className="setup-action-btn"
                  onClick={() => post({ type: "open-setup-terminal" })}
                >
                  Open Terminal
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <button
        className="setup-check-btn"
        onClick={() => post({ type: "check-setup" })}
      >
        Check Again
      </button>
    </div>
  );
}
