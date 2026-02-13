# CLAUDE.md — Conduit

## Build & Run

```bash
npm install
npm run build     # esbuild → dist/extension.js
npm run watch     # rebuild on file changes
```

Press F5 in VS Code to launch Extension Development Host for testing.

## Project Structure

```
src/
├── providers/
│   ├── types.ts                  # Message, Thread, SearchOptions (shared types)
│   ├── businessContextProvider.ts # BusinessContextProvider interface
│   ├── codingAgent.ts            # CodingAgent interface (pipeline path)
│   ├── registry.ts               # ProviderRegistry
│   ├── business-context/         # Communication platform adapters
│   │   └── slack/                # Slack adapter
│   └── agents/
│       ├── claude/               # Claude Code CLI adapter (pipeline path)
│       └── claude-sdk/           # Claude Agent SDK adapter (SDK path)
│           ├── claudeSDKAgent.ts # SDK conversation management
│           ├── mcpTools.ts       # MCP tool definitions (provider-agnostic)
│           └── systemPrompt.ts   # System prompt with tool guidance
├── chat/
│   ├── chatPanel.ts              # Extension ↔ webview bridge, routes both paths
│   ├── sessionStore.ts           # Persistent session storage (workspaceState)
│   └── messages.ts               # Typed message protocol (extension ↔ webview)
├── services/
│   └── queryService.ts           # Query execution orchestration (pipeline path)
├── query/                        # Query analysis (platform-agnostic)
├── ui/                           # VS Code UI components (platform-agnostic)
├── webview/
│   └── template.ts               # HTML template for webview panel
├── contextPromptBuilder.ts       # Prompt assembly (pipeline path)
└── extension.ts                  # Entry point, wires registry
```

## Architecture Rules

- **All context sources must implement `BusinessContextProvider`** (src/providers/businessContextProvider.ts). Never import platform-specific code (Slack, Teams, etc.) outside of its own `providers/business-context/<platform>/` directory.
- **All coding tools must implement `CodingAgent`** (src/providers/codingAgent.ts) for the pipeline path. The SDK path uses `ClaudeSDKAgent` directly. Never import tool-specific code outside of its own `providers/agents/<tool>/` directory.
- **Core orchestration is platform-agnostic.** `extension.ts`, `disambiguation.ts`, `contextPromptBuilder.ts`, and `queryAnalyzer.ts` only use the generic `Message` and `Thread` types from `providers/types.ts`.
- **The only place provider-specific logic is allowed in extension.ts** is `instanceof` checks for provider-specific search plan methods (e.g. `SlackProvider.buildSearchPlan`). Keep these minimal.
- **New providers require exactly 3 changes:** (1) create adapter in `providers/business-context/<name>/` or `providers/agents/<name>/`, (2) register in `extension.ts` activate, (3) add to `package.json` config enum.

## Workflow Rules

- Do NOT commit unless explicitly asked to.
- Do NOT push unless explicitly asked to.
- Commit messages: single line, no emojis, no bullet points.

## Code Conventions

- TypeScript strict mode
- No default exports — use named exports everywhere
- VS Code config namespace: `businessContext.*`
- VS Code command namespace: `businessContext.*`
- Provider-specific settings nest under provider name: `businessContext.slack.*`, `businessContext.claude.*`
- **Comment new code for a junior-to-mid level audience.** This codebase spans AI integration (MCP, Claude SDK), VS Code extension APIs, and webview messaging — domains that are unfamiliar to most developers. Every new file should have a file-level comment explaining what it does and how it fits into the architecture. Non-obvious functions should have a brief JSDoc explaining *why* they exist, not just *what* they do. Inline comments for Code patterns that aren't self-explanatory.
- **Reuse shared UI components.** Before creating new webview components, check for existing shared components that can be extended (e.g., `DiffBlock` for diffs, `UserResponsePanel` for interactive option cards, `ToolInputPreview` for structured tool input rendering). Prefer adding props to an existing component over duplicating rendering logic.

## Key Context

Read `docs/ARCHITECTURE.md` before making structural changes.
Read `docs/VISION.md` for project vision and roadmap.
