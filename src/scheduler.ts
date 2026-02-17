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
export type ScheduleEvery = {
  kind: "every";
  intervalMs: number; // e.g. 3_600_000 for every hour
};
export type Schedule = ScheduleAt | ScheduleCron | ScheduleEvery;

export type JobPayload =
  | { kind: "systemEvent"; text: string } // Simple text message
  | { kind: "agentTurn"; message: string }; // Full agent turn (can use tools)

export interface JobState {
  nextRunAtMs?: number;
  consecutiveFailures: number;
  lastRetryAtMs?: number;
}

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
  state: JobState;
}

export type JobFireCallback = (
  job: ScheduledJob,
) => Promise<void>;

export interface SchedulerOptions {
  /** Max concurrent job executions (default: 3). */
  maxConcurrency?: number;
  /** Per-job execution timeout in ms (default: 5 min). */
  jobTimeoutMs?: number;
  /** Consecutive failures before auto-disabling a job (default: 5). */
  maxConsecutiveFailures?: number;
  /** Max retry attempts per failure before counting as a consecutive failure (default: 2). */
  maxRetries?: number;
  /** Base delay for exponential backoff retries in ms (default: 5000). */
  retryBaseDelayMs?: number;
}

// ── Store file ─────────────────────────────────────────────────────────

interface StoreFile {
  version: 2;
  jobs: ScheduledJob[];
}

const DEFAULT_OPTIONS: Required<SchedulerOptions> = {
  maxConcurrency: 3,
  jobTimeoutMs: 5 * 60 * 1000, // 5 min
  maxConsecutiveFailures: 5,
  maxRetries: 2,
  retryBaseDelayMs: 5_000,
};

// ── Scheduler ──────────────────────────────────────────────────────────

