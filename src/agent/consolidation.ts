import fs from "node:fs/promises";
import path from "node:path";
import type { ConsolidationConfig } from "../config.js";

/**
 * LLM-driven memory consolidation.
 *
 * When message count exceeds the threshold, uses the same LLM to:
 * 1. Extract key facts → write/update memory/MEMORY.md
 * 2. Log timestamped events → append to memory/HISTORY.md
 *
 * MEMORY.md is injected into the system prompt for passive recall.
 * HISTORY.md is a grep-searchable event log the agent can read on demand.
 */

const CONSOLIDATION_SYSTEM_PROMPT = `You are a memory consolidation assistant. Your job is to analyze a conversation and extract two things:

1. **MEMORY** — Important long-term facts, user preferences, decisions, and ongoing context that should persist across sessions. Write this as a well-organized Markdown document with sections. If existing memory content is provided, merge new information into it (update existing facts, add new ones, remove outdated ones).

2. **HISTORY** — A chronological log of notable events and actions that occurred in this conversation. Each entry should be a single line with a timestamp prefix.

Respond in EXACTLY this format (including the markers):

===MEMORY===
(full updated MEMORY.md content here)
===END_MEMORY===

===HISTORY===
(new HISTORY.md lines to append, one per line, each prefixed with ISO timestamp)
===END_HISTORY===

Guidelines:
- MEMORY should be concise but complete — capture facts, preferences, project context, important decisions
- HISTORY entries should be brief event descriptions, not full conversation replay
- If there's nothing meaningful to extract, still output the markers with minimal content
- Preserve existing memory content that is still relevant; update or remove stale info`;

export interface ConsolidationState {
  lastConsolidatedMessageCount: number;
}

const STATE_FILE = "consolidation-state.json";

export class MemoryConsolidator {
  private config: ConsolidationConfig;
  private workspaceDir: string;
  private agentDir: string;
  private stateCache = new Map<string, ConsolidationState>();

  constructor(opts: {
    config: ConsolidationConfig;
    workspaceDir: string;
    agentDir: string;
  }) {
    this.config = opts.config;
    this.workspaceDir = opts.workspaceDir;
    this.agentDir = opts.agentDir;
  }

