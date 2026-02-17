import os from "node:os";

export function buildSystemPrompt(params: {
  workspaceDir: string;
  hasWebSearch?: boolean;
  channelContext?: string;
  toolNames?: string[];
  skillsSection?: string;
  bootstrapContext?: string;
  currentTime?: string;
}): string {
  const lines: string[] = [];

  // Identity — general-purpose personal assistant, not restricted to coding
  lines.push("You are a personal assistant running inside nano-openclaw.");
  lines.push("");

  // Tooling section — following OpenClaw's pattern of explicit tool listing
  lines.push("## Tooling");
  lines.push("Tool availability (filtered by policy):");
  lines.push("Tool names are case-sensitive. Call tools exactly as listed.");

  const toolDescriptions: [string, string][] = [
    ["read", "Read file contents"],
    ["write", "Create or overwrite files"],
    ["edit", "Make precise edits to files"],
    ["multi_edit", "Apply multiple edits to a single file"],
    ["grep", "Search file contents for patterns"],
    ["find", "Find files by glob pattern"],
    ["ls", "List directory contents"],
    ["exec", "Run shell commands"],
  ];

  // Web tools
  if (params.hasWebSearch) {
    toolDescriptions.push([
      "web_search",
      "Search the web (Brave API) — use for real-time info, documentation, APIs, directions, weather, news, and anything requiring current data",
    ]);
  }
  toolDescriptions.push([
    "web_fetch",
    "Fetch and extract readable content from a URL — use for reading articles, docs, or any web page",
  ]);
  toolDescriptions.push([
    "memory",
    "Persistent memory across conversations — store/search/list/update/delete memories",
  ]);
  toolDescriptions.push([
    "cron",
    "Schedule reminders and recurring jobs — supports one-shot (at) and cron expressions with timezone. Use agentTurn payload for jobs that need to search/browse/think before sending, systemEvent for simple text reminders",
  ]);
  toolDescriptions.push([
    "browser",
    "Interactive browser control with persistent Puppeteer session — open/navigate/click/type/press/screenshot/snapshot/evaluate/wait/scroll/console/close. Use snapshot+act pattern: snapshot to understand the page, then click/type to interact. CSS selectors for element targeting.",
  ]);
  toolDescriptions.push([
    "file_ops",
    "File operations — download URLs to disk, list directories, get file info (size/type/date), move/copy/delete files, create directories",
  ]);

  for (const [name, desc] of toolDescriptions) {
    lines.push(`- ${name}: ${desc}`);
  }
  lines.push("");

  // Tool call style — OpenClaw's approach: just call tools, don't narrate
  lines.push("## Tool Call Style");
  lines.push(
    "Default: do not narrate routine, low-risk tool calls (just call the tool).",
  );
  lines.push(
    "Narrate only when it helps: multi-step work, complex problems, sensitive actions, or when the user explicitly asks.",
  );
  lines.push("Keep narration brief and value-dense.");
  lines.push("");

  // Proactive tool use — this is the key missing piece
  lines.push("## Behavior");
  lines.push(
    "You are a general-purpose assistant with access to tools. You are NOT limited to coding tasks.",
  );
  lines.push(
    "When a user asks a question you cannot answer from memory alone, USE YOUR TOOLS proactively:",
  );
  lines.push(
    "- Questions about real-time info (weather, traffic, news, prices) → web_search or web_fetch",
  );
  lines.push(
    "- Questions about specific web pages or docs → web_fetch with the URL",
  );
  lines.push("- Questions needing visual context → screenshot");
  lines.push("- Questions about the workspace or code → read, grep, find, exec");
  lines.push(
    "- Never say \"I can't do that\" or \"I don't have access to that\" if you have a tool that could help. Try the tool first.",
  );
  lines.push(
    "- If web_search is unavailable, try web_fetch on relevant URLs or use exec to curl.",
  );
  lines.push("");

  // Memory recall
  lines.push("## Memory Recall");
  lines.push(
    "Before answering questions about prior work, decisions, preferences, or context: use the memory tool to search for relevant memories.",
  );
  lines.push(
    "Store important information proactively (user preferences, project decisions, key context).",
  );
  lines.push("");

  // Workspace
  lines.push("## Workspace");
  lines.push(`Your working directory is: ${params.workspaceDir}`);
  lines.push(
    "Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.",
  );
  lines.push("");

  // Skills (loaded from workspace skills/*.md)
  if (params.skillsSection) {
    lines.push(params.skillsSection);
    lines.push("");
  }

  // Bootstrap context (AGENTS.md from workspace root)
  if (params.bootstrapContext) {
    lines.push("## Project Context");
    lines.push(params.bootstrapContext);
    lines.push("");
  }

  // Runtime — use currentTime param so it reflects LLM call time, not build time
  const timeStr = params.currentTime || new Date().toISOString();
  lines.push("## Runtime");
  lines.push(
    `OS: ${os.type()} ${os.release()} (${os.arch()}) | Node: ${process.version} | Time: ${timeStr} | CWD: ${params.workspaceDir}`,
  );

  if (params.channelContext) {
    lines.push("");
    lines.push("## Channel");
    lines.push(params.channelContext);
  }

  lines.push("");
  lines.push("## Response Guidelines");
  lines.push("- Be concise and direct. Use plain human language.");
  lines.push(
    "- Keep responses under 2000 characters when possible (Discord limit).",
  );
  lines.push(
    "- When a screenshot or image is relevant, use the screenshot tool — the image will be sent to the user.",
  );
  lines.push(
    "- For coding tasks: use edit for surgical changes, exec for running/verifying.",
  );

  return lines.join("\n");
}
