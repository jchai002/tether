# Vision

## One-Liner

Bridge business context from where teams communicate with where developers code.

## The Problem

Every development team has this workflow gap:

1. Product/business discussions happen in Slack, Teams, email, Jira
2. Developer gets a task: "implement what we discussed"
3. Developer spends 20 minutes searching Slack, re-reading threads, synthesizing requirements
4. Developer opens AI coding tool and manually explains the context
5. AI tool implements based on incomplete understanding

Steps 3-4 are pure waste. The context exists — it's just trapped in communication tools.

AI coding tools keep getting better at understanding codebases. But they're still completely blind to the business conversations that drive the code. That gap shouldn't exist.

## The Solution

"Implement what Sarah mentioned last week about rate limiting"

The extension gives AI coding tools direct access to business communication via MCP (Model Context Protocol). Instead of pre-fetching context in a one-shot pipeline, the AI agent searches Slack, fetches threads, and asks follow-up questions on its own — pulling exactly the context it needs, when it needs it. Multi-turn conversations let the developer refine and guide the implementation naturally.

## Why This Should Be Open Source

No single team can build adapters for every communication platform and every coding tool. But a community can.

The architecture is built around two simple interfaces — `BusinessContextProvider` and `CodingAgent` — so that anyone can plug in support for their own stack. You use Teams instead of Slack? Write a Teams adapter and everyone benefits. You prefer Codex over Claude Code? Same thing.

This is the kind of tool that gets better the more people contribute to it. Community contributions are welcome.

### Design Principles

- **Free and open.** MIT license. The core extension and all provider adapters are free.
- **Community-driven.** The provider architecture exists specifically so contributors can add support for their platforms without touching core code.
- **Privacy-respecting.** Your Slack messages stay between you and Slack. The extension searches on your behalf using your own token. Nothing leaves your machine.
- **Tool-agnostic.** Not married to any one AI coding tool or communication platform. Use whatever your team uses.

## How to Help

The most impactful contributions are **new providers**. Each one makes the tool useful for a whole new set of teams:

**Context Providers needed:**
- Microsoft Teams (Graph API)
- Outlook / Email (Graph API)
- Discord
- Linear
- Jira
- Notion
- GitHub Issues / Discussions

**Coding Agent adapters needed:**
- OpenAI Codex (next in line — see [Multi-Agent Strategy](#multi-agent-strategy) below)
- GitHub Copilot SDK (once it exits technical preview)
- Continue.dev CLI
- Cline / Roo Code

See [CONTRIBUTING.md](../CONTRIBUTING.md) for a step-by-step guide. Adding a provider touches exactly 3 files.

**Other ways to contribute:**
- Bug reports and feature ideas via GitHub Issues

## Roadmap

### Phase 1: Core (Current)
- [x] Slack context provider
- [x] Claude Agent SDK integration (multi-turn, MCP-driven)
- [x] MCP tools: `search_slack`, `get_slack_thread` (in-process, no separate server)
- [x] CodingAgent abstraction (agent-agnostic chatPanel)
- [x] Chat webview with tool call/result rendering and follow-ups
- [x] End-to-end testing with real Slack workspace
- [ ] VS Code marketplace publishing

### Phase 2: Multi-Platform
- [ ] Multiple concurrent chat sessions (each spawns its own CLI subprocess)
- [ ] Microsoft Teams context provider (Graph API)
- [ ] Jira context provider (Atlassian REST API)
- [ ] Outlook/email context provider (Graph API)
- [ ] OpenAI Codex coding agent (SDK path — see [Multi-Agent Strategy](#multi-agent-strategy))
- [ ] Setup wizard (quick onboarding: select providers, paste API keys)

### Phase 3: Multi-Provider Context
- [ ] Multiple active providers simultaneously (`contextProviders: ["slack", "teams"]`)
- [ ] Fan-out search across all connected tools in parallel
- [ ] Source-tagged results (`[Slack] #product` vs `[Teams] #Product Team`)
- [ ] MCP tools per provider: `search_slack`, `search_teams`, `search_jira`
- [ ] Email-based identity linking across tools (automatic, ~90% coverage)
- [ ] `@user` and `#channel` autocomplete with source badges across all providers

### Phase 4: Community Growth
- [ ] Contribution guide + provider development docs
- [ ] Issue templates for new provider requests
- [ ] Community-contributed providers (Discord, Linear, Notion, GitHub Issues)

## Multi-Agent Strategy

Conduit wraps the Claude Agent SDK as its primary coding agent via the `CodingAgent` interface. Agent-specific coupling is contained within `providers/agents/claude-sdk/`. The chatPanel programs against the abstract interface, so adding a second agent requires zero changes to chatPanel or webview code — just a new adapter and registration.

### Next target: OpenAI Codex SDK

OpenAI's Codex SDK (`@openai/codex-sdk`, Apache 2.0) is architecturally the closest match to what Conduit already does with Claude. It spawns the Codex CLI as a subprocess, exchanges structured JSONL events, supports thread resume by ID, has `canAutoApprove`/`getCommandConfirmation` approval callbacks, and has first-class MCP support. A `providers/agents/codex/` adapter would follow the same patterns as `providers/agents/claude-sdk/`.

### Partially compatible targets

These agents have some of the pieces but are missing critical integration features:

- **GitHub Copilot SDK** (`@github/copilot-sdk`, MIT) — Streaming, approval callbacks, MCP support. Multi-language (TS, Python, Go, .NET). Currently in technical preview (Jan 2026) — API may change before GA. Strong candidate once stable.
- **OpenHands** (`openhands-ai`, MIT) — Full-featured Python SDK with event-sourced state, MCP + OAuth, permission policies, session replay. Production-ready (#1 on SWE-Bench). Catch: Python-only, so Conduit would need a subprocess bridge.
- **Continue.dev** (`@continuedev/cli`, Apache 2.0) — CLI with headless mode, full MCP, session resume. But no programmatic approval callback — headless mode excludes tools requiring approval entirely.
- **Cline / Roo Code** (Apache 2.0) — CLI with MCP support, but no structured event stream (output is human-readable text) and no programmatic approval callbacks. Roo Code has a REST API and can act as an MCP server, which is unique.

### Not viable for SDK-style integration

Cursor, Windsurf, and Devin are proprietary/closed with no embeddable SDK. Aider has no official SDK (scripting API is "explicitly unsupported"), no MCP, and no session resume. Amazon Q and Sourcegraph Cody lack programmatic streaming APIs for external use.

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Agent architecture | CodingAgent interface | All agents use the multi-turn streaming path with MCP tools |
| MCP integration | In-process via `createSdkMcpServer()` | No separate stdio server needed; tools wrap ContextProvider directly |
| Session management | SDK V1 `query()` with `resume` | SDK manages conversation history internally; supports multi-turn follow-ups |
| Auth approach | CLI subprocess (user's subscription) | No per-token costs, users keep their existing AI subscriptions |
| Slack auth | User OAuth Token (xoxp-) | Conduit sees Slack through the dev's eyes — user token gives search + full read access to everything the dev can see |
| Architecture | Provider/adapter pattern | Anyone can add a platform without touching core code |
| License | MIT | Maximum freedom for contributors and users |
