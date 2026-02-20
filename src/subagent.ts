import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────

export interface SubagentRunRecord {
  runId: string;
  childSessionKey: string;
  parentSessionKey: string;
  parentChannelId: string;
  task: string;
  label?: string;
  depth: number;
  status: "running" | "ok" | "error" | "killed";
  result?: string;
  error?: string;
  createdAt: number;
  endedAt?: number;
}

export type AnnounceCallback = (params: {
  parentSessionKey: string;
  parentChannelId: string;
  runId: string;
  label?: string;
  task: string;
  status: "ok" | "error";
  result: string;
  startedAt: number;
  endedAt: number;
}) => Promise<void>;

export type SpawnProgressCallback = (params: {
  parentSessionKey: string;
  parentChannelId: string;
  runId: string;
  label?: string;
  task: string;
  depth: number;
  totalSpawned: number;
}) => Promise<void>;

export type SubagentToolProgressCallback = (params: {
  parentChannelId: string;
  runId: string;
  label?: string;
  event: "tool_start" | "tool_end";
  toolName: string;
  meta?: string;
  durationMs?: number;
  error?: string;
  preview?: string;
}) => Promise<void>;

// ── Constants ──────────────────────────────────────────────────────────

export const MAX_SPAWN_DEPTH = 2;
export const MAX_CHILDREN_PER_SESSION = 5;
export const MAX_CONCURRENT_TOTAL = 10;

// ── Registry ───────────────────────────────────────────────────────────

export class SubagentRegistry {
  private runs = new Map<string, SubagentRunRecord>();
  private abortControllers = new Map<string, AbortController>();
  private storePath: string;

  constructor(agentDir: string) {
    this.storePath = path.join(agentDir, "subagent-registry.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.storePath, "utf-8");
      const records: SubagentRunRecord[] = JSON.parse(raw);
      for (const r of records) {
        // Mark stale running entries from previous process as errored
        if (r.status === "running") {
          r.status = "error";
          r.error = "Process restarted before completion";
          r.endedAt = Date.now();
        }
        this.runs.set(r.runId, r);
      }
      await this.persist();
    } catch {
      // no file or parse error — start fresh
    }
  }

  register(record: SubagentRunRecord): void {
    this.runs.set(record.runId, record);
    void this.persist();
  }

  setAbortController(runId: string, controller: AbortController): void {
    this.abortControllers.set(runId, controller);
  }

  removeAbortController(runId: string): void {
    this.abortControllers.delete(runId);
  }

  markComplete(runId: string, result: string, status: "ok" | "error"): void {
    const r = this.runs.get(runId);
    if (!r) return;
    r.status = status;
    r.result = result.slice(0, 10_000); // cap stored result
    r.endedAt = Date.now();
    if (status === "error") r.error = result.slice(0, 2000);
    this.abortControllers.delete(runId);
    void this.persist();
  }

  kill(runId: string): boolean {
    const r = this.runs.get(runId);
    if (!r || r.status !== "running") return false;

    // Abort the running session
    const controller = this.abortControllers.get(runId);
    if (controller) {
      controller.abort(new Error("Killed by parent agent"));
      this.abortControllers.delete(runId);
    }

    r.status = "killed";
    r.error = "Killed by parent agent";
    r.endedAt = Date.now();
    void this.persist();
    return true;
  }

  get(runId: string): SubagentRunRecord | undefined {
    return this.runs.get(runId);
  }

