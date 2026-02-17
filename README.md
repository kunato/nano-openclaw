# nano-openclaw

Minimal re-implementation of [OpenClaw](https://github.com/openclaw/openclaw) — a coding agent powered by the Pi SDK, with persistent memory, web tools, scheduling, and Discord integration.

## Architecture

```
Discord message
  → DiscordChannel (channels/discord.ts)
    → AgentRunner.handleMessage() (agent.ts)
      → Pi SDK createAgentSession()
        → session.prompt(text, images)  ← ReAct loop (LLM ↔ tools)
        → Custom tools: memory, web_search, web_fetch, browser, reminders, file_ops
        → Built-in tools: read, write, edit, bash, list_dir, find, grep
      → extract assistant response + images
    → reply to Discord
```

### File Structure

```
src/
├── index.ts              # Entry point — starts Discord bot + scheduler
├── config.ts             # Load config from .env
├── agent.ts              # Agent runner (Pi SDK wrapper, retry logic)
├── agent/                # Agent subsystems
│   ├── compaction.ts     # Auto-compaction with reserve tokens
│   ├── context-overflow.ts # Context error recovery & retry
│   ├── history.ts        # Session history sanitization
│   ├── memory-flush.ts   # Pre-compaction memory preservation
│   ├── session-repair.ts # Corrupted session file repair
│   ├── skills.ts         # Workspace skills loader
│   ├── tool-wrappers.ts  # Result truncation & image normalization
│   └── utils.ts          # Tool metadata & response extraction
├── tools.ts              # Custom tools entry point
├── tools/                # Individual tool implementations
│   ├── types.ts          # Tool type definitions
│   ├── web-search.ts     # Brave web search
│   ├── web-fetch.ts      # Web page fetching with Readability
│   ├── browser.ts        # Puppeteer screenshots & interactions
│   ├── file-ops.ts       # File download & management
│   └── reminder.ts       # Scheduled task tool
├── prompt.ts             # System prompt builder (with skills)
├── memory.ts             # File-based persistent memory store
├── scheduler.ts          # Cron & one-time job scheduler
├── media/                # Image processing utilities
└── channels/
    ├── base.ts           # Channel interface (extend for new channels)
    └── discord.ts        # Discord channel implementation
```

### What's Included

| Feature | Implementation |
|---|---|
| **Coding agent** | Pi SDK ReAct loop with built-in tools (read, write, edit, bash, grep, find, list_dir) |
| **Persistent memory** | JSON-file memory store (store, search, list, update, delete) |
| **Web search** | Brave Search API integration (optional) |
| **Web fetching** | Fetch & parse web pages with Readability + screenshot support |
| **Browser automation** | Puppeteer-based: screenshots, page navigation, interactions |
| **File operations** | Download files from URLs with automatic organization |
| **Scheduled tasks** | Cron expressions + one-time reminders with persistent storage |
| **Vision support** | Process images in Discord messages for multimodal models |
| **Skills system** | Load workspace skills from `skills/*.md` for specialized tasks |
| **Bootstrap context** | Project-specific agent behavior via `AGENTS.md` / `CLAUDE.md` |
| **Discord** | discord.js bot — DMs and @mentions in servers, per-session contexts |
| **Session persistence** | JSONL session files per user/channel with auto-repair |
| **Context overflow recovery** | Automatic retry with compaction and error handling |
| **Memory flush** | Pre-compaction memory preservation to retain important context |
| **Tool result management** | Automatic truncation & image normalization to prevent API errors |
| **Session abort** | Stop running agent sessions mid-execution |
| **Extensible channels** | `Channel` interface — implement `start()`, `stop()`, `onMessage()` |

### What's NOT Included (vs Full OpenClaw)

- No gateway server / WebSocket protocol
- No multi-provider auth rotation or model failover  
- No sandbox/Docker isolation
- No plugin system
- No multi-channel support (Discord only)
- No streaming responses to client (waits for completion)
- No subagent spawning

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure

Copy `.env.example` to `.env` and fill in:

```bash
cp .env.example .env
```

**Required:**
- `MODEL_API_KEY` — API key for your model provider (e.g. Anthropic API key)
- `DISCORD_TOKEN` — Discord bot token

**Optional:**
- `MODEL_PROVIDER` — defaults to `anthropic`
- `MODEL_ID` — defaults to `claude-sonnet-4-20250514`
- `WORKSPACE_DIR` — defaults to `~/nano-openclaw-workspace`
- `AGENT_DIR` — defaults to `~/.nano-openclaw`
- `BRAVE_API_KEY` — enables web search tool (requires Brave Search API key)
- `PUPPETEER_EXECUTABLE` — custom Chrome/Chromium path for screenshots (optional)

### 3. Create a Discord bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to Bot → create a bot
4. Enable **Message Content Intent** under Privileged Gateway Intents
5. Copy the bot token → paste into `.env` as `DISCORD_TOKEN`
6. Go to OAuth2 → URL Generator → select `bot` scope + `Send Messages`, `Read Message History` permissions
7. Open the generated URL to invite the bot to your server

### 4. Run

```bash
# Development (with hot reload via tsx)
npm run dev

# Or build and run
npm run build
npm start
```

## Usage

- **DM the bot** — it responds to all direct messages
- **@mention in a server** — it responds when mentioned in a channel
- **Send images** — attach images in Discord for vision-enabled models
- Each DM user and each server channel gets its own persistent session

### Available Tools

The agent has access to the following tools:

#### Coding Tools (built-in)
- `read` — read file contents
- `write` — write new files
- `edit` — edit existing files with find/replace
- `bash` — execute shell commands
- `list_dir` — list directory contents
- `find` — search for files by name
- `grep` — search file contents with regex

#### Custom Tools

**`memory`** — Persistent memory across conversations
```
Actions: store, search, list, update, delete
Example: "Remember that my preferred language is TypeScript"
```

**`web_search`** — Search the web with Brave (requires `BRAVE_API_KEY`)
```
Example: "Search the web for recent TypeScript best practices"
```

**`web_fetch`** — Fetch and parse web pages
```
Fetches URL content with Mozilla Readability for clean text extraction
Example: "Fetch and summarize https://example.com/article"
```

**`browser`** — Automated browser interactions with Puppeteer
```
Actions: screenshot, navigate, click, type, scroll
Example: "Take a screenshot of https://example.com"
         "Navigate to the site and click the login button"
```

**`file_ops`** — Download and manage files
```
Actions: download (fetches file from URL and saves to downloads/)
Example: "Download the PDF from https://example.com/doc.pdf"
```

**`reminder`** — Schedule tasks (cron or one-time)
```
Actions: create, list, delete, update
Supports cron expressions and ISO-8601 timestamps
Example: "Remind me every day at 9am to check emails"
         "Remind me tomorrow at 3pm to submit the report"
```

### Skills System

Add specialized instructions to your workspace:

1. Create `skills/` directory in your workspace
2. Add markdown files: `skills/my-skill.md` or `skills/my-skill/SKILL.md`
3. The agent loads these on startup and applies them when relevant

Example skill file (`skills/api-design.md`):
```markdown
When designing REST APIs:
- Use plural nouns for collections
- Return proper HTTP status codes
- Include pagination for list endpoints
```

### Bootstrap Context

Customize agent behavior per project:

1. Create `AGENTS.md` or `CLAUDE.md` in workspace root
2. Add project-specific instructions
3. The agent includes this context in every conversation

Example:
```markdown
# Project Context
This is a TypeScript monorepo using pnpm workspaces.
Always use pnpm instead of npm for package management.
```

## Extending

### Add a New Channel

1. Create `src/channels/my-channel.ts` implementing the `Channel` interface:

```typescript
import type { Channel, InboundMessage, OutboundMessage } from "./base.js";

export class MyChannel implements Channel {
  readonly name = "my-channel";

  async start(): Promise<void> { 
    // Initialize connection (e.g., connect to platform API)
  }
  
  async stop(): Promise<void> { 
    // Clean up (e.g., disconnect, clear listeners)
  }

  onMessage(handler: (msg: InboundMessage) => Promise<OutboundMessage | null>): void {
    // Wire your platform's inbound messages to the handler
    // InboundMessage requires: text, sessionKey, channelId, userId, userName, isGroup
    // Optional: images (for vision support)
  }
}
```

2. Register it in `src/index.ts` alongside the Discord channel.

### Add a New Tool

1. Create a new tool file in `src/tools/my-tool.ts`:

```typescript
import type { NanoToolDefinition } from "./types.js";
import { textResult, jsonTextResult } from "./types.js";

export function createMyTool(): NanoToolDefinition {
  return {
    name: "my_tool",
    label: "my_tool",
    description: "Description of what this tool does and its parameters",
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["action1", "action2"],
          description: "The action to perform",
        },
        // Add other parameters...
      },
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const p = params as Record<string, unknown>;
      
      try {
        // Implement tool logic here
        return jsonTextResult({ status: "success", data: "..." });
      } catch (err) {
        return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
```

2. Export it from `src/tools.ts`:

```typescript
export { createMyTool } from "./tools/my-tool.js";
```

3. Add it to the custom tools in `src/agent.ts` in the `buildCustomTools()` method:

```typescript
tools.push(createMyTool());
```

## Advanced Features

### Context Overflow Handling

The agent automatically handles context overflow with:
- **Memory flush**: Preserves important context before auto-compaction
- **History sanitization**: Repairs malformed tool call/result pairs
- **Retry logic**: Up to 3 attempts with automatic error recovery
- **Reserve tokens**: Ensures compaction leaves room for new messages

### Image Processing

All images (inbound and tool-generated) are automatically:
- Normalized to API size limits (max 2000px, 5MB)
- Converted to optimal formats (JPEG/PNG)
- Attached to responses when tools produce visual output (e.g., screenshots)

### Session Management

- One session file per Discord user/channel (JSONL format)
- Automatic session repair for corrupted files
- Abort capability to stop long-running operations
- Session serialization to prevent concurrent execution

### Scheduler Details

The scheduler supports:
- **Cron expressions**: `"0 9 * * *"` (daily at 9am)
- **One-time tasks**: ISO-8601 timestamps `"2026-12-25T09:00:00Z"`
- **Timezone support**: IANA timezones (e.g., `"Asia/Bangkok"`)
- **Persistent storage**: Jobs survive restarts
- **Two payload types**:
  - `systemEvent` — simple text message
  - `agentTurn` — full agent execution with tool access

## Architecture Notes

### Tool Wrappers

All custom tools pass through two wrappers (in order):
1. **Result truncation** — Limits text output to prevent context overflow
2. **Image normalization** — Resizes/converts images to meet API requirements

### Pi SDK Integration

nano-openclaw uses the Pi SDK's:
- `@mariozechner/pi-agent-core` — Core agent framework
- `@mariozechner/pi-ai` — Model streaming utilities
- `@mariozechner/pi-coding-agent` — Built-in coding tools

The agent runner wraps Pi SDK with:
- Custom system prompt generation (with skills & bootstrap context)
- Enhanced error handling and retry logic
- Tool result processing and image collection
- Session event streaming for UI feedback

## License

MIT
