import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Cron } from "croner";

// ── Types ──────────────────────────────────────────────────────────────

export type ScheduleAt = { kind: "at"; at: string }; // ISO-8601 timestamp
export type ScheduleCron = {
  kind: "cron";
  expr: string; // cron expression (e.g. "0 19 * * *")
  tz?: string; // IANA timezone (e.g. "Asia/Bangkok")
};
export type Schedule = ScheduleAt | ScheduleCron;

export type JobPayload =
  | { kind: "systemEvent"; text: string } // Simple text message
  | { kind: "agentTurn"; message: string }; // Full agent turn (can use tools)

export interface ScheduledJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun: boolean;
  schedule: Schedule;
  payload: JobPayload;
  sessionKey: string; // target session/channel to deliver to
  createdAt: string;
  lastRunAt?: string;
  lastError?: string;
  runCount: number;
}

export type JobFireCallback = (
  job: ScheduledJob,
) => Promise<void>;

// ── Store file ─────────────────────────────────────────────────────────

interface StoreFile {
  version: 1;
  jobs: ScheduledJob[];
}

// ── Scheduler ──────────────────────────────────────────────────────────

export class Scheduler {
  private storePath: string;
  private jobs: ScheduledJob[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private cronInstances = new Map<string, Cron>();
  private onFire: JobFireCallback;
  private tickInterval?: ReturnType<typeof setInterval>;

  constructor(storePath: string, onFire: JobFireCallback) {
    this.storePath = storePath;
    this.onFire = onFire;
  }

  async start(): Promise<void> {
    await this.load();
    this.armAll();
    // Safety tick every 60s to catch any missed jobs
    this.tickInterval = setInterval(() => this.checkDueAtJobs(), 60_000);
    console.log(
      `[scheduler] Started with ${this.jobs.length} job(s) from ${this.storePath}`,
    );
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const cron of this.cronInstances.values()) cron.stop();
    this.cronInstances.clear();
    if (this.tickInterval) clearInterval(this.tickInterval);
  }

  // ── Public API (called by the tool) ────────────────────────────────

  async add(input: {
    name: string;
    description?: string;
    schedule: Schedule;
    payload: JobPayload;
    sessionKey: string;
    deleteAfterRun?: boolean;
  }): Promise<ScheduledJob> {
    const job: ScheduledJob = {
      id: randomUUID(),
      name: input.name,
      description: input.description,
      enabled: true,
      deleteAfterRun:
        input.deleteAfterRun ?? input.schedule.kind === "at", // one-shots auto-delete
      schedule: input.schedule,
      payload: input.payload,
      sessionKey: input.sessionKey,
      createdAt: new Date().toISOString(),
      runCount: 0,
    };
    this.jobs.push(job);
    await this.persist();
    this.arm(job);
    return job;
  }

  async remove(id: string): Promise<boolean> {
    const idx = this.jobs.findIndex((j) => j.id === id);
    if (idx === -1) return false;
    this.disarm(id);
    this.jobs.splice(idx, 1);
    await this.persist();
    return true;
  }

  async update(
    id: string,
    patch: Partial<Pick<ScheduledJob, "name" | "description" | "enabled" | "schedule" | "payload">>,
  ): Promise<ScheduledJob | null> {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return null;
    if (patch.name !== undefined) job.name = patch.name;
    if (patch.description !== undefined) job.description = patch.description;
    if (patch.enabled !== undefined) job.enabled = patch.enabled;
    if (patch.schedule !== undefined) job.schedule = patch.schedule;
    if (patch.payload !== undefined) job.payload = patch.payload;
    this.disarm(id);
    if (job.enabled) this.arm(job);
    await this.persist();
    return job;
  }

  list(opts?: { includeDisabled?: boolean }): ScheduledJob[] {
    if (opts?.includeDisabled) return [...this.jobs];
    return this.jobs.filter((j) => j.enabled);
  }

  get(id: string): ScheduledJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  // ── Internal ───────────────────────────────────────────────────────

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.storePath, "utf-8");
      const store: StoreFile = JSON.parse(raw);
      this.jobs = store.jobs ?? [];
    } catch {
      this.jobs = [];
    }
  }

  private async persist(): Promise<void> {
    const store: StoreFile = { version: 1, jobs: this.jobs };
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await fs.writeFile(this.storePath, JSON.stringify(store, null, 2));
  }

  private armAll(): void {
    for (const job of this.jobs) {
      if (job.enabled) this.arm(job);
    }
  }

  private arm(job: ScheduledJob): void {
    this.disarm(job.id);

    if (job.schedule.kind === "at") {
      const targetMs = new Date(job.schedule.at).getTime();
      const delayMs = targetMs - Date.now();
      if (delayMs <= 0) {
        // Already past — fire immediately
        this.fireJob(job);
      } else {
        this.timers.set(
          job.id,
          setTimeout(() => this.fireJob(job), delayMs),
        );
      }
    } else if (job.schedule.kind === "cron") {
      try {
        const cron = new Cron(job.schedule.expr, {
          timezone: job.schedule.tz,
        }, () => {
          this.fireJob(job);
        });
        this.cronInstances.set(job.id, cron);
      } catch (err) {
        console.error(
          `[scheduler] Invalid cron expression for job ${job.id}: ${err}`,
        );
      }
    }
  }

  private disarm(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    const cron = this.cronInstances.get(id);
    if (cron) {
      cron.stop();
      this.cronInstances.delete(id);
    }
  }

  private async fireJob(job: ScheduledJob): Promise<void> {
    console.log(`[scheduler] Firing job: ${job.name} (${job.id})`);
    job.lastRunAt = new Date().toISOString();
    job.runCount++;

    try {
      await this.onFire(job);
      job.lastError = undefined;
    } catch (err) {
      job.lastError = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Job ${job.id} error:`, err);
    }

    if (job.deleteAfterRun) {
      this.disarm(job.id);
      this.jobs = this.jobs.filter((j) => j.id !== job.id);
    }

    await this.persist();
  }

  private checkDueAtJobs(): void {
    const now = Date.now();
    for (const job of this.jobs) {
      if (!job.enabled) continue;
      if (job.schedule.kind !== "at") continue;
      const targetMs = new Date(job.schedule.at).getTime();
      if (now >= targetMs && !this.timers.has(job.id)) {
        this.fireJob(job);
      }
    }
  }
}
