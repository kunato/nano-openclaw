import fs from "node:fs/promises";
import path from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

export interface HeartbeatConfig {
  /** Enable heartbeat (default: true). */
  enabled: boolean;
  /** Interval between heartbeats in ms (default: 30 min). */
  intervalMs: number;
  /** Minimum interval between two heartbeats in ms — prevents rapid-fire if
   *  the process restarts frequently (default: 10 min). */
  minIntervalMs: number;
}

export const defaultHeartbeatConfig: HeartbeatConfig = {
  enabled: true,
  intervalMs: 30 * 60 * 1000, // 30 min
  minIntervalMs: 10 * 60 * 1000, // 10 min
};

interface HeartbeatState {
  lastRunAtMs: number;
  lastError?: string;
  runCount: number;
}

export type HeartbeatCallback = (prompt: string) => Promise<string | null>;

// ── Heartbeat Service ──────────────────────────────────────────────────

/**
 * Proactive agent wake-up service.
 *
 * Periodically fires a workspace-aware prompt through the agent so it can:
 * - Check for pending tasks or reminders
 * - Review workspace state (file changes, new skills, etc.)
 * - Consolidate memory or perform maintenance
 * - Initiate proactive actions (e.g., following up on earlier research)
 *
 * The prompt is built from workspace context files (AGENTS.md, memory, etc.)
 * so the agent has enough context to decide what (if anything) to do.
 */
export class HeartbeatService {
  private config: HeartbeatConfig;
  private workspaceDir: string;
  private statePath: string;
  private state: HeartbeatState = { lastRunAtMs: 0, runCount: 0 };
  private timer?: ReturnType<typeof setInterval>;
  private onHeartbeat: HeartbeatCallback;
  private running = false;

  constructor(opts: {
    config: HeartbeatConfig;
    workspaceDir: string;
    agentDir: string;
    onHeartbeat: HeartbeatCallback;
  }) {
    this.config = opts.config;
    this.workspaceDir = opts.workspaceDir;
    this.statePath = path.join(opts.agentDir, "heartbeat-state.json");
    this.onHeartbeat = opts.onHeartbeat;
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      console.log("[heartbeat] Disabled");
      return;
    }

    await this.loadState();

    // Compute initial delay: respect minInterval since last run
    const sinceLastRun = Date.now() - this.state.lastRunAtMs;
    const initialDelay = Math.max(0, this.config.minIntervalMs - sinceLastRun);

    console.log(
      `[heartbeat] Starting (interval=${Math.round(this.config.intervalMs / 60_000)}m, ` +
      `first in ${Math.round(initialDelay / 60_000)}m, ` +
      `${this.state.runCount} previous runs)`,
    );

    // First tick after initial delay, then recurring
    setTimeout(async () => {
      await this.tick();
      this.timer = setInterval(() => this.tick(), this.config.intervalMs);
    }, initialDelay);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    console.log("[heartbeat] Stopped");
  }

  /** Force a heartbeat immediately (e.g., for testing). */
  async runNow(): Promise<string | null> {
    return this.execute();
  }

  // ── Internal ───────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.running) {
      console.log("[heartbeat] Skipping (previous heartbeat still running)");
      return;
    }

    // Guard against rapid fire (e.g., if timer drifts or process restarts)
    const sinceLastRun = Date.now() - this.state.lastRunAtMs;
    if (sinceLastRun < this.config.minIntervalMs) {
      return;
    }

    await this.execute();
  }

  private async execute(): Promise<string | null> {
    this.running = true;
    const startTime = Date.now();

    try {
      const prompt = await this.buildHeartbeatPrompt();
      console.log(`[heartbeat] Firing heartbeat #${this.state.runCount + 1}`);

      const result = await this.onHeartbeat(prompt);

      this.state.lastRunAtMs = Date.now();
      this.state.runCount++;
      this.state.lastError = undefined;
      await this.saveState();

      const elapsed = Date.now() - startTime;
      console.log(`[heartbeat] Completed in ${elapsed}ms`);

      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.state.lastError = errMsg;
      this.state.lastRunAtMs = Date.now();
      await this.saveState();
      console.error(`[heartbeat] Error: ${errMsg}`);
      return null;
    } finally {
      this.running = false;
    }
  }

  /**
   * Build a workspace-aware prompt for the heartbeat.
   *
   * Reads workspace context files to give the agent enough information
   * to decide what proactive actions (if any) to take.
   */
  private async buildHeartbeatPrompt(): Promise<string> {
    const sections: string[] = [];

    sections.push(
      "[HEARTBEAT] This is a periodic proactive wake-up. " +
      "Review your workspace, memory, and any pending tasks. " +
      "Take action if something needs attention — otherwise respond briefly that all is well.",
    );

    // Read MEMORY.md for context
    const memoryPath = path.join(this.workspaceDir, "memory", "MEMORY.md");
    const memory = await this.safeRead(memoryPath);
    if (memory) {
      sections.push(`Current memory:\n${memory.slice(0, 2000)}`);
    }

    // Read HISTORY.md for recent events
    const historyPath = path.join(this.workspaceDir, "memory", "HISTORY.md");
    const history = await this.safeRead(historyPath);
    if (history) {
      // Only include the last ~1000 chars (most recent events)
      const tail = history.slice(-1000);
      sections.push(`Recent history:\n${tail}`);
    }

    // Check for any TODO or TASKS files
    const todoPath = path.join(this.workspaceDir, "TODO.md");
    const todo = await this.safeRead(todoPath);
    if (todo) {
      sections.push(`Active TODO:\n${todo.slice(0, 1500)}`);
    }

    sections.push(
      `Time: ${new Date().toISOString()}`,
      `Heartbeat #${this.state.runCount + 1}`,
    );

    return sections.join("\n\n");
  }

  private async safeRead(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  private async loadState(): Promise<void> {
    try {
      const raw = await fs.readFile(this.statePath, "utf-8");
      this.state = JSON.parse(raw);
    } catch {
      this.state = { lastRunAtMs: 0, runCount: 0 };
    }
  }

  private async saveState(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.statePath), { recursive: true });
      await fs.writeFile(this.statePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error(`[heartbeat] Failed to save state: ${err}`);
    }
  }
}