  private stateFilePath(sessionKey: string): string {
    const safe = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.agentDir, "consolidation", `${safe}.json`);
  }

  private async loadState(sessionKey: string): Promise<ConsolidationState> {
    const cached = this.stateCache.get(sessionKey);
    if (cached) return cached;

    try {
      const data = await fs.readFile(this.stateFilePath(sessionKey), "utf-8");
      const state = JSON.parse(data) as ConsolidationState;
      this.stateCache.set(sessionKey, state);
      return state;
    } catch {
      const state: ConsolidationState = { lastConsolidatedMessageCount: 0 };
      this.stateCache.set(sessionKey, state);
      return state;
    }
  }

  private async saveState(sessionKey: string, state: ConsolidationState): Promise<void> {
    const filePath = this.stateFilePath(sessionKey);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(state, null, 2));
    this.stateCache.set(sessionKey, state);
  }

  /** Check if consolidation should run for this session. */
  async shouldConsolidate(sessionKey: string, currentMessageCount: number): Promise<boolean> {
    if (!this.config.enabled) return false;
    const state = await this.loadState(sessionKey);
    const newMessages = currentMessageCount - state.lastConsolidatedMessageCount;
    return newMessages >= this.config.messageThreshold;
  }

  /**
   * Run consolidation: extract facts and events from recent messages.
   *
   * @param sessionKey - The session to consolidate
   * @param messages - All session messages (role + content)
   * @param currentMessageCount - Total message count
   * @param llmCall - Function to call the LLM with a prompt and get a response
   */
  async consolidate(
    sessionKey: string,
    messages: Array<{ role: string; content: string }>,
    currentMessageCount: number,
    llmCall: (systemPrompt: string, userPrompt: string) => Promise<string>,
  ): Promise<{ memoryUpdated: boolean; historyAppended: boolean }> {
    const state = await this.loadState(sessionKey);

    // Only consolidate messages since last consolidation
    const newMessages = messages.slice(state.lastConsolidatedMessageCount);
    if (newMessages.length === 0) {
      return { memoryUpdated: false, historyAppended: false };
    }

    // Read existing MEMORY.md
    const memoryPath = path.join(this.workspaceDir, "memory", "MEMORY.md");
    let existingMemory = "";
    try {
      existingMemory = await fs.readFile(memoryPath, "utf-8");
    } catch { /* no existing memory file */ }

    // Format messages for the consolidation prompt
    const formattedMessages = newMessages
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n\n");

    const userPrompt = [
      existingMemory
        ? `## Existing Memory\n\n${existingMemory}\n\n---\n\n`
        : "",
      `## Conversation to consolidate (${newMessages.length} messages)\n\n`,
      formattedMessages,
    ].join("");

    console.log(
      `[consolidation] Running for ${sessionKey}: ${newMessages.length} new messages`,
    );

    let response: string;
    try {
      response = await llmCall(CONSOLIDATION_SYSTEM_PROMPT, userPrompt);
    } catch (err) {
      console.error(
        `[consolidation] LLM call failed:`,
        err instanceof Error ? err.message : String(err),
      );
      return { memoryUpdated: false, historyAppended: false };
    }

    // Parse response
    const { memory, history } = parseConsolidationResponse(response);

    let memoryUpdated = false;
    let historyAppended = false;

    // Write MEMORY.md
    if (memory) {
      await fs.mkdir(path.dirname(memoryPath), { recursive: true });
      await fs.writeFile(memoryPath, memory);
      memoryUpdated = true;
      console.log(`[consolidation] Updated MEMORY.md (${memory.length} chars)`);
    }

    // Append to HISTORY.md
    if (history) {
      const historyPath = path.join(this.workspaceDir, "memory", "HISTORY.md");
      await fs.mkdir(path.dirname(historyPath), { recursive: true });
      try {
        await fs.appendFile(historyPath, history + "\n");
      } catch {
        await fs.writeFile(historyPath, history + "\n");
      }
      historyAppended = true;
      const lineCount = history.split("\n").filter(Boolean).length;
      console.log(`[consolidation] Appended ${lineCount} lines to HISTORY.md`);
    }

    // Update state
    await this.saveState(sessionKey, {
      lastConsolidatedMessageCount: currentMessageCount,
    });

    return { memoryUpdated, historyAppended };
  }

  /** Read MEMORY.md content for injection into system prompt. */
  async readMemory(): Promise<string | null> {
    const memoryPath = path.join(this.workspaceDir, "memory", "MEMORY.md");
    try {
      const content = await fs.readFile(memoryPath, "utf-8");
      return content.trim() || null;
    } catch {
      return null;
    }
  }

  /** Reset consolidation state for a session (e.g. on /reset). */
  async resetState(sessionKey: string): Promise<void> {
    this.stateCache.delete(sessionKey);
    try {
      await fs.unlink(this.stateFilePath(sessionKey));
    } catch { /* ignore */ }
  }
}

function parseConsolidationResponse(response: string): {
  memory: string | null;
  history: string | null;
} {
  let memory: string | null = null;
  let history: string | null = null;

  const memoryMatch = response.match(
    /===MEMORY===\s*\n([\s\S]*?)\n===END_MEMORY===/,
  );
  if (memoryMatch) {
    memory = memoryMatch[1].trim();
    if (!memory) memory = null;
  }

  const historyMatch = response.match(
    /===HISTORY===\s*\n([\s\S]*?)\n===END_HISTORY===/,
  );
  if (historyMatch) {
    history = historyMatch[1].trim();
    if (!history) history = null;
  }

  return { memory, history };
}
