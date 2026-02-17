/**
 * Extension entry point — VS Code calls activate() when the extension loads.
 *
 * This file wires everything together:
 * - Registers context providers (Slack, Mock) and coding agents (Claude, Mock)
 * - Registers VS Code commands that appear in the command palette
 * - Opens the ChatPanel webview when requested
 *
 * The extension supports two usage modes:
 * 1. Chat panel (SDK path): Rich conversational UI with live streaming
 * 2. Command palette (pipeline path): One-shot search → prompt → execute
 *
 * To add a new provider, you only need to:
 * 1. Create adapter in providers/business-context/<name>/
 * 2. Register it here in activate()
 * 3. Add to package.json config enum
 */
import * as vscode from "vscode";
import { ProviderRegistry } from "./providers/registry";
import { BusinessContextProvider } from "./providers/businessContextProvider";
import { CodingAgent } from "./providers/codingAgent";
import { SlackProvider } from "./providers/business-context/slack/slackProvider";
import { MockProvider } from "./providers/business-context/mock/mockProvider";
import { ClaudeAgent } from "./providers/agents/claude/claudeAgent";
import { ClaudeSDKAgent } from "./providers/agents/claude-sdk/claudeSDKAgent";
import { MockAgent } from "./providers/agents/mock/mockAgent";
import { disambiguate } from "./ui/disambiguation";
import {
  appendOutputLine,
  clearOutput,
  showOutput,
  withProgress,
} from "./ui/outputPanel";
import { executeQuery } from "./services/queryService";
import { ChatPanel } from "./chat/chatPanel";

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
  registry.registerCodingAgent(new ClaudeAgent());
  registry.registerCodingAgent(new MockAgent());
  registry.registerConversationalAgent(new ClaudeSDKAgent());

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
    vscode.commands.registerCommand("businessContext.query", () => handleQuery())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("businessContext.search", () =>
      handleSearch()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("businessContext.configure", () =>
      handleConfigure()
    )
  );

  // Register command to open chat panel as editor tab
  context.subscriptions.push(
    vscode.commands.registerCommand("conduit.openChat", () => {
      ChatPanel.open(context, registry, getConfig);
    })
  );
}

export function deactivate() {}

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
    codingAgent: config.get<string>("codingAgent", "claude-code"),
    maxSearchResults: config.get<number>("maxSearchResults", 20),
    maxThreadMessages: config.get<number>("maxThreadMessages", 50),
  };
}

function getActiveBusinessContext(): BusinessContextProvider | undefined {
  const { contextProvider: id } = getConfig();
  const provider = registry.getBusinessContext(id);
  if (!provider) {
    vscode.window.showErrorMessage(`Business context provider "${id}" not found.`);
    return undefined;
  }
  if (!provider.isConfigured()) {
    vscode.window
      .showErrorMessage(
        `${provider.displayName} is not configured.`,
        "Configure Now"
      )
      .then((choice) => {
        if (choice === "Configure Now") provider.configure();
      });
    return undefined;
  }
  return provider;
}

function getActiveCodingAgent(): CodingAgent | undefined {
  const { codingAgent: id } = getConfig();

  // If the configured agent is a conversational agent (not a pipeline agent),
  // it uses the chat panel, not the command palette.
  if (registry.getConversationalAgent(id)) {
    vscode.window.showInformationMessage(
      `${id} uses the chat panel. Run "Conduit: Open Chat" instead.`
    );
    return undefined;
  }

  const agent = registry.getCodingAgent(id);
  if (!agent) {
    vscode.window.showErrorMessage(`Coding agent "${id}" not found.`);
    return undefined;
  }
  return agent;
}

function getWorkspaceDir(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage(
      "No workspace folder open. Open a project folder first."
    );
    return undefined;
  }
  return folders[0].uri.fsPath;
}

// ─── Command Handlers ──────────────────────────────────────

