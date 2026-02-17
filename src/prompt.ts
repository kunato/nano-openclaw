import os from "node:os";

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
    sections.push("# nano-openclaw\n\nYou are a helpful personal AI assistant.");
  }

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

  // ── Channel ─────────────────────────────────────────────────────────────
  if (params.channelContext) {
    sections.push(`## Channel\n${params.channelContext}`);
  }

  return sections.join("\n\n---\n\n");
}
