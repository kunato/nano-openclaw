import type { Scheduler, Schedule, JobPayload } from "../scheduler.js";
import type { NanoToolDefinition } from "./types.js";
import { textResult, jsonTextResult } from "./types.js";

const ACTIONS = ["add", "list", "remove", "update"] as const;

export function createReminderTool(scheduler: Scheduler, sessionKey: string): NanoToolDefinition {
  return {
    name: "cron",
    label: "Cron / Reminders",
    description: `Manage scheduled jobs and reminders.

ACTIONS:
- add: Create a new scheduled job
- list: List all active jobs
- remove: Delete a job by id
- update: Update a job (requires id + fields to update)

SCHEDULE TYPES:
- One-shot: { "kind": "at", "at": "<ISO-8601 timestamp>" }
  Example: { "kind": "at", "at": "2025-02-18T19:00:00+07:00" }
- Recurring cron: { "kind": "cron", "expr": "<cron-expression>", "tz": "<IANA timezone>" }
  Example: { "kind": "cron", "expr": "0 19 * * *", "tz": "Asia/Bangkok" } (every day at 7pm Bangkok time)

CRON EXPRESSION FORMAT: minute hour day-of-month month day-of-week
  - "0 19 * * *" = every day at 19:00
  - "0 9 * * 1-5" = weekdays at 09:00
  - "*/30 * * * *" = every 30 minutes
  - "0 19 * * 1,3,5" = Mon/Wed/Fri at 19:00

PAYLOAD TYPES:
- systemEvent: Just send a text message
  { "kind": "systemEvent", "text": "Time to exercise! 🏃" }
- agentTurn: Run the agent with a prompt (can use tools like web_search, web_fetch, etc.)
  { "kind": "agentTurn", "message": "Search for today's weather in Bangkok and send a morning briefing" }

Use agentTurn when the job needs to do research, search the web, or perform complex tasks before sending.
Use systemEvent for simple reminder messages.

EXAMPLES:
- Daily exercise reminder at 7pm Bangkok time:
  { "action": "add", "name": "exercise-reminder", "schedule": { "kind": "cron", "expr": "0 19 * * *", "tz": "Asia/Bangkok" }, "payload": { "kind": "systemEvent", "text": "Reminder: Time to exercise! 🏃‍♂️ Stay consistent with your workout routine." } }

- Daily morning briefing with web search:
  { "action": "add", "name": "morning-briefing", "schedule": { "kind": "cron", "expr": "0 8 * * *", "tz": "Asia/Bangkok" }, "payload": { "kind": "agentTurn", "message": "Search for today's top tech news and Bangkok weather, then send a concise morning briefing." } }

- One-shot reminder:
  { "action": "add", "name": "meeting-reminder", "schedule": { "kind": "at", "at": "2025-02-18T14:00:00+07:00" }, "payload": { "kind": "systemEvent", "text": "Your meeting starts in 30 minutes!" } }`,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...ACTIONS],
          description: "Action to perform",
        },
        name: {
          type: "string",
          description: "Job name (for add)",
        },
        description: {
          type: "string",
          description: "Job description (optional)",
        },
        id: {
          type: "string",
          description: "Job ID (for remove/update)",
        },
        schedule: {
          type: "object",
          description: "Schedule config (for add/update)",
        },
        payload: {
          type: "object",
          description: "Payload config (for add/update)",
        },
        deleteAfterRun: {
          type: "boolean",
          description: "Delete job after it runs (default: true for at, false for cron)",
        },
        enabled: {
          type: "boolean",
          description: "Enable/disable job (for update)",
        },
      },
      required: ["action"],
    },
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = String(params.action ?? "");

      switch (action) {
        case "add": {
          const name = String(params.name ?? "unnamed");
          const schedule = params.schedule as Schedule | undefined;
          const payload = params.payload as JobPayload | undefined;

          if (!schedule || !schedule.kind) {
            return textResult("Error: schedule is required with kind 'at' or 'cron'");
          }
          if (!payload || !payload.kind) {
            return textResult("Error: payload is required with kind 'systemEvent' or 'agentTurn'");
          }

          const job = await scheduler.add({
            name,
            description: params.description as string | undefined,
            schedule,
            payload,
            sessionKey,
            deleteAfterRun: params.deleteAfterRun as boolean | undefined,
          });

          return jsonTextResult({
            status: "created",
            job: formatJob(job),
          });
        }

        case "list": {
          const jobs = scheduler.list({ includeDisabled: true });
          return jsonTextResult({
            count: jobs.length,
            jobs: jobs.map(formatJob),
          });
        }

        case "remove": {
          const id = String(params.id ?? "");
          if (!id) return textResult("Error: id is required");
          const removed = await scheduler.remove(id);
          return jsonTextResult({
            status: removed ? "removed" : "not_found",
            id,
          });
        }

        case "update": {
          const id = String(params.id ?? "");
          if (!id) return textResult("Error: id is required");
          const patch: Record<string, unknown> = {};
          if (params.name !== undefined) patch.name = params.name;
          if (params.description !== undefined) patch.description = params.description;
          if (params.enabled !== undefined) patch.enabled = params.enabled;
          if (params.schedule !== undefined) patch.schedule = params.schedule;
          if (params.payload !== undefined) patch.payload = params.payload;

          const job = await scheduler.update(id, patch as never);
          if (!job) return jsonTextResult({ status: "not_found", id });
          return jsonTextResult({ status: "updated", job: formatJob(job) });
        }

        default:
          return textResult(`Error: unknown action "${action}". Use: ${ACTIONS.join(", ")}`);
      }
    },
  };
}

function formatJob(job: {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun: boolean;
  schedule: Schedule;
  payload: JobPayload;
  sessionKey: string;
  createdAt: string;
  lastRunAt?: string;
  lastError?: string;
  runCount: number;
}) {
  return {
    id: job.id,
    name: job.name,
    description: job.description,
    enabled: job.enabled,
    deleteAfterRun: job.deleteAfterRun,
    schedule: job.schedule,
    payloadKind: job.payload.kind,
    payloadText:
      job.payload.kind === "systemEvent"
        ? job.payload.text.slice(0, 100)
        : job.payload.message.slice(0, 100),
    sessionKey: job.sessionKey,
    createdAt: job.createdAt,
    lastRunAt: job.lastRunAt,
    lastError: job.lastError,
    runCount: job.runCount,
  };
}
