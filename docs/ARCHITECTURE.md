# Architecture

## Problem

Developers receive vague requests like "implement what Sarah mentioned last week" but lack the business context. AI coding tools can implement features but don't know what was discussed in Slack, Teams, or email.

## Solution

A VS Code extension with a conversational chat panel. The AI agent has MCP tools to search business communication and fetch threads on demand, then codes with full context. Multi-turn follow-ups let the developer refine the implementation naturally.

## Agent Architecture

The extension uses the conversational agent path for all queries. The configured agent streams responses through MCP tools, deciding when to search business context on its own.

```
User types in chat panel
  → ChatPanel creates conversation via ConversationalAgent
  → Agent SDK streams responses
  → Agent calls MCP tools as needed (search_slack, get_slack_thread)
  → MCP tools call BusinessContextProvider methods
  → Multi-turn: user can follow up, agent resumes with full context
  → Messages buffered and persisted to SessionStore
```

Key components:
- `ConversationalAgent` — abstract interface for any multi-turn agent
- `ClaudeSDKAgent` — wraps the Claude Agent SDK, manages conversations
- `createSdkMcpServer()` — in-process MCP server (no separate stdio process)
- `mcpTools.ts` — provider-agnostic MCP tool definitions (tool names derived from provider ID)
- `systemPrompt.ts` — guides when to use/not use business context tools

## Two Abstraction Boundaries

### BusinessContextProvider Interface

Abstracts where business context comes from. Each communication platform implements this interface.

```typescript
interface BusinessContextProvider {
  id: string;              // "slack", "teams", "outlook"
  displayName: string;     // "Slack", "Microsoft Teams"
  isConfigured(): boolean;
  configure(): Promise<void>;
  searchMessages(options: SearchOptions): Promise<Message[]>;
  getThread(channelId: string, threadId: string): Promise<Thread | null>;
}
```

**Current implementations:** Slack
**Planned:** Microsoft Teams, Outlook/Email, Discord, Linear, Jira

Platform-specific logic (API calls, auth, query syntax) stays entirely inside `providers/business-context/<platform>/`. The rest of the codebase only sees `Message` and `Thread`.

### ConversationalAgent Interface

Abstracts which AI coding agent handles multi-turn conversations. Each agent wraps a specific SDK/CLI and translates its events into Conduit's message protocol.

```typescript
interface ConversationalAgent {
  id: string;              // "claude-code-cli", "codex"
  displayName: string;
  isAvailable(): Promise<boolean>;
  isAuthenticated(): Promise<boolean>;
  isAuthError(text: string): boolean;
  getSetupInfo(): AgentSetupInfo;
  getSetupCommand(): string;
  resetCache(): void;
  createConversation(options, onMessage): AgentConversation;
  createConversationForResume(options, onMessage, sessionId): AgentConversation;
}
```

**Current implementations:** Claude Code CLI (Agent SDK)
**Planned:** OpenAI Codex, GitHub Copilot (once stable)

### Generic Data Types

All components communicate through platform-agnostic types:

```typescript
interface Message {
  id: string;
  text: string;
  author: string;
  source: string;      // "slack", "teams", etc.
  channel: string;
  timestamp: string;
  threadId?: string;
  permalink?: string;
}

interface Thread {
  parentMessage: Message;
  replies: Message[];
}
```

## Chat Panel

`ChatPanel` is the bridge between the VS Code extension host and the webview UI. It:

- Routes messages from the webview to the conversational agent
- Manages conversations and buffers messages for session persistence
- Handles permission requests (Ask / Auto-edit / YOLO modes)
- Restores the most recent session on startup

The configured agent is looked up from the registry by ID (e.g. `claude-code-cli`).

## Session Management

Conversations persist across VS Code restarts via `SessionStore`, backed by `workspaceState`.

