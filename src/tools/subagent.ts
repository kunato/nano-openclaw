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
      "  spawn    - Launch a new subagent for a task (requires: task, optional: label)",
      "           The subagent runs in the background. Its result will be auto-announced",
      "           back to your session when it completes. You can continue working.",
      "  research - Launch multiple parallel subagents for deep research (requires: topic)",
      "           Spawns 3-5 subagents with different research angles on the same topic.",
      "           Each searches and fetches from different source types.",
      "  list     - List all subagent runs spawned from this session (shows status, result preview)",
      "  kill     - Abort a running subagent by its runId (requires: id)",
      "",
      "Usage patterns:",
      "  • Deep research: use 'research' action for comprehensive multi-source investigation",
      "  • Parallel tasks: spawn multiple subagents for different topics, synthesize when all complete",
      "  • Background work: spawn a long-running task and continue the conversation",
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
          enum: ["spawn", "research", "list", "kill"],
          description: "The action to perform",
        },
        topic: {
          type: "string",
          description: "Research topic for the research action",
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

          case "research": {
            const topic = p.topic as string;
            console.log(`[subagent.research] Research action called with topic="${topic}", sessionKey="${sessionKey}", channelId="${channelId}"`);
            if (!topic) {
              console.log(`[subagent.research] ERROR: topic is missing`);
              return textResult("Error: topic is required for research action");
            }

            // Check if we can spawn multiple subagents
            const check = registry.canSpawn(sessionKey);
            console.log(`[subagent.research] canSpawn check: allowed=${check.allowed}, reason=${check.reason || 'none'}`);
            if (!check.allowed) {
              return jsonTextResult({
                status: "forbidden",
                error: check.reason,
              });
            }

            // Define research angles for comprehensive coverage
            const researchAngles = buildResearchAngles(topic);
            console.log(`[subagent.research] Built ${researchAngles.length} research angles: ${researchAngles.map(a => a.type).join(', ')}`);
            const spawnedRuns: Array<{ runId: string; angle: string; label: string }> = [];

            for (const angle of researchAngles) {
              // Check limits before each spawn
              const angleCheck = registry.canSpawn(sessionKey);
              if (!angleCheck.allowed) {
                console.log(`[subagent.research] canSpawn blocked for angle ${angle.type}: ${angleCheck.reason}`);
                break; // Stop spawning if we hit limits
              }

              try {
                console.log(`[subagent.research] Spawning angle: ${angle.type} (label=${angle.label})`);
                const { runId } = await spawnFn({
                  task: angle.task,
                  parentSessionKey: sessionKey,
                  parentChannelId: channelId,
                  label: angle.label,
                });
                console.log(`[subagent.research] Spawned ${angle.type}: runId=${runId}`);
                spawnedRuns.push({ runId, angle: angle.type, label: angle.label });
              } catch (err) {
                console.warn(`[subagent.research] Failed to spawn ${angle.type}:`, err);
              }
            }

            console.log(`[subagent.research] Total spawned: ${spawnedRuns.length}/${researchAngles.length}`);

            if (spawnedRuns.length === 0) {
              return jsonTextResult({
                status: "error",
                error: "Failed to spawn any research subagents",
              });
            }

            return jsonTextResult({
              status: "accepted",
              topic,
              spawned: spawnedRuns.length,
              runs: spawnedRuns,
              message: `Spawned ${spawnedRuns.length} research subagents. Results will be auto-announced as they complete.`,
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
            return textResult(`Error: unknown action "${action}". Use spawn, research, list, or kill.`);
        }
      } catch (err) {
        return textResult(
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

interface ResearchAngle {
  type: string;
  label: string;
  task: string;
}

/**
 * Build research angles for comprehensive topic coverage.
 * Each angle targets a different source type or perspective.
 */
function buildResearchAngles(topic: string): ResearchAngle[] {
  return [
    {
      type: "academic",
      label: `research:academic:${topic.slice(0, 20)}`,
      task: [
        `Deep research task: "${topic}" - ACADEMIC SOURCES`,
        "",
        "You are a research subagent. Your job is to gather comprehensive information from academic sources.",
        "",
        "REQUIRED STEPS (do ALL of these):",
        "1. web_search: Find 3-5 academic papers, research studies, or scholarly articles",
        "   - Search queries: include 'site:arxiv.org', 'site:scholar.google.com', 'research paper', 'study'",
        "",
        "2. web_fetch: Extract FULL CONTENT from the top 2-3 results",
        "   - For arxiv, fetch the abstract page or PDF",
        "   - For other papers, fetch the full article",
        "   - DO NOT skip this step - you MUST fetch and read actual content",
        "",
        "3. Summarize findings with:",
        "   - Key findings and conclusions",
        "   - Methodologies used",
        "   - Data/statistics mentioned",
        "   - Full URL citations for every source",
        "",
        "Output format: Structured summary with [Source: URL] citations after each claim.",
      ].join("\n"),
    },
    {
      type: "official",
      label: `research:official:${topic.slice(0, 20)}`,
      task: [
        `Deep research task: "${topic}" - OFFICIAL/AUTHORITATIVE SOURCES`,
        "",
        "You are a research subagent. Your job is to gather comprehensive information from official sources.",
        "",
        "REQUIRED STEPS (do ALL of these):",
        "1. web_search: Find 3-5 official sources",
        "   - Search queries: include 'official', 'documentation', 'site:.gov', company names",
        "   - Look for: official docs, government sites, company blogs, press releases",
        "",
        "2. web_fetch: Extract FULL CONTENT from the top 2-3 results",
        "   - Fetch official documentation pages",
        "   - Fetch announcement or press release pages",
        "   - DO NOT skip this step - you MUST fetch and read actual content",
        "",
        "3. Summarize findings with:",
        "   - Official positions and statements",
        "   - Technical specifications or guidelines",
        "   - Dates and version information",
        "   - Full URL citations for every source",
        "",
        "Output format: Structured summary with [Source: URL] citations after each claim.",
      ].join("\n"),
    },
    {
      type: "community",
      label: `research:community:${topic.slice(0, 20)}`,
      task: [
        `Deep research task: "${topic}" - COMMUNITY/PRACTITIONER PERSPECTIVES`,
        "",
        "You are a research subagent. Your job is to gather real-world experiences and practical insights.",
        "",
        "REQUIRED STEPS (do ALL of these):",
        "1. web_search: Find 3-5 community sources",
        "   - Search queries: include 'reddit', 'stack overflow', 'tutorial', 'experience', 'review'",
        "   - Look for: blog posts, forum discussions, tutorials, case studies",
        "",
        "2. web_fetch: Extract FULL CONTENT from the top 2-3 results",
        "   - Fetch blog posts and tutorials",
        "   - Fetch discussion threads (use useFirecrawl:true for Reddit/Twitter)",
        "   - DO NOT skip this step - you MUST fetch and read actual content",
        "",
        "3. Summarize findings with:",
        "   - Practical tips and best practices",
        "   - Common issues and pitfalls",
        "   - Community consensus vs. controversial opinions",
        "   - Full URL citations for every source",
        "",
        "Output format: Structured summary with [Source: URL] citations after each claim.",
      ].join("\n"),
    },
    {
      type: "news",
      label: `research:news:${topic.slice(0, 20)}`,
      task: [
        `Deep research task: "${topic}" - RECENT NEWS AND DEVELOPMENTS`,
        "",
        "You are a research subagent. Your job is to gather the latest news and recent developments.",
        "",
        "REQUIRED STEPS (do ALL of these):",
        "1. web_search: Find 3-5 recent news articles",
        "   - Search queries: include 'news', '2024', '2025', 'latest', 'announced'",
        "   - Look for: news sites, tech publications, industry reports",
        "",
        "2. web_fetch: Extract FULL CONTENT from the top 2-3 results",
        "   - Fetch full article text (not just headlines)",
        "   - Use useFirecrawl:true for paywalled or JS-heavy news sites",
        "   - DO NOT skip this step - you MUST fetch and read actual content",
        "",
        "3. Summarize findings with:",
        "   - Recent announcements and developments",
        "   - Trends and predictions",
        "   - Key dates and timeline",
        "   - Full URL citations with publication dates",
        "",
        "Output format: Structured summary with [Source: URL, Date] citations after each claim.",
      ].join("\n"),
    },
  ];
}