  listForSession(parentSessionKey: string): SubagentRunRecord[] {
    return [...this.runs.values()]
      .filter((r) => r.parentSessionKey === parentSessionKey)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  countActiveForSession(parentSessionKey: string): number {
    return [...this.runs.values()].filter(
      (r) => r.parentSessionKey === parentSessionKey && r.status === "running",
    ).length;
  }

  countActiveTotal(): number {
    return [...this.runs.values()].filter((r) => r.status === "running").length;
  }

  getDepthForSession(sessionKey: string): number {
    for (const r of this.runs.values()) {
      if (r.childSessionKey === sessionKey) {
        return r.depth;
      }
    }
    return 0;
  }

  canSpawn(parentSessionKey: string): { allowed: boolean; reason?: string } {
    const depth = this.getDepthForSession(parentSessionKey);
    if (depth >= MAX_SPAWN_DEPTH) {
      return {
        allowed: false,
        reason: `Max spawn depth reached (current depth ${depth}, max ${MAX_SPAWN_DEPTH}). You are a leaf worker and cannot spawn further subagents.`,
      };
    }
    const activeChildren = this.countActiveForSession(parentSessionKey);
    if (activeChildren >= MAX_CHILDREN_PER_SESSION) {
      return {
        allowed: false,
        reason: `Max children per session reached (${activeChildren}/${MAX_CHILDREN_PER_SESSION})`,
      };
    }
    const totalActive = this.countActiveTotal();
    if (totalActive >= MAX_CONCURRENT_TOTAL) {
      return {
        allowed: false,
        reason: `Max total concurrent subagents reached (${totalActive}/${MAX_CONCURRENT_TOTAL})`,
      };
    }
    return { allowed: true };
  }

  /** Remove completed runs older than maxAgeMs (default 1 hour). */
  cleanup(maxAgeMs = 3_600_000): void {
    const now = Date.now();
    let changed = false;
    for (const [id, r] of this.runs) {
      if (r.endedAt && now - r.endedAt > maxAgeMs) {
        this.runs.delete(id);
        changed = true;
      }
    }
    if (changed) void this.persist();
  }

  private async persist(): Promise<void> {
    try {
      const records = [...this.runs.values()];
      await fs.mkdir(path.dirname(this.storePath), { recursive: true });
      await fs.writeFile(this.storePath, JSON.stringify(records, null, 2));
    } catch {
      // ignore persistence failures
    }
  }
}

// ── Subagent System Prompt ─────────────────────────────────────────────

export function buildSubagentSystemPrompt(params: {
  parentSessionKey: string;
  childSessionKey: string;
  task: string;
  label?: string;
  depth: number;
  maxDepth: number;
}): string {
  const canSpawnMore = params.depth < params.maxDepth;
  const parentLabel = params.depth >= 2 ? "parent orchestrator" : "main agent";

  const lines = [
    "# Subagent Context",
    "",
    `You are a **subagent** spawned by the ${parentLabel} for a specific task.`,
    "",
    "## Your Role",
    `- You were created to handle: ${params.task}`,
    "- Complete this task. That's your entire purpose.",
    `- You are NOT the ${parentLabel}. Don't try to be.`,
    "",
    "## Rules",
    "1. **Stay focused** — Do your assigned task, nothing else",
    `2. **Complete the task** — Your final message will be automatically reported to the ${parentLabel}`,
    "3. **Don't initiate** — No heartbeats, no proactive actions, no side quests",
    "4. **Be ephemeral** — You may be terminated after task completion. That's fine.",
    "",
    "## Output Format",
    "When complete, your final response should include:",
    "- What you accomplished or found",
    `- Any relevant details the ${parentLabel} should know`,
    "- Keep it concise but informative",
    "",
    "## What You DON'T Do",
    `- NO user conversations (that's the ${parentLabel}'s job)`,
    "- NO external messages unless explicitly tasked with a specific recipient",
    "- NO cron jobs or persistent state",
    `- NO pretending to be the ${parentLabel}`,
    "",
  ];

  if (canSpawnMore) {
    lines.push(
      "## Sub-Agent Spawning",
      "You CAN spawn your own sub-agents for parallel work using the `subagent` tool.",
      "Your sub-agents will announce their results back to you automatically.",
      "Default workflow: spawn work, continue orchestrating, and wait for auto-announced completions.",
      "",
    );
  } else {
    lines.push(
      "## Sub-Agent Spawning",
      "You are a leaf worker and CANNOT spawn further sub-agents. Focus on your assigned task.",
      "",
    );
  }

  lines.push(
    "## Session Context",
    ...[
      params.label ? `- Label: ${params.label}` : undefined,
      `- Parent session: ${params.parentSessionKey}`,
      `- Your session: ${params.childSessionKey}`,
      `- Depth: ${params.depth}/${params.maxDepth}`,
    ].filter((l): l is string => l !== undefined),
    "",
  );

  return lines.join("\n");
}

// ── Progress Message Builder ────────────────────────────────────────────

export function buildSpawnProgressMessage(params: {
  label?: string;
  task: string;
  totalSpawned: number;
}): string {
  const taskLabel = params.label || params.task.slice(0, 60);
  const emoji = "🔄";
  
  if (params.totalSpawned === 1) {
    return `${emoji} Starting research subagent: **${taskLabel}**`;
  }
  return `${emoji} Spawned subagent ${params.totalSpawned}: **${taskLabel}**`;
}

// ── Announce Message Builder ───────────────────────────────────────────

function formatDurationShort(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

export function buildAnnounceMessage(params: {
  task: string;
  label?: string;
  status: "ok" | "error";
  result: string;
  startedAt: number;
  endedAt: number;
  remainingActiveChildren: number;
}): string {
  const taskLabel = params.label || params.task.slice(0, 80);
  const statusLabel =
    params.status === "ok" ? "completed successfully" : `failed: ${params.result.slice(0, 200)}`;
  const duration = formatDurationShort(params.endedAt - params.startedAt);
  const findings = params.result || "(no output)";

  const replyInstruction =
    params.remainingActiveChildren > 0
      ? `There are still ${params.remainingActiveChildren} active subagent run(s) for this session. If they are part of the same workflow, wait for the remaining results before sending a user update. If they are unrelated, respond normally using only the result above.`
      : `Convert this completion into a concise update for the user in your normal assistant voice. Keep internal context private (don't mention system/log/stats/session details). Reply ONLY: NO_REPLY if this exact result was already delivered.`;

  return [
    `[System Message] A subagent task "${taskLabel}" just ${statusLabel}. (runtime: ${duration})`,
    "",
    "Result:",
    findings,
    "",
    replyInstruction,
  ].join("\n");
}
