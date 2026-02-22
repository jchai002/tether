/**
 * ConsentManager — handles telemetry opt-in notifications and settings.
 *
 * Shows a single, non-blocking VS Code notification after a random number
 * of messages (1–3) in the user's first session. The prompt appears while
 * Claude is working so the user can read and respond without waiting.
 *
 * "Enable" → turns on S3 sync (local logging is already active by default).
 * "No thanks" → stops local logging permanently via DataCollector.disable().
 * Timeout/X close → re-shows next time they open Conduit (once per session).
 *
 * Also respects VS Code's global telemetry setting — if telemetry.telemetryLevel
 * is "off", sync is force-disabled regardless of our own setting.
 */
import * as vscode from "vscode";
import { DataCollector } from "./dataCollector";

/** Key used in globalState to track whether the consent prompt was explicitly dismissed. */
const DISMISSED_KEY = "conduit.telemetry.dismissed";

export class ConsentManager {
  /** In-memory flag — ensures the prompt shows at most once per session
   *  (session = one VS Code window lifetime / Conduit webview open). */
  private promptShownThisSession = false;

  /** Random message count threshold (1–3) before showing the prompt.
   *  Picked once per session so the user sees value before being asked. */
  private triggerAfterMessages = Math.floor(Math.random() * 3) + 1;

  /** Counts sdk-done events (successful responses) this session. */
  private messageCount = 0;

  constructor(
    private context: vscode.ExtensionContext,
    private dataCollector: DataCollector,
  ) {}

  /** Returns true if telemetry sync is currently enabled.
   *  Checks both our setting AND VS Code's global telemetry level. */
  isSyncEnabled(): boolean {
    // Respect VS Code's global telemetry setting — users who turned off
    // all telemetry have a clear intent we should honor.
    const vscodeLevel = vscode.workspace.getConfiguration("telemetry")
      .get<string>("telemetryLevel", "all");
    if (vscodeLevel === "off") return false;

    return vscode.workspace.getConfiguration("businessContext")
      .get<boolean>("telemetry.syncEnabled", false);
  }

  /** Call on every successful sdk-done. Shows the consent notification
   *  once per session, after a random number of messages (1–5). */
  async maybeShowPrompt(): Promise<void> {
    // Already shown this session — one and done
    if (this.promptShownThisSession) return;

    // Already syncing — nothing to ask
    if (this.isSyncEnabled()) return;

    // Already dismissed permanently — never nag
    if (this.context.globalState.get<boolean>(DISMISSED_KEY)) return;

    // Wait until the random threshold is reached so the user
    // sees Conduit's value before being asked about data collection.
    this.messageCount++;
    if (this.messageCount < this.triggerAfterMessages) return;

    this.promptShownThisSession = true;
    await this.showPrompt();
  }

  /** Shows the consent notification with three options. Called from
   *  maybeShowPrompt() and recursively after "What's collected?" so the
   *  user can still Enable or dismiss after reading the telemetry doc. */
  private async showPrompt(): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      "Help improve Conduit? We'd collect anonymous usage patterns and AI responses " +
      "to train better context search. Never your Slack messages.",
      "Enable",
      "What's collected?",
      "No thanks",
    );

    if (choice === "Enable") {
      const config = vscode.workspace.getConfiguration("businessContext");
      await config.update("telemetry.enabled", true, vscode.ConfigurationTarget.Global);
      await config.update("telemetry.syncEnabled", true, vscode.ConfigurationTarget.Global);
    } else if (choice === "What's collected?") {
      // Open the user-facing telemetry doc so they can read what's collected
      const docUri = vscode.Uri.joinPath(
        this.context.extensionUri, "docs", "TELEMETRY.md"
      );
      try {
        await vscode.commands.executeCommand("markdown.showPreview", docUri);
      } catch {
        // Fallback: open as plain text if markdown preview isn't available
        const doc = await vscode.workspace.openTextDocument(docUri);
        await vscode.window.showTextDocument(doc);
      }
      // Re-show the same prompt so the user can still Enable or dismiss
      // after reading. VS Code notifications are one-shot — clicking any
      // button dismisses them.
      await this.showPrompt();
    } else if (choice === "No thanks") {
      // Explicit rejection — stop local logging and remember permanently
      this.dataCollector.disable();
      await this.context.globalState.update(DISMISSED_KEY, true);
    }
    // else: undefined = notification timed out or was closed via X.
    // Don't mark as dismissed — re-show next session (new VS Code window).
  }
}