- **Two-tier loading:** A lightweight index (`SessionMeta[]`) for fast list rendering; full message history loads lazily on demand
- **Lazy persistence:** Messages buffer during a conversation turn and flush to storage when Claude finishes (`sdk-done`)
- **Session ID migration:** Starts with a UUID, gets replaced with the SDK's real session ID to enable resumption
- **Auto-restore:** On startup, the most recent session loads automatically
- **Max 50 sessions** — oldest auto-deleted on overflow

## Permission System

Three modes, toggled in the input toolbar:

| Mode | Behavior |
|------|----------|
| Ask (default) | Prompt before edits and scripts |
| Auto-edit | Auto-approve file edits, prompt before scripts |
| YOLO | Auto-approve everything |

The SDK's `canUseTool` callback creates a Promise, sends the request to the webview for user approval, and waits for Allow/Deny. 5-minute timeout auto-denies.

## Provider Registration

Providers register on extension activation. The user picks which ones are active via VS Code settings.

```typescript
// extension.ts activate()
registry.registerBusinessContext(new SlackProvider());
registry.registerBusinessContext(new TeamsProvider());       // future
registry.registerConversationalAgent(new ClaudeSDKAgent());
registry.registerConversationalAgent(new CodexAgent());     // future
```

Settings:
```json
{
  "businessContext.contextProvider": "slack",
  "businessContext.codingAgent": "claude-code-cli"
}
```

## Webview Architecture

The chat UI is a React 19 app running inside a VS Code webview panel (sandboxed iframe).

### Two-Pipeline Build

```
Extension:  esbuild  → dist/extension.js  (CJS, Node.js)
Webview:    Vite     → dist/webview.js     (IIFE, browser)
                     → dist/webview.css
```

Both pipelines run from `esbuild.mjs`. The extension build runs first, then Vite builds the webview.

### State Management

React Context + `useReducer`. Single `AppState` object holds all webview state. Actions are prefixed:
- `ext/*` — from extension messages (mapped by `useExtensionMessage` hook)
- `ui/*` — from user interactions (dispatched directly by components)

### Message Protocol

The extension and webview communicate via `postMessage`. Types are shared from `src/chat/messages.ts` via a Vite path alias (`@shared` → `../src/chat/`).

### CSP Compliance

VS Code webviews enforce `default-src 'none'` CSP. All styling uses external CSS files — no CSS-in-JS, no inline styles, no React `style` prop.

### Key Files

```
webview-ui/
├── vite.config.ts        # IIFE output, @shared alias, jsdom test env
├── src/
│   ├── main.tsx          # Entry: acquireVsCodeApi, createRoot
│   ├── App.tsx           # Layout: Header, MessageList, StatusBar, InputArea
│   ├── context/          # State management (reducer, provider, types)
│   ├── hooks/            # useExtensionMessage, usePostMessage, useAutoScroll
│   ├── components/
│   │   ├── Header.tsx
│   │   ├── WelcomeScreen.tsx
│   │   ├── StatusBar.tsx
│   │   ├── PermissionToggle.tsx
│   │   ├── InputArea/          # Textarea + toolbar (permission toggle, send/stop)
│   │   ├── SessionList/        # Past conversation browser
│   │   └── MessageList/        # Chat messages, tool renderers, permissions, todos
│   ├── styles/global.css
│   ├── utils/            # shortenPath, formatRelativeTime
│   └── test/             # Vitest + React Testing Library (57 tests)
src/webview/
└── template.ts           # HTML template for webview panel (used by chatPanel.ts)
```

## Why Users Need Claude Code CLI

The Claude Agent SDK spawns the Claude Code CLI as a subprocess internally — Conduit doesn't manage the process or touch API keys. Users leverage their existing Claude Pro/Max subscriptions (no per-token costs). The CLI provides full access to Claude Code's built-in codebase intelligence, file editing, git operations, and all agent capabilities.

Adding a new agent (e.g. Codex) requires implementing `ConversationalAgent`, registering in `extension.ts`, and adding to `package.json` — zero changes to chatPanel or webview code.
