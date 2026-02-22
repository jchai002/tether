import * as vscode from "vscode";
import * as crypto from "crypto";
import { WebClient } from "@slack/web-api";
import { BusinessContextProvider } from "../../businessContextProvider";
import { Message, Thread, SearchOptions } from "../../types";
import { SlackCache, SlackUser, SlackChannel } from "./slackCache";

/** Conduit's unlisted Slack app client ID. Public value — not a secret.
 *  The client secret lives on the Cloudflare Worker (set via wrangler secret). */
const SLACK_CLIENT_ID = "10488515408532.10496099125142";

/** Conduit's OAuth proxy URL. Handles the Slack token exchange server-side
 *  so the client secret never touches the extension. */
const OAUTH_PROXY_URL = "https://conduit-oauth.jchai002.workers.dev";

export class SlackProvider implements BusinessContextProvider {
  readonly id = "slack";
  readonly displayName = "Slack";

  private client: WebClient | null = null;
  private cache: SlackCache;

  constructor(private context: vscode.ExtensionContext) {
    this.cache = new SlackCache(() => this.getClient());
  }

  async isConfigured(): Promise<boolean> {
    const token = await this.getToken();
    return !!token;
  }

  async configure(): Promise<void> {
    const token = await vscode.window.showInputBox({
      title: "Configure Slack User Token",
      prompt: "Enter your Slack User OAuth Token (starts with xoxp-)",
      placeHolder: "xoxp-...",
      password: true,
      validateInput: (value) => {
        if (value && !value.startsWith("xoxp-")) {
          return "Slack User Token should start with xoxp-";
        }
        return undefined;
      },
    });

    if (token !== undefined) {
      const config = vscode.workspace.getConfiguration("businessContext");
      await config.update("slack.userToken", token, vscode.ConfigurationTarget.Global);
      this.client = null;
      vscode.window.showInformationMessage("Slack token saved successfully.");
    }
  }

  async searchMessages(options: SearchOptions): Promise<Message[]> {
    const client = await this.getClient();
    const maxResults = options.maxResults ?? this.getMaxSearchResults();

    const result = await client.search.messages({
      query: options.query,
      sort: "timestamp",
      sort_dir: "desc",
      count: maxResults,
      page: 1,
    });

    const matches = (result.messages as any)?.matches ?? [];

    return Promise.all(matches.map((match: any) => this.toMessage(match)));
  }

  async getThread(channelId: string, threadId: string): Promise<Thread | null> {
    const client = await this.getClient();
    const limit = this.getMaxThreadMessages();

    const result = await client.conversations.replies({
      channel: channelId,
      ts: threadId,
      limit,
    });

    const messages = result.messages ?? [];
    if (messages.length === 0) return null;

    return {
      parentMessage: await this.toMessage(messages[0], channelId),
      replies: await Promise.all(messages.slice(1).map((msg: any) => this.toMessage(msg, channelId))),
    };
  }

  async resolveUser(input: string): Promise<SlackUser[]> {
    return this.cache.fuzzyMatchUser(input);
  }

  async resolveChannel(input: string): Promise<SlackChannel[]> {
    return this.cache.fuzzyMatchChannel(input);
  }

  /**
   * Gets the OAuth redirect URI. Uses the HTTPS proxy URL if configured
   * (required by Slack — they don't accept vscode:// URIs). The proxy
   * receives the OAuth callback from Slack, then redirects the browser
   * to vscode://jerrychaitea.conduit/slack-callback?code=...&state=...
   * which VS Code's URI handler catches.
   */
  private getOAuthRedirectUri(): string {
    return `${OAUTH_PROXY_URL}/slack-callback`;
  }

  /**
   * Initiates Slack OAuth flow by opening browser to authorization URL.
   * Generates a random state nonce for CSRF protection.
   */
  async initiateOAuth(context: vscode.ExtensionContext): Promise<void> {
    const clientId = SLACK_CLIENT_ID;

    const redirectUri = this.getOAuthRedirectUri();

    // Generate random state nonce for CSRF protection
    const state = crypto.randomBytes(32).toString("hex");
    await context.globalState.update("slack-oauth-state", state);

    // User scopes: everything runs under the user token (xoxp-).
    // search:read     → search.messages (core feature)
    // channels:read   → conversations.list (channel resolution)
    // channels:history → conversations.replies (thread fetching)
    // groups:*        → same for private channels
    // im/mpim:*       → DMs and group DMs
    // users:read      → user name resolution
    const userScopes = [
      "search:read",
      "channels:read", "channels:history",
      "groups:read", "groups:history",
      "im:read", "im:history",
      "mpim:read", "mpim:history",
      "users:read",
    ].join(",");

    // Minimal bot scope — Slack requires at least one for app installation.
    // We don't use the bot token; everything goes through the user token.
    const botScopes = "channels:read";

    const authUrl = `https://slack.com/oauth/v2/authorize?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: botScopes,
      user_scope: userScopes,
      state,
    })}`;

    vscode.env.openExternal(vscode.Uri.parse(authUrl));
  }

