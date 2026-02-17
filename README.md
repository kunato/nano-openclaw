# nano-openclaw

A useful personal AI assistant doesn't need much. It needs to **remember** you, **reach** you where you are, **act** on your behalf, and **not break things**. That's it.

[OpenClaw](https://github.com/openclaw/openclaw) proved what a next-generation personal AI agent looks like. **nano-openclaw** distills those patterns into **~4k lines of TypeScript** — every subsystem fits in a single file, the whole thing is readable in an afternoon, and it actually works as a daily-driver assistant.

> **The "nano" philosophy:** not fewer features — fewer lines per feature. Every pattern here is production-grade, just stripped to its essence.

## What Makes a Useful Assistant

A personal assistant is only as good as its weakest link. Drop any one of these and the experience breaks:

**1. It remembers you**

Not just within a conversation — across all of them. nano-openclaw has a persistent memory tool (store/search/update/delete) plus automatic LLM-driven consolidation that distills long conversations into `MEMORY.md` (facts, injected into every prompt) and `HISTORY.md` (events, searchable on demand). You never have to repeat yourself.

**2. It reaches you where you are**

Discord, Slack, or WhatsApp — configure one or all. Each is a thin adapter (~150 lines) over a shared `Channel` interface. Adding a new platform is one file.

**3. It acts, not just responds**

The agent can read/write/edit files, run shell commands, search the web, fetch and parse pages (HTML via Readability, PDFs via pdf.js), automate a browser, and download files. These aren't demos — they're the tools you actually need day-to-day.

**4. It thinks ahead**

A scheduler handles cron jobs, intervals, and one-shot reminders — with retry, backoff, and auto-disable so broken jobs don't spam you. A heartbeat service wakes the agent every 30 minutes to review workspace state (`MEMORY.md`, `HISTORY.md`, `TODO.md`) and take initiative without being asked.

**5. It doesn't break things**

Shell commands run inside a Docker sandbox (optional but recommended). Context overflow is handled with automatic retry, memory flush, and history compaction. Corrupted sessions self-repair. Tool results are truncated and images normalized before hitting the API. The boring reliability work is done.

## Quick Start

```bash
npm install
cp .env.example .env    # set MODEL_API_KEY + at least one channel
npm run dev
```

**Required env vars:**

- `MODEL_API_KEY` — Anthropic API key (`MODEL_PROVIDER` currently only supports `anthropic`)
- At least one channel: `DISCORD_TOKEN`, `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`, or `WHATSAPP_ENABLED=true`

**Optional:** `BRAVE_API_KEY` (web search), `SANDBOX_ENABLED=true` (Docker sandbox)

<details>
<summary>Channel setup guides</summary>

#### Discord

1. [Developer Portal](https://discord.com/developers/applications) → New Application → Bot
2. Enable **Message Content Intent**
3. Copy token → `DISCORD_TOKEN`
4. OAuth2 → `bot` scope + `Send Messages`, `Read Message History` → invite to server

#### Slack

1. [Slack API](https://api.slack.com/apps) → Create New App → Enable **Socket Mode**
2. Event Subscriptions: `message.channels`, `message.im`, `app_mention`
3. Scopes: `app_mentions:read`, `channels:history`, `chat:write`, `files:write`, `im:history`, `im:write`
4. Install → copy `SLACK_BOT_TOKEN` (xoxb-…) and `SLACK_APP_TOKEN` (xapp-…)

#### WhatsApp

1. Set `WHATSAPP_ENABLED=true`
2. Run the agent — scan the QR code with WhatsApp mobile

</details>

## Architecture

```
You (Discord / Slack / WhatsApp)
  → Channel adapter → AgentRunner
    → LLM ↔ tools (ReAct loop)
    → response → Channel adapter → You

Scheduler (cron / interval / one-shot)
  → fires job → AgentRunner → delivers to channel

Heartbeat (every 30 min)
  → reads workspace context → AgentRunner → proactive action
```

Every component is one file. The agent core (`agent.ts`) orchestrates the LLM session, tools, error recovery, and streaming. Everything else plugs in.

### Tools

| Tool         | What it does                                                  |
| ------------ | ------------------------------------------------------------- |
| `memory`     | Persistent store — survives across conversations              |
| `web_search` | Brave Search API                                              |
| `web_fetch`  | Fetch + parse HTML (Readability) or PDFs (pdf.js)             |
| `browser`    | Puppeteer — screenshots, navigate, click, type, scroll        |
| `file_ops`   | Download files from URLs                                      |
| `cron`       | Schedule jobs — cron, intervals, one-shot reminders           |
| _Built-in_   | `read`, `write`, `edit`, `bash`, `list_dir`, `find`, `grep`  |

### Workspace

```
workspace/
├── code/           # where coding tools operate (sandboxed if enabled)
├── skills/         # drop .md files here → injected into system prompt
├── memory/
│   ├── MEMORY.md   # consolidated facts (auto-maintained)
│   └── HISTORY.md  # event log (auto-maintained)
├── AGENTS.md       # bootstrap context for every conversation
└── TODO.md         # monitored by heartbeat for proactive follow-up
```

## Project Structure

```
src/
├── index.ts          # entry point — channels, scheduler, heartbeat
├── config.ts         # env loader
├── agent.ts          # agent core — LLM session, retry, streaming
├── prompt.ts         # system prompt builder
├── memory.ts         # persistent memory store
├── scheduler.ts      # cron / interval / one-shot with retry & concurrency
├── heartbeat.ts      # proactive agent wake-up
├── tools.ts          # tool registry
├── agent/            # subsystems (compaction, consolidation, overflow recovery, …)
├── tools/            # tool implementations (web-search, web-fetch, browser, …)
├── sandbox/          # Docker sandbox for shell execution
├── media/            # image processing
└── channels/         # Discord, Slack, WhatsApp adapters
```

## How It Stays Reliable

These are the production patterns that make the difference between a demo and a daily-driver:

- **Memory consolidation** — after every N messages, an LLM pass extracts key facts into `MEMORY.md` and appends events to `HISTORY.md`. This prevents context overflow while preserving what matters.
- **Scheduler reliability** — jobs persist to disk, retry with exponential backoff, respect concurrency limits, and auto-disable after repeated failures.
- **Heartbeat stability** — state persists across restarts; a minimum-interval guard prevents rapid-fire on process restart.
- **Context overflow recovery** — automatic retry (up to 3×) with memory flush, history trimming, and compaction.
- **Session repair** — corrupted JSONL session files are detected and repaired on load.
- **Tool safety** — all results are truncated (prevents context blowup) then images normalized (prevents API size errors).

## Docker Sandbox

When `SANDBOX_ENABLED=true`, shell commands run inside an isolated Docker container. File tools still run on the host — only execution is sandboxed.

<details>
<summary>Sandbox configuration</summary>

| Variable                | Default        | Description                              |
| ----------------------- | -------------- | ---------------------------------------- |
| `SANDBOX_ENABLED`       | `false`        | Enable sandboxing                        |
| `SANDBOX_SCOPE`         | `session`      | `session` (per-chat) or `shared`         |
| `SANDBOX_IMAGE`         | `node:22-slim` | Docker image                             |
| `SANDBOX_NETWORK`       | `none`         | `none` (isolated) or `bridge` (internet) |
| `SANDBOX_MEMORY`        | —              | Memory limit (e.g. `512m`)               |
| `SANDBOX_CPUS`          | —              | CPU limit (e.g. `1.0`)                   |
| `SANDBOX_PIDS_LIMIT`    | `256`          | Max PIDs                                 |
| `SANDBOX_SETUP_COMMAND` | —              | Post-creation setup command              |

</details>

<details>
<summary>Advanced configuration (scheduler, heartbeat, consolidation)</summary>

| Variable                     | Default   | Description                                  |
| ---------------------------- | --------- | -------------------------------------------- |
| `CONSOLIDATION_ENABLED`      | `true`    | Enable memory consolidation                  |
| `CONSOLIDATION_THRESHOLD`    | `50`      | Messages before consolidation triggers        |
| `HEARTBEAT_ENABLED`          | `true`    | Enable proactive heartbeat                   |
| `HEARTBEAT_INTERVAL_MS`      | `1800000` | Heartbeat interval (default 30 min)          |
| `HEARTBEAT_MIN_INTERVAL_MS`  | `600000`  | Min gap between heartbeats (default 10 min)  |
| `SCHEDULER_MAX_CONCURRENCY`  | `3`       | Max concurrent job executions                |
| `SCHEDULER_JOB_TIMEOUT_MS`   | `300000`  | Per-job timeout (default 5 min)              |
| `SCHEDULER_MAX_FAILURES`     | `5`       | Failures before auto-disabling a job         |

</details>

## Extending

Adding a channel or tool is one file each. No framework, no plugins, no magic.

<details>
<summary>Add a Channel</summary>

```typescript
// src/channels/my-channel.ts
import type { Channel, InboundMessage, OutboundMessage } from "./base.js";

export class MyChannel implements Channel {
  readonly name = "my-channel";
  async start(): Promise<void> { /* connect */ }
  async stop(): Promise<void> { /* disconnect */ }
  onMessage(handler: (msg: InboundMessage) => Promise<OutboundMessage | null>): void {
    // wire platform events → handler
  }
}
```

Register in `src/index.ts`.

</details>

<details>
<summary>Add a Tool</summary>

```typescript
// src/tools/my-tool.ts
import type { NanoToolDefinition } from "./types.js";
import { jsonTextResult } from "./types.js";

export function createMyTool(): NanoToolDefinition {
  return {
    name: "my_tool",
    label: "my_tool",
    description: "What it does",
    parameters: { type: "object", required: ["action"], properties: { /* … */ } },
    execute: async (_id, params) => jsonTextResult({ status: "ok" }),
  };
}
```

Export from `src/tools.ts`, register in `AgentRunner.buildCustomTools()`.

</details>

## Built On

[Pi SDK](https://github.com/nichochar/pi-sdk) (`@mariozechner/pi-agent-core`, `pi-ai`, `pi-coding-agent`) — nano-openclaw wraps it with custom prompts, error recovery, tool processing, and session streaming.

For the full system — gateway servers, multi-provider failover, plugins, subagents — see [OpenClaw](https://github.com/openclaw/openclaw).

## License

MIT
