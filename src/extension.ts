/**
 * Extension entry point — VS Code calls activate() when the extension loads.
 *
 * This file wires everything together:
 * - Registers context providers (Slack, Mock) and coding agents (Claude)
 * - Registers VS Code commands that appear in the command palette
 * - Opens the ChatPanel webview when requested
 *
 * To add a new provider, you only need to:
 * 1. Create adapter in providers/business-context/<name>/ or providers/agents/<name>/
 * 2. Register it here in activate()
 * 3. Add to package.json config enum
 */
import * as vscode from "vscode";
import { ProviderRegistry } from "./providers/registry";
import { SlackProvider } from "./providers/business-context/slack/slackProvider";
import { MockProvider } from "./providers/business-context/mock/mockProvider";
import { ClaudeSDKAgent } from "./providers/agents/claude-sdk/claudeSDKAgent";
import { ChatPanel } from "./chat/chatPanel";
import { DataCollector } from "./telemetry/dataCollector";
import { ConsentManager } from "./telemetry/consentManager";
import { SyncService } from "./telemetry/syncService";

/** Central registry for all providers and agents. Singleton for the extension lifetime. */
const registry = new ProviderRegistry();

/** Called by VS Code when the extension activates. Registers all providers,
 *  agents, and commands. The `context` object tracks disposables so VS Code
 *  can clean up when the extension deactivates. */
export function activate(context: vscode.ExtensionContext) {
  // Register all available providers and agents.
  // The user picks which ones to use via VS Code settings.
  registry.registerBusinessContext(new SlackProvider(context));
  registry.registerBusinessContext(new MockProvider());
  registry.registerCodingAgent(new ClaudeSDKAgent());

  // Telemetry — local data collection and consent management.
  // DataCollector logs locally by default. If the user previously clicked
  // "No thanks", disable logging on startup (they can re-enable via settings).
  const dataCollector = new DataCollector();
  if (context.globalState.get<boolean>("conduit.telemetry.dismissed")) {
    // User previously clicked "No thanks" — but check if they manually
    // re-enabled via settings since then (the config listener only fires
    // on changes, not on startup).
    const manuallyEnabled = vscode.workspace.getConfiguration("businessContext")
      .get<boolean>("telemetry.enabled", false);
    if (manuallyEnabled) {
      context.globalState.update("conduit.telemetry.dismissed", undefined);
    } else {
      dataCollector.disable();
    }
  }
  const consentManager = new ConsentManager(context, dataCollector);

  // If the user manually flips telemetry.enabled to true in settings after
  // previously declining, re-enable local logging and clear the dismissed state
  // so they don't need to reinstall. This is the "power user escape hatch."
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("businessContext.telemetry.enabled")) {
        const enabled = vscode.workspace.getConfiguration("businessContext")
          .get<boolean>("telemetry.enabled", false);
        if (enabled) {
          dataCollector.enable();
          context.globalState.update("conduit.telemetry.dismissed", undefined);
        }
      }
    })
  );

  // S3 sync service — periodically uploads telemetry data to our backend.
  // Starts a background timer (every 6 hours) and syncs on deactivate.
  const syncService = new SyncService();
  syncService.start();
  activeSyncService = syncService;

  // Register URI handler for OAuth callbacks
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri): void {
        if (uri.path === "/slack-callback") {
          handleSlackOAuthCallback(uri, context, registry);
        }
        // Future: /teams-callback, /jira-callback, etc.
      },
    })
  );

  // Register command palette commands
  context.subscriptions.push(
    vscode.commands.registerCommand("businessContext.configure", () =>
      handleConfigure()
    )
  );

  // Register command to open chat panel as editor tab
  context.subscriptions.push(
    vscode.commands.registerCommand("conduit.openChat", () => {
      ChatPanel.open(context, registry, getConfig, dataCollector, consentManager);
    })
  );

  // Transparency commands — let users inspect and delete collected telemetry data
  context.subscriptions.push(
    vscode.commands.registerCommand("conduit.viewTelemetryData", async () => {
      const filePath = dataCollector.getDataFilePath();
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.window.showTextDocument(doc);
      } catch {
        vscode.window.showInformationMessage("No telemetry data collected yet.");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("conduit.deleteTelemetryData", async () => {
      const confirm = await vscode.window.showWarningMessage(
        "Delete all collected telemetry data? This cannot be undone.",
        { modal: true },
        "Delete"
      );
      if (confirm === "Delete") {
        dataCollector.deleteData();
        vscode.window.showInformationMessage("Telemetry data deleted.");
      }
    })
  );
}

/** Module-level reference so deactivate() can trigger a final sync. */
let activeSyncService: SyncService | undefined;

export function deactivate() {
  // Best-effort final sync — VS Code gives ~5 seconds before killing.
  activeSyncService?.syncOnDeactivate();
}

// ─── OAuth Callback Handler ────────────────────────────────

async function handleSlackOAuthCallback(
  uri: vscode.Uri,
  context: vscode.ExtensionContext,
  registry: ProviderRegistry
): Promise<void> {
  const params = new URLSearchParams(uri.query);
  const state = params.get("state");
  const error = params.get("error");

  if (error) {
    vscode.window.showErrorMessage(`Slack auth failed: ${error}`);
    return;
  }

  if (!state) {
    vscode.window.showErrorMessage("Invalid Slack OAuth callback — missing state");
    return;
  }

  // Validate state nonce (stored in global state during initiation)
  const expectedState = context.globalState.get<string>("slack-oauth-state");
  if (state !== expectedState) {
    vscode.window.showErrorMessage("Invalid OAuth state");
    return;
  }

  // Fetch token from worker via Slack provider.
  // The worker already exchanged the code server-side and stashed
  // the token in KV — the provider just needs the state to retrieve it.
  const slackProvider = registry.getBusinessContext("slack") as SlackProvider;
  if (!slackProvider) {
    vscode.window.showErrorMessage("Slack provider not found");
    return;
  }

  try {
    await slackProvider.handleOAuthCallback(state);
    vscode.window.showInformationMessage("Slack connected successfully!");
    // Notify webview of connection status change (if chat panel is open)
    ChatPanel.checkSlackConnection();
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to connect Slack: ${err.message}`);
  }
}

// ─── Config ────────────────────────────────────────────────

function getConfig() {
  const config = vscode.workspace.getConfiguration("businessContext");
  return {
    contextProvider: config.get<string>("contextProvider", "slack"),
    codingAgent: config.get<string>("codingAgent", "claude-code-cli"),
    maxSearchResults: config.get<number>("maxSearchResults", 20),
    maxThreadMessages: config.get<number>("maxThreadMessages", 50),
  };
}

// ─── Command Handlers ──────────────────────────────────────

async function handleConfigure() {
  const providers = registry.getAllBusinessContextProviders();

  const items = providers.map((p) => ({
    label: `Configure ${p.displayName}`,
    id: p.id,
  }));

  const choice = await vscode.window.showQuickPick(items, {
    title: "Configure Business Context",
    placeHolder: "What would you like to configure?",
  });

  if (!choice) return;

  const provider = registry.getBusinessContext(choice.id);
  if (provider) await provider.configure();
}