export class Scheduler {
  private storePath: string;
  private jobs: ScheduledJob[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private cronInstances = new Map<string, Cron>();
  private everyTimers = new Map<string, ReturnType<typeof setInterval>>();
  private onFire: JobFireCallback;
  private tickInterval?: ReturnType<typeof setInterval>;
  private opts: Required<SchedulerOptions>;

  // Concurrency guard
  private runningJobs = new Set<string>();
  private pendingQueue: ScheduledJob[] = [];

  constructor(storePath: string, onFire: JobFireCallback, opts?: SchedulerOptions) {
    this.storePath = storePath;
    this.onFire = onFire;
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  async start(): Promise<void> {
    await this.load();
    this.recoverMissedJobs();
    this.armAll();
    // Safety tick every 60s to catch any missed jobs
    this.tickInterval = setInterval(() => this.tick(), 60_000);
    const enabled = this.jobs.filter((j) => j.enabled).length;
    console.log(
      `[scheduler] Started with ${this.jobs.length} job(s) (${enabled} enabled) from ${this.storePath}`,
    );
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const cron of this.cronInstances.values()) cron.stop();
    this.cronInstances.clear();
    for (const timer of this.everyTimers.values()) clearInterval(timer);
    this.everyTimers.clear();
    if (this.tickInterval) clearInterval(this.tickInterval);
    this.pendingQueue = [];
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
      state: { consecutiveFailures: 0 },
    };
    this.computeNextRun(job);
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
    if (patch.enabled !== undefined) {
      job.enabled = patch.enabled;
      // Reset failure count when re-enabling
      if (patch.enabled) job.state.consecutiveFailures = 0;
    }
    if (patch.schedule !== undefined) job.schedule = patch.schedule;
    if (patch.payload !== undefined) job.payload = patch.payload;
    this.disarm(id);
    this.computeNextRun(job);
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

  /** Manually trigger a job (bypasses schedule). */
  async runNow(id: string): Promise<boolean> {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return false;
    await this.executeJob(job);
    return true;
  }

  /** Summary for status checks. */
  status(): { total: number; enabled: number; running: number; queued: number } {
    return {
      total: this.jobs.length,
      enabled: this.jobs.filter((j) => j.enabled).length,
      running: this.runningJobs.size,
      queued: this.pendingQueue.length,
    };
  }

  // ── Internal ───────────────────────────────────────────────────────

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.storePath, "utf-8");
      const store = JSON.parse(raw) as { version?: number; jobs?: ScheduledJob[] };
      this.jobs = (store.jobs ?? []).map((j) => ({
        ...j,
        // Migrate from v1 (no state field)
        state: j.state ?? { consecutiveFailures: 0 },
      }));
    } catch {
      this.jobs = [];
    }
  }

  private async persist(): Promise<void> {
    const store: StoreFile = { version: 2, jobs: this.jobs };
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    const tmp = this.storePath + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(store, null, 2));
    await fs.rename(tmp, this.storePath);
  }

  /** Compute and set nextRunAtMs for a job based on its schedule. */
  private computeNextRun(job: ScheduledJob): void {
    const now = Date.now();
    switch (job.schedule.kind) {
      case "at":
        job.state.nextRunAtMs = new Date(job.schedule.at).getTime();
        break;
      case "cron": {
        try {
          const cron = new Cron(job.schedule.expr, { timezone: job.schedule.tz });
          const next = cron.nextRun();
          job.state.nextRunAtMs = next ? next.getTime() : undefined;
          cron.stop();
        } catch {
          job.state.nextRunAtMs = undefined;
        }
        break;
      }
      case "every":
        job.state.nextRunAtMs = now + job.schedule.intervalMs;
        break;
    }
  }

  /** On startup, fire any 'at' jobs that were missed while offline. */
  private recoverMissedJobs(): void {
    const now = Date.now();
    for (const job of this.jobs) {
      if (!job.enabled) continue;
      if (job.schedule.kind === "at") {
        const targetMs = new Date(job.schedule.at).getTime();
        if (now >= targetMs && job.runCount === 0) {
          console.log(`[scheduler] Recovering missed job: ${job.name} (${job.id})`);
          this.enqueueExecution(job);
        }
      }
    }
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
        this.enqueueExecution(job);
      } else {
        this.timers.set(
          job.id,
          setTimeout(() => this.enqueueExecution(job), delayMs),
        );
      }
    } else if (job.schedule.kind === "cron") {
      try {
        const cron = new Cron(job.schedule.expr, {
          timezone: job.schedule.tz,
        }, () => {
          this.computeNextRun(job);
          this.enqueueExecution(job);
        });
        this.cronInstances.set(job.id, cron);
      } catch (err) {
        console.error(
          `[scheduler] Invalid cron expression for job ${job.id}: ${err}`,
        );
      }
    } else if (job.schedule.kind === "every") {
      const timer = setInterval(() => {
        this.computeNextRun(job);
        this.enqueueExecution(job);
      }, job.schedule.intervalMs);
      this.everyTimers.set(job.id, timer);
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
    const everyTimer = this.everyTimers.get(id);
    if (everyTimer) {
      clearInterval(everyTimer);
      this.everyTimers.delete(id);
    }
  }

  // ── Concurrency-guarded execution ──────────────────────────────────

  private enqueueExecution(job: ScheduledJob): void {
    if (this.runningJobs.size < this.opts.maxConcurrency) {
      this.runningJobs.add(job.id);
      this.executeJob(job).finally(() => {
        this.runningJobs.delete(job.id);
        this.drainQueue();
      });
    } else {
      // Already queued? Don't double-queue
      if (!this.pendingQueue.some((j) => j.id === job.id)) {
        this.pendingQueue.push(job);
        console.log(
          `[scheduler] Job ${job.name} queued (${this.runningJobs.size}/${this.opts.maxConcurrency} running)`,
        );
      }
    }
  }

  private drainQueue(): void {
    while (
      this.pendingQueue.length > 0 &&
      this.runningJobs.size < this.opts.maxConcurrency
    ) {
      const next = this.pendingQueue.shift()!;
      this.runningJobs.add(next.id);
      this.executeJob(next).finally(() => {
        this.runningJobs.delete(next.id);
        this.drainQueue();
      });
    }
  }

  // ── Job execution with timeout + retry ─────────────────────────────

  private async executeJob(job: ScheduledJob): Promise<void> {
    console.log(`[scheduler] Firing job: ${job.name} (${job.id})`);
    job.lastRunAt = new Date().toISOString();
    job.runCount++;

    let succeeded = false;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      try {
        await this.executeWithTimeout(job);
        succeeded = true;
        job.lastError = undefined;
        job.state.consecutiveFailures = 0;
        break;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        job.lastError = errMsg;
        console.error(
          `[scheduler] Job ${job.id} attempt ${attempt} failed: ${errMsg}`,
        );

        // Don't retry on timeout — the job likely hung
        if (errMsg.includes("timed out")) break;

        if (attempt < this.opts.maxRetries) {
          const delay = this.opts.retryBaseDelayMs * 2 ** attempt;
          console.log(`[scheduler] Retrying job ${job.id} in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    if (!succeeded) {
      job.state.consecutiveFailures++;
      job.state.lastRetryAtMs = Date.now();

      // Auto-disable after too many consecutive failures
      if (job.state.consecutiveFailures >= this.opts.maxConsecutiveFailures) {
        job.enabled = false;
        this.disarm(job.id);
        console.error(
          `[scheduler] Job ${job.id} auto-disabled after ${job.state.consecutiveFailures} consecutive failures`,
        );
      }
    }

    if (job.deleteAfterRun) {
      this.disarm(job.id);
      this.jobs = this.jobs.filter((j) => j.id !== job.id);
    } else {
      this.computeNextRun(job);
    }

    await this.persist();
  }

  private executeWithTimeout(job: ScheduledJob): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Job ${job.id} timed out after ${this.opts.jobTimeoutMs}ms`));
      }, this.opts.jobTimeoutMs);

      this.onFire(job)
        .then(resolve, reject)
        .finally(() => clearTimeout(timer));
    });
  }

  /** Safety tick: catch missed at jobs + stale every timers. */
  private tick(): void {
    const now = Date.now();
    for (const job of this.jobs) {
      if (!job.enabled) continue;
      if (job.schedule.kind === "at") {
        const targetMs = new Date(job.schedule.at).getTime();
        if (now >= targetMs && !this.timers.has(job.id) && !this.runningJobs.has(job.id)) {
          this.enqueueExecution(job);
        }
      }
    }
  }
}
