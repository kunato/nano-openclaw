import { textResult, jsonTextResult } from "./types.js";
import type { NanoToolDefinition } from "./types.js";
import type { SubagentRegistry } from "../subagent.js";

export interface SubagentSpawnFn {
  (params: {
    task: string;
    parentSessionKey: string;
    parentChannelId: string;
    label?: string;
  }): Promise<{ runId: string; childSessionKey: string }>;
}

export function createSubagentTool(
  registry: SubagentRegistry,
  spawnFn: SubagentSpawnFn,
  sessionKey: string,
  channelId: string,
): NanoToolDefinition {
  return {
    name: "subagent",
    label: "Subagents",
    description: [
      "Spawn, monitor, and manage background sub-agent runs that execute in parallel isolated sessions.",
      "",
      "Actions:",
      "  spawn  - Launch a new subagent for a task (requires: task, optional: label)",
      "         The subagent runs in the background. Its result will be auto-announced",
      "         back to your session when it completes. You can continue working.",
      "  list   - List all subagent runs spawned from this session (shows status, result preview)",
      "  kill   - Abort a running subagent by its runId (requires: id)",
      "",
      "Usage patterns:",
      "  • Parallel research: spawn multiple subagents for different topics, synthesize when all complete",
      "  • Background tasks: spawn a long-running task and continue the conversation",
      "  • Fan-out: break a large task into subtasks, spawn each, collect results",
      "",
      "Results are auto-announced — you do NOT need to poll. When a subagent finishes,",
      "a system message with its result will appear in your session automatically.",
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["spawn", "list", "kill"],
          description: "The action to perform",
        },
        task: {
          type: "string",
          description: "Task description for the subagent (spawn action)",
        },
        label: {
          type: "string",
          description: "Short human-readable label for the subagent run (spawn action, optional)",
        },
        id: {
          type: "string",
          description: "Run ID of the subagent to kill (kill action)",
        },
      },
    },
    execute: async (
      _toolCallId: string,
      params: unknown,
    ): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const p = params as Record<string, unknown>;
      const action = p.action as string;

      try {
        switch (action) {
          case "spawn": {
            const task = p.task as string;
            if (!task) {
              return textResult("Error: task is required for spawn action");
            }
            const label = typeof p.label === "string" ? p.label.trim() : undefined;

            // Check limits before spawning
            const check = registry.canSpawn(sessionKey);
            if (!check.allowed) {
              return jsonTextResult({
                status: "forbidden",
                error: check.reason,
              });
            }

            const { runId, childSessionKey } = await spawnFn({
              task,
              parentSessionKey: sessionKey,
              parentChannelId: channelId,
              label,
            });

            return jsonTextResult({
              status: "accepted",
              runId,
              childSessionKey,
              message: "Subagent spawned. Its result will be auto-announced to your session when complete.",
            });
          }

          case "list": {
            const runs = registry.listForSession(sessionKey);
            if (runs.length === 0) {
              return jsonTextResult({
                status: "ok",
                message: "No subagent runs found for this session.",
                runs: [],
              });
            }
            const summary = runs.map((r) => ({
              runId: r.runId,
              label: r.label,
              task: r.task.slice(0, 100),
              status: r.status,
              depth: r.depth,
              createdAt: new Date(r.createdAt).toISOString(),
              endedAt: r.endedAt ? new Date(r.endedAt).toISOString() : undefined,
              resultPreview: r.result ? r.result.slice(0, 200) : undefined,
              error: r.error ? r.error.slice(0, 200) : undefined,
            }));
            const active = runs.filter((r) => r.status === "running").length;
            return jsonTextResult({
              status: "ok",
              total: runs.length,
              active,
              runs: summary,
            });
          }

          case "kill": {
            const id = p.id as string;
            if (!id) {
              return textResult("Error: id (runId) is required for kill action");
            }
            const killed = registry.kill(id);
            return jsonTextResult({
              status: killed ? "killed" : "not_found",
              runId: id,
              message: killed
                ? "Subagent run aborted."
                : "No running subagent found with that ID.",
            });
          }

          default:
            return textResult(`Error: unknown action "${action}". Use spawn, list, or kill.`);
        }
      } catch (err) {
        return textResult(
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