async function handleQuery() {
  const provider = getActiveBusinessContext();
  if (!provider) return;

  const agent = getActiveCodingAgent();
  if (!agent) return;

  const workDir = getWorkspaceDir();
  if (!workDir) return;

  const userInput = await vscode.window.showInputBox({
    title: "Business Context Query",
    prompt:
      'Describe what you want, referencing discussions. e.g. "implement what Sarah mentioned last week about rate limiting"',
    placeHolder: "What do you need?",
  });

  if (!userInput) return;

  await withProgress(
    `Searching ${provider.displayName} & running ${agent.displayName}...`,
    async (progress, token) => {
      clearOutput();
      showOutput();

      try {
        const result = await executeQuery({
          userInput,
          provider,
          agent,
          workDir,
          config: getConfig(),
          progress: {
            report: (msg) => progress.report({ message: msg }),
          },
          mentionResolver: {
            resolveAmbiguousUser: async (rawUser, matches) => {
              const pick = await vscode.window.showQuickPick(
                matches.map((m) => ({
                  label: m.realName,
                  description: `@${m.name}`,
                  userId: m.name,
                })),
                {
                  title: `Which user did you mean by "@${rawUser}"?`,
                  placeHolder: "Select a user",
                }
              );
              return pick?.userId;
            },
            resolveAmbiguousChannel: async (rawChannel, matches) => {
              const pick = await vscode.window.showQuickPick(
                matches.map((c) => ({
                  label: `#${c.name}`,
                  channelName: c.name,
                })),
                {
                  title: `Which channel did you mean by "#${rawChannel}"?`,
                  placeHolder: "Select a channel",
                }
              );
              return pick?.channelName;
            },
          },
          disambiguation: {
            disambiguate: async (clusters) => {
              const chosen = await disambiguate(clusters);
              return chosen ?? undefined;
            },
          },
          output: {
            log: (text) => appendOutputLine(text),
            agentOutput: (text) => appendOutputLine(text),
            agentError: (text) => appendOutputLine(`[stderr] ${text}`),
          },
          isCancelled: () => token.isCancellationRequested,
        });

        if (result.messagesFound === 0 && result.success) {
          vscode.window.showWarningMessage(
            "No messages found matching your query. Try being more specific."
          );
        } else if (result.success) {
          vscode.window.showInformationMessage(
            `${agent.displayName} finished. Check the output panel for results.`
          );
        } else if (result.error && result.error !== "Cancelled") {
          vscode.window.showErrorMessage(
            `${agent.displayName} failed: ${result.error?.slice(0, 200)}`
          );
        }

        showOutput();
      } catch (err: any) {
        appendOutputLine(`[Error] ${err.message}`);
        vscode.window.showErrorMessage(`Error: ${err.message}`);
        showOutput();
      }
    }
  );
}

async function handleSearch() {
  const provider = getActiveBusinessContext();
  if (!provider) return;

  const query = await vscode.window.showInputBox({
    title: `Search ${provider.displayName}`,
    prompt: "Enter a search query",
    placeHolder: "rate limiting discussion",
  });

  if (!query) return;

  clearOutput();
  showOutput();

  await withProgress(`Searching ${provider.displayName}...`, async () => {
    try {
      const config = getConfig();
      const results = await provider.searchMessages({
        query,
        maxResults: config.maxSearchResults,
      });

      appendOutputLine(`Found ${results.length} messages for: "${query}"\n`);

      for (const msg of results) {
        appendOutputLine(`─── ${msg.author} in #${msg.channel} [${msg.source}] ───`);
        appendOutputLine(msg.text);
        if (msg.permalink) {
          appendOutputLine(`Link: ${msg.permalink}`);
        }
        appendOutputLine("");
      }

      if (results.length === 0) {
        appendOutputLine("No messages found. Try a different query.");
      }
    } catch (err: any) {
      appendOutputLine(`[Error] ${err.message}`);
      vscode.window.showErrorMessage(`Search failed: ${err.message}`);
    }
  });
}

async function handleConfigure() {
  const providers = registry.getAllBusinessContextProviders();
  const agents = registry.getAllCodingAgents();

  const items = [
    ...providers.map((p) => ({
      label: `Configure ${p.displayName}`,
      id: p.id,
      itemKind: "provider" as const,
    })),
    ...agents.map((a) => ({
      label: `Check ${a.displayName} availability`,
      id: a.id,
      itemKind: "agent" as const,
    })),
  ];

  const choice = await vscode.window.showQuickPick(items, {
    title: "Configure Business Context",
    placeHolder: "What would you like to configure?",
  });

  if (!choice) return;

  if (choice.itemKind === "provider") {
    const provider = registry.getBusinessContext(choice.id);
    if (provider) await provider.configure();
  } else {
    const agent = registry.getCodingAgent(choice.id);
    if (agent) {
      const available = await agent.isAvailable();
      if (available) {
        vscode.window.showInformationMessage(`${agent.displayName} is available.`);
      } else {
        vscode.window.showWarningMessage(
          `${agent.displayName} not found. Make sure it's installed and in PATH.`
        );
      }
    }
  }
}
