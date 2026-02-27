/**
 * MCP Tool definitions — these are the tools Claude can call during a conversation.
 *
 * How MCP tools work:
 * 1. We define each tool with a name, description, and Zod schema for inputs
 * 2. The SDK's `tool()` helper registers them on our in-process MCP server
 * 3. Claude reads the tool descriptions and decides when to call them
 * 4. When Claude calls a tool, the SDK invokes our handler function
 * 5. We return results as text content blocks that Claude reads and uses
 *
 * The `tool()` function from the SDK combines schema validation + handler.
 * Zod schemas are required — they define what parameters Claude can pass.
 *
 * Tool names are derived from the provider ID (e.g. "slack" → "search_slack",
 * "teams" → "search_teams") so they're self-documenting for Claude and future
 * providers get correctly named tools automatically.
 */
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { BusinessContextProvider } from "../../businessContextProvider";
import type { Message, Thread } from "../../types";

/** Returns the MCP tool names for a given provider.
 *  Used here and in claudeSDKAgent.ts (for allowedTools). */
export function getToolNames(provider: BusinessContextProvider) {
  return {
    search: `search_${provider.id}`,
    getThread: `get_${provider.id}_thread`,
    resolveUser: `resolve_${provider.id}_user`,
    resolveChannel: `resolve_${provider.id}_channel`,
  };
}

/** Creates a tool that lets Claude search messages on the provider's platform.
 *  Claude decides when to call this based on the tool description. */
export function createSearchTool(provider: BusinessContextProvider) {
  const names = getToolNames(provider);
  return tool(
    names.search,
    [
      `Search ${provider.displayName} messages. Returns matching messages with author, channel, timestamp, and text.`,
      "",
      "Search operators (combine freely):",
      "  from:@username  — messages from a specific user (use resolve_user first to get username)",
      "  in:#channel     — messages in a specific channel",
      "  before:YYYY-MM-DD / after:YYYY-MM-DD — date range",
      "  has:link / has:emoji / has:reaction — filter by content type",
      "",
      "Examples: 'from:@anna.pico in:#all-dashi', 'login page after:2026-01-01'",
      "",
      "IMPORTANT: Plain text search matches MESSAGE TEXT, not author names.",
      "To find messages by a person, use resolve_user first → then from:@username.",
      "",
      "SYNONYM RETRY: If a search returns 0 results or very few, retry with synonyms",
      "and related terms. For example: 'rate limiting' → 'throttling', 'API limits',",
      "'request quota'. Try 2-3 variations before concluding nothing exists.",
    ].join("\n"),
    {
      query: z.string().describe(
        "Search query — plain text or Slack search operators like from:@user in:#channel"
      ),
      maxResults: z.number().optional().default(20).describe(
        "Maximum number of results to return"
      ),
    },
    async (input) => {
      const messages = await provider.searchMessages({
        query: input.query,
        maxResults: input.maxResults,
      });
      const text =
        messages.length === 0
          ? "No messages found matching that query. Try broader search terms."
          : formatMessages(messages);
      return { content: [{ type: "text" as const, text }] };
    }
  );
}

/** Creates a tool that lets Claude fetch a full conversation thread.
 *  Claude typically calls this after the search tool finds a relevant message,
 *  to get the full discussion context with all replies. */
export function createGetThreadTool(provider: BusinessContextProvider) {
  const names = getToolNames(provider);
  return tool(
    names.getThread,
    `Fetch a full conversation thread by channel and thread ID. Use this after ${names.search} finds a relevant message to get the complete discussion with all replies.`,
    {
      channelId: z.string().describe("Channel ID (from search results)"),
      threadId: z.string().describe(
        "Thread timestamp ID (from search results, the threadId field)"
      ),
    },
    async (input) => {
      const thread = await provider.getThread(input.channelId, input.threadId);
      const text = thread
        ? formatThread(thread)
        : "Thread not found. The channel ID or thread ID may be incorrect.";
      return { content: [{ type: "text" as const, text }] };
    }
  );
}

/** Creates a tool that resolves a fuzzy name to platform user(s).
 *  The agent calls this before using from:@username in search queries,
 *  since plain text search only matches message text, not author names. */
export function createResolveUserTool(provider: BusinessContextProvider) {
  const names = getToolNames(provider);
  return tool(
    names.resolveUser,
    [
      `Resolve a person's name to their ${provider.displayName} username.`,
      "Use this BEFORE searching for messages by a person.",
      `Returns matching users with id, username, and display name. Then use from:@username in ${names.search}.`,
    ].join("\n"),
    {
      name: z.string().describe("Person's name or partial name (e.g. 'anna', 'sarah chen')"),
    },
    async (input) => {
      if (!provider.resolveUser) {
        return { content: [{ type: "text" as const, text: "User resolution not supported by this provider." }] };
      }
      const users = await provider.resolveUser(input.name);
      if (users.length === 0) {
        return { content: [{ type: "text" as const, text: `No users found matching "${input.name}".` }] };
      }
      const lines = users.map((u) => `@${u.name} — ${u.displayName} (ID: ${u.id})`);
      return { content: [{ type: "text" as const, text: `Found ${users.length} user(s):\n${lines.join("\n")}` }] };
    }
  );
}

/** Creates a tool that resolves a fuzzy name to platform channel(s).
 *  The agent calls this before using in:#channel in search queries. */
export function createResolveChannelTool(provider: BusinessContextProvider) {
  const names = getToolNames(provider);
  return tool(
    names.resolveChannel,
    [
      `Resolve a channel name to its exact ${provider.displayName} channel name.`,
      `Use this when the user mentions a channel name that might be approximate. Then use in:#channel in ${names.search}.`,
    ].join("\n"),
    {
      name: z.string().describe("Channel name or partial name (e.g. 'dashi', 'backend')"),
    },
    async (input) => {
      if (!provider.resolveChannel) {
        return { content: [{ type: "text" as const, text: "Channel resolution not supported by this provider." }] };
      }
      const channels = await provider.resolveChannel(input.name);
      if (channels.length === 0) {
        return { content: [{ type: "text" as const, text: `No channels found matching "${input.name}".` }] };
      }
      const lines = channels.map((c) => `#${c.name} (ID: ${c.id})`);
      return { content: [{ type: "text" as const, text: `Found ${channels.length} channel(s):\n${lines.join("\n")}` }] };
    }
  );
}

function formatMessages(messages: Message[]): string {
  const lines: string[] = [`Found ${messages.length} messages:\n`];
  for (const msg of messages) {
    lines.push("--- Message ---");
    lines.push(`Author: ${msg.author}`);
    lines.push(`Channel: #${msg.channel}`);
    lines.push(`Timestamp: ${msg.timestamp}`);
    if (msg.threadId) lines.push(`Thread ID: ${msg.threadId}`);
    if (msg.permalink) lines.push(`Link: ${msg.permalink}`);
    lines.push(`Text: ${msg.text}`);
    lines.push("");
  }
  return lines.join("\n");
}

function formatThread(thread: Thread): string {
  const lines: string[] = [];
  lines.push(`Thread in #${thread.parentMessage.channel}:`);
  lines.push(`\nOriginal message by ${thread.parentMessage.author}:`);
  lines.push(`> ${thread.parentMessage.text}`);
  if (thread.replies.length > 0) {
    lines.push(`\n${thread.replies.length} replies:`);
    for (const reply of thread.replies) {
      lines.push(`  ${reply.author}: ${reply.text}`);
    }
  }
  return lines.join("\n");
}
