# nano-openclaw

[OpenClaw](https://github.com/openclaw/openclaw) took the world by storm by showing what next-generation personal AI agents look like — an engineering masterpiece of personal assistant, persistent memory, web tools, scheduling, and sandboxed execution. But in the LLM era, where concepts are blurred and moving constantly, understanding *how* it all works can be hard.

**nano-openclaw** bridges that gap: a **fully working personal AI assistant** in **~3k lines of TypeScript** — code you can read in an afternoon, extend in a day, and deploy with confidence. It demonstrates how to build a production-grade agent with **security best practices** (including **Docker-sandboxed code execution**) while stripping away the complexity, allowing practitioners and researchers to understand, modify, and extend the core logic.

### Why nano-openclaw?

- **Understand it** — every subsystem (memory, tools, scheduling, sandboxing) fits in a single file you can read top-to-bottom
- **Extend it** — clean interfaces for adding tools, channels, and skills — no framework magic
- **Trust it** — Docker sandbox isolates all code execution with isolate execution environment, dropped capabilities, and network isolation
- **Ship it** — `npm install`, set two env vars, and you have a fully functional assistant on Discord

## What Can It Do?

| Capability | How |
|---|---|
| **Code with you** | ReAct agent loop — reads, writes, edits files, runs shell commands |
| **Remember things** | Persistent memory + LLM-based consolidation (`MEMORY.md`, `HISTORY.md`) |
| **Browse the web** | Brave Search + Readability + PDF extraction + Puppeteer browser automation |
| **Run on schedule** | Cron jobs and one-time reminders with timezone support |
| **See images** | Vision support — send images in Discord, Slack, or WhatsApp, get screenshots from tools |
| **Execute safely** | Docker sandbox on code execution — production security in minimal code |
| **Talk where you work** | Discord, Slack, and WhatsApp support (extensible via `Channel` interface) |
| **Learn your project** | Skills (`skills/*.md`) and bootstrap context (`AGENTS.md`) |

## Architecture

```
Message (Discord / Slack / WhatsApp)
  → ChannelManager
    → AgentRunner.handleMessage()
      → Pi SDK session.prompt()  ← ReAct loop (LLM ↔ tools)
        Built-in:  read, write, edit, bash, list_dir, find, grep
        Custom:    memory, web_search, web_fetch, browser, reminder, file_ops
      → extract response + images
    → reply to Channel
```

### Project Structure

```
src/
├── index.ts                # Entry point — loads enabled channels + scheduler
├── config.ts               # .env configuration loader
├── agent.ts                # Agent runner — Pi SDK wrapper, retry, streaming
├── prompt.ts               # System prompt builder
├── memory.ts               # File-based persistent memory store
├── scheduler.ts            # Cron & one-time job scheduler
├── tools.ts                # Custom tool registry
├── agent/                  # Agent subsystems
│   ├── compaction.ts       #   Auto-compaction with reserve tokens
│   ├── consolidation.ts    #   LLM-driven memory consolidation
│   ├── context-overflow.ts #   Context error recovery & retry
│   ├── history.ts          #   Session history sanitization
│   ├── memory-flush.ts     #   Pre-compaction memory preservation
│   ├── session-repair.ts   #   Corrupted session file repair
│   ├── skills.ts           #   Workspace skills loader
│   ├── tool-wrappers.ts    #   Result truncation & image normalization
│   └── utils.ts            #   Tool metadata & response extraction
├── tools/                  # Individual tool implementations
│   ├── web-search.ts       #   Brave web search
│   ├── web-fetch.ts        #   Readability + PDF fetching
│   ├── browser.ts          #   Puppeteer browser automation
│   ├── file-ops.ts         #   File download & management
│   └── reminder.ts         #   Scheduled task tool
├── sandbox/                # Docker sandbox for isolated execution
├── media/                  # Image processing (sharp)
└── channels/               # Extensible channel interface
    ├── base.ts             #   Channel interface
    ├── manager.ts          #   Multi-channel manager
    ├── discord.ts          #   Discord implementation
    ├── slack.ts            #   Slack implementation
    └── whatsapp.ts         #   WhatsApp implementation (baileys)
```

## Quick Start

### 1. Install

```bash
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

**Required:**
- `MODEL_API_KEY` — Anthropic (or other provider) API key
- At least one channel configured:
  - **Discord**: `DISCORD_TOKEN`
  - **Slack**: `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`
  - **WhatsApp**: `WHATSAPP_ENABLED=true`

**Optional:**
- `MODEL_PROVIDER` — defaults to `anthropic` (currently the only supported provider)
- `MODEL_ID` — defaults to `claude-sonnet-4-20250514`
- `WORKSPACE_DIR` — agent workspace (defaults to repo's `workspace/` directory)
- `BRAVE_API_KEY` — enables web search
- `SANDBOX_ENABLED=true` — enables Docker sandboxing (see [Sandbox](#docker-sandbox) below)

### 3. Create a Bot

#### Discord
1. [Discord Developer Portal](https://discord.com/developers/applications) → New Application → Bot
2. Enable **Message Content Intent** under Privileged Gateway Intents
3. Copy token → `DISCORD_TOKEN` in `.env`
4. OAuth2 → URL Generator → `bot` scope + `Send Messages`, `Read Message History` → invite to server

#### Slack
1. [Slack API](https://api.slack.com/apps) → Create New App → From scratch
2. **Socket Mode** → Enable Socket Mode
3. **Event Subscriptions** → Enable → Subscribe to `message.channels`, `message.im`, `app_mention`
4. **OAuth & Permissions** → Scopes: `app_mentions:read`, `channels:history`, `chat:write`, `files:write`, `im:history`, `im:write`
5. Install to Workspace
6. Copy Bot User OAuth Token (`xoxb-...`) → `SLACK_BOT_TOKEN`
7. Basic Information → App-Level Tokens → Generate (`connections:write`) → `SLACK_APP_TOKEN`

#### WhatsApp
1. Set `WHATSAPP_ENABLED=true` in `.env`
2. Run the agent — it will print a QR code to the terminal
3. Scan with WhatsApp mobile app (Linked Devices)

### 4. Run

```bash
npm run dev          # Development (hot reload via tsx)
npm run build && npm start   # Production
```

## Usage

- **DM the bot** — responds to all direct messages
- **Mention in a channel** — responds when @mentioned
- **Send images** — attach images for vision-enabled models
- Each user/channel gets its own persistent session

### Commands

Supported on all channels:

| Command | Action |
|---|---|
| `/stop` | Cancel the current agent task |
| `/reset` | Clear conversation history |
| `/status` | Check if the agent is busy |
| `/help` | Show available commands |

### Tools

**Built-in (Pi SDK):** `read`, `write`, `edit`, `bash`/`exec`, `list_dir`, `find`, `grep`

**Custom:**
- **`memory`** — store, search, list, update, delete persistent memories
- **`web_search`** — Brave Search API (requires `BRAVE_API_KEY`)
- **`web_fetch`** — fetch & parse web pages (Readability) or PDFs (pdf.js)
- **`browser`** — Puppeteer screenshots, navigation, click, type, scroll
- **`file_ops`** — download files from URLs
- **`reminder`** — cron or one-time scheduled tasks with timezone support

### Skills & Bootstrap Context

Customize agent behavior per workspace:

- **Skills** — drop markdown files in `skills/` for specialized instructions
- **Bootstrap context** — create `AGENTS.md` or `CLAUDE.md` in workspace root for project-wide instructions

## Docker Sandbox

When `SANDBOX_ENABLED=true`, shell commands run inside an isolated Docker container:

- **Security** — docker sandbox
- **File sharing** — workspace is bind-mounted so host and container share files
- **Scope** — per-session (`session`) or shared across all chats (`shared`)
- **Lifecycle** — stale containers auto-pruned after 24h; config drift triggers recreation
- **Limits** — configurable memory, CPU, and PID limits

File tools (read/write/edit) still run on the host. Only shell execution is sandboxed.

<details>
<summary>Sandbox environment variables</summary>

| Variable | Default | Description |
|---|---|---|
| `SANDBOX_ENABLED` | `false` | Enable Docker sandboxing |
| `SANDBOX_SCOPE` | `session` | `session` or `shared` |
| `SANDBOX_IMAGE` | `node:22-slim` | Docker image |
| `SANDBOX_NETWORK` | `none` | `none` (isolated) or `bridge` (internet) |
| `SANDBOX_MEMORY` | — | Memory limit (e.g. `512m`) |
| `SANDBOX_CPUS` | — | CPU limit (e.g. `1.0`) |
| `SANDBOX_PIDS_LIMIT` | `256` | Max PIDs |
| `SANDBOX_SETUP_COMMAND` | — | Post-creation shell command |

</details>

## Internals

Key design decisions carried over from OpenClaw, distilled for clarity:

- **Memory Consolidation**

When conversation gets long, nano-openclaw automatically triggers an LLM-driven consolidation process (background task) to:
1.  **Extract key facts** — updates `memory/MEMORY.md` (injected into future system prompts)
2.  **Log events** — appends to `memory/HISTORY.md` (chronological log)

This mimics human long-term memory formation, preventing context window overflow while retaining crucial information.

- **Context overflow recovery** — automatic retry (up to 3 attempts) with memory flush, history sanitization, and compaction reserve tokens
- **Tool wrappers** — all custom tool results pass through truncation (prevents context blowup) then image normalization (prevents API size errors)
- **Session persistence** — JSONL files per user/channel with automatic repair of corrupted sessions
- **Image normalization** — all images (inbound + tool-generated) resized to ≤2000px / 5MB, converted to JPEG/PNG

### Pi SDK Integration

Built on the [Pi SDK](https://github.com/nichochar/pi-sdk):
- `@mariozechner/pi-agent-core` — core agent framework
- `@mariozechner/pi-ai` — model streaming
- `@mariozechner/pi-coding-agent` — built-in coding tools

nano-openclaw wraps the SDK with custom system prompts, error recovery, tool result processing, and session event streaming.

## Extending

### Add a Channel

Implement the `Channel` interface in `src/channels/`:

```typescript
import type { Channel, InboundMessage, OutboundMessage } from "./base.js";

export class MyChannel implements Channel {
  readonly name = "my-channel";
  async start(): Promise<void> { /* connect */ }
  async stop(): Promise<void> { /* disconnect */ }
  onMessage(handler: (msg: InboundMessage) => Promise<OutboundMessage | null>): void {
    // Wire platform messages → handler
  }
}
```

Register it in `src/index.ts`.

### Add a Tool

Create `src/tools/my-tool.ts`, export from `src/tools.ts`, register in `AgentRunner.buildCustomTools()`:

```typescript
import type { NanoToolDefinition } from "./types.js";
import { jsonTextResult } from "./types.js";

export function createMyTool(): NanoToolDefinition {
  return {
    name: "my_tool",
    label: "my_tool",
    description: "What this tool does",
    parameters: { type: "object", required: ["action"], properties: { /* ... */ } },
    execute: async (_id, params) => {
      return jsonTextResult({ status: "success" });
    },
  };
}
```

## Scope

nano-openclaw focuses on the core agent loop and tooling. For gateway servers, multi-provider failover, plugins, subagents, and streaming responses, see the full [OpenClaw](https://github.com/openclaw/openclaw).

## License

MIT
