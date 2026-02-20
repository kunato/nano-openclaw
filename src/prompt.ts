import os from "node:os";
import type { CitationsMode } from "./config.js";

/**
 * Build the system prompt from workspace bootstrap files + runtime context.
 *
 * The workspace .md files (AGENTS.md, SOUL.md, USER.md, TOOLS.md) carry the
 * bulk of the agent's personality, instructions, and tool documentation.
 * This function adds only dynamic/runtime sections on top.
 */
export function buildSystemPrompt(params: {
  workspaceDir: string;
  hasWebSearch?: boolean;
  channelContext?: string;
  skillsSection?: string;
  bootstrapContext?: string;
  currentTime?: string;
  memoryContext?: string;
  citationsMode?: CitationsMode;
  sandbox?: {
    containerName: string;
    workdir: string;
    image: string;
    network: string;
    readOnlyRoot: boolean;
  };
}): string {
  const sections: string[] = [];

  // ── Bootstrap context (loaded from workspace .md files) ─────────────────
  // This is the primary source of agent identity, instructions, and tool docs.
  // Files: AGENTS.md, SOUL.md, USER.md, TOOLS.md, etc.
  if (params.bootstrapContext) {
    sections.push(params.bootstrapContext);
  } else {
    // Fallback identity if no workspace files exist
    sections.push("# nano-openclaw\n\nYou are a personal AI assistant.");
  }

  // ── Tool Call Style ────────────────────────────────────────────────────
  // This reinforces AGENTS.md at the system prompt level, ensuring the agent
  // is action-oriented even if the user customizes their bootstrap files.
  sections.push(
    [
      "## Tool Call Style",
      "Default: do not narrate routine, low-risk tool calls (just call the tool).",
      "Narrate only when it helps: multi-step work, complex/challenging problems, sensitive actions (e.g., deletions), or when the user explicitly asks.",
      "Keep narration brief and value-dense; avoid repeating obvious steps.",
      "Use plain human language for narration unless in a technical context.",
    ].join("\n"),
  );

  // ── Workspace ───────────────────────────────────────────────────────────
  sections.push(
    [
      "## Workspace",
      `Your working directory is: ${params.workspaceDir}`,
      `- Memory: ${params.workspaceDir}/memory/memory.json (use the \`memory\` tool)`,
      `- Skills: ${params.workspaceDir}/skills/ (read with \`read\` tool)`,
      "Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.",
    ].join("\n"),
  );

  // ── Long-term Memory (from MEMORY.md) ──────────────────────────────────
  if (params.memoryContext) {
    sections.push(
      [
        "## Long-term Memory",
        "The following is your persistent memory — facts, preferences, and context from previous conversations.",
        "Use this to maintain continuity. Update memory using the `memory` tool when you learn new important information.",
        "",
        params.memoryContext,
      ].join("\n"),
    );
  }

  // ── Skills ──────────────────────────────────────────────────────────────
  if (params.skillsSection) {
    sections.push(params.skillsSection);
  }

  // ── Runtime ─────────────────────────────────────────────────────────────
  const timeStr = params.currentTime || new Date().toISOString();
  sections.push(
    [
      "## Runtime",
      `OS: ${os.type()} ${os.release()} (${os.arch()}) | Node: ${process.version}`,
      `Time: ${timeStr}`,
      `CWD: ${params.workspaceDir}`,
      params.hasWebSearch ? "Web search: enabled (Brave API)" : "Web search: disabled",
    ].join("\n"),
  );

  // ── Sandbox ─────────────────────────────────────────────────────────────
  if (params.sandbox) {
    const sandboxLines = [
      "## Sandbox Environment",
      "Your shell commands (`exec` tool) run inside a sandboxed Docker container for security.",
      `Container: ${params.sandbox.containerName} (image: ${params.sandbox.image})`,
      `Working directory inside container: ${params.sandbox.workdir}`,
    ];
    if (params.sandbox.readOnlyRoot) {
      sandboxLines.push(
        "The root filesystem is read-only. Only the workspace mount and /tmp are writable.",
      );
    }
    if (params.sandbox.network === "none") {
      sandboxLines.push(
        "Network access is DISABLED inside the container. Use your custom tools (web_search, web_fetch, browser) for internet access — those run on the host.",
      );
    }
    sandboxLines.push(
      "File tools (read, write, edit) operate on the host workspace which is bind-mounted into the container, so changes are shared.",
    );
    sections.push(sandboxLines.join("\n"));
  }

  // ── Subagents ────────────────────────────────────────────────────────────
  sections.push(
    [
      "## Subagents",
      "You can spawn background sub-agent runs that execute in parallel isolated sessions using the `subagent` tool.",
      "- `subagent spawn` — launch a new subagent for a task. It runs in the background.",
      "- `subagent list` — check status of your spawned subagents.",
      "- `subagent kill` — abort a running subagent by its runId.",
      "",
      "Results are **auto-announced**: when a subagent finishes, a system message with its result",
      "will appear in your session automatically. You do NOT need to poll for status.",
      "",
      "Use subagents for: parallel research, background tasks, fan-out work decomposition.",
      "Each subagent gets its own session and full tool access.",
    ].join("\n"),
  );

  // ── Memory Recall ────────────────────────────────────────────────────────
  sections.push(buildMemoryRecallSection(params.citationsMode));

  // ── Safety ─────────────────────────────────────────────────────────────
  sections.push(
    [
      "## Safety",
      "You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking; avoid long-term plans beyond the user's request.",
      "Prioritize safety and human oversight over completion; if instructions conflict, pause and ask; comply with stop/pause/audit requests and never bypass safeguards.",
      "Do not manipulate or persuade anyone to expand access or disable safeguards. Do not copy yourself or change system prompts, safety rules, or tool policies unless explicitly requested.",
    ].join("\n"),
  );

  // ── Messaging ──────────────────────────────────────────────────────────
  sections.push(
    [
      "## Messaging",
      "- `[System Message] ...` blocks are internal context and are not user-visible by default.",
      "- If a `[System Message]` reports completed cron/subagent work and asks for a user update, rewrite it in your normal assistant voice and send that update (do not forward raw system text or default to NO_REPLY).",
    ].join("\n"),
  );

  // ── Channel ─────────────────────────────────────────────────────────────
  if (params.channelContext) {
    sections.push(`## Channel\n${params.channelContext}`);
  }

  return sections.join("\n\n---\n\n");
}

/**
 * Build the Memory Recall section of the system prompt.
 * Adapts citation instructions based on the configured mode.
 */
function buildMemoryRecallSection(citationsMode?: CitationsMode): string {
  const lines = [
    "## Memory Recall",
    "Before answering anything about prior work, decisions, dates, people, preferences, or todos:",
    "1. Run `memory_search` to find relevant snippets across MEMORY.md, HISTORY.md, and other memory files.",
    "2. Use `memory_get` to pull only the needed lines and keep context small.",
    "3. If low confidence after search, say you checked but found nothing definitive.",
    "",
    "The `memory` tool manages structured key-value memories (JSON store).",
    "The `memory_search` / `memory_get` tools search and read the markdown memory files written by consolidation.",
    "Use both systems as appropriate.",
  ];

  if (citationsMode === "off") {
    lines.push(
      "",
      "Memory citations are disabled: do not mention file paths or line numbers from memory in replies unless the user explicitly asks.",
    );
  } else {
    lines.push(
      "",
      "Memory citations: when referencing recalled information, include `Source: <path>#L<start>-L<end>` so the user can verify the memory snippet.",
    );
  }

  return lines.join("\n");
}