  /**
   * Retrieves the OAuth token from the Cloudflare Worker.
   *
   * The worker already exchanged the authorization code for a token
   * server-side (so the client secret never touches the extension).
   * The token is stashed in KV keyed by the state nonce. We fetch it
   * from the worker's /exchange endpoint using the state parameter.
   */
  async handleOAuthCallback(state: string): Promise<void> {
    // Fetch token from the worker's /exchange endpoint.
    const exchangeUrl = `${OAUTH_PROXY_URL}/exchange?state=${encodeURIComponent(state)}`;
    const response = await fetch(exchangeUrl);
    const data = (await response.json()) as { ok: boolean; error?: string; userToken?: string; teamName?: string };

    if (!data.ok) {
      throw new Error(data.error || "Token exchange failed");
    }

    if (!data.userToken) {
      throw new Error("No user token returned from proxy");
    }

    // Store the user token (xoxp-) for search.messages API
    await this.context.secrets.store("slack-user-token", data.userToken);

    // Store workspace name for UI display
    if (data.teamName) {
      await this.context.globalState.update("slack-workspace-name", data.teamName);
    }

    // Clear state nonce
    await this.context.globalState.update("slack-oauth-state", undefined);

    // Reset cached client so next search uses new token
    this.client = null;
  }

  /**
   * Checks if Slack is connected (bot token exists in SecretStorage).
   */
  async isConnected(): Promise<boolean> {
    const token = await this.context.secrets.get("slack-user-token");
    return !!token;
  }

  /**
   * Gets connection status including workspace name.
   */
  async getConnectionStatus(): Promise<{ connected: boolean; workspaceName?: string }> {
    const connected = await this.isConnected();
    if (!connected) return { connected: false };

    const workspaceName = this.context.globalState.get<string>("slack-workspace-name");
    return { connected: true, workspaceName };
  }

  /**
   * Disconnects by clearing token and workspace name.
   */
  async disconnect(): Promise<void> {
    await this.context.secrets.delete("slack-user-token");
    await this.context.globalState.update("slack-workspace-name", undefined);
    this.client = null;
  }

  // ── Private ───────────────────────────────────────────

  private async getToken(): Promise<string | undefined> {
    // Try SecretStorage first (OAuth token)
    const oauthToken = await this.context.secrets.get("slack-user-token");
    if (oauthToken) return oauthToken;

    // Fallback to manual token in settings (legacy support)
    const config = vscode.workspace.getConfiguration("businessContext");
    return config.get<string>("slack.userToken");
  }

  private getMaxSearchResults(): number {
    return vscode.workspace
      .getConfiguration("businessContext")
      .get<number>("maxSearchResults", 20);
  }

  private getMaxThreadMessages(): number {
    return vscode.workspace
      .getConfiguration("businessContext")
      .get<number>("maxThreadMessages", 50);
  }

  private async getClient(): Promise<WebClient> {
    const token = await this.getToken();
    if (!this.client || (this.client as any).token !== token) {
      this.client = new WebClient(token);
    }
    return this.client;
  }

  /** Converts a raw Slack API message object into our generic Message type.
   *  Resolves the Slack user ID to a human-readable display name via the cache. */
  private async toMessage(raw: any, channelId?: string): Promise<Message> {
    const authorId = raw.user ?? raw.username ?? "unknown";
    // Resolve user ID (e.g. "U0AG427DM4Z") to display name (e.g. "Kevin White")
    const author = authorId.startsWith("U")
      ? await this.cache.resolveUserName(authorId)
      : authorId;

    return {
      id: raw.ts ?? "",
      text: raw.text ?? "",
      author,
      source: "slack",
      channel: raw.channel?.name ?? raw.channel?.id ?? channelId ?? "",
      timestamp: raw.ts ?? "",
      threadId: raw.thread_ts,
      permalink: raw.permalink ?? "",
    };
  }

}
