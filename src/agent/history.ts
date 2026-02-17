/**
 * Session history limiting and tool_use/tool_result pairing repair.
 * Adapted from OpenClaw's pi-embedded-runner/history.ts and
 * pi-embedded-helpers (sanitizeToolUseResultPairing).
 */

const DEFAULT_HISTORY_LIMIT = 100; // max user turns to keep

// ── AgentMessage shape (from pi-agent-core) ─────────────────────────

type ContentBlock = {
  type?: string;
  id?: string;
  tool_use_id?: string;
  [key: string]: unknown;
};

type AgentMessage = {
  role: string;
  content?: string | ContentBlock[];
  [key: string]: unknown;
};

// ── History turn limiting ───────────────────────────────────────────

/**
 * Limits conversation history to the last N user turns (and their
 * associated assistant responses). Mirrors OpenClaw's limitHistoryTurns.
 */
export function limitHistoryTurns(
  messages: AgentMessage[],
  limit?: number,
): AgentMessage[] {
  const effectiveLimit = limit ?? DEFAULT_HISTORY_LIMIT;
  if (effectiveLimit <= 0 || messages.length === 0) {
    return messages;
  }

  let userCount = 0;
  let lastUserIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount++;
      if (userCount > effectiveLimit) {
        return messages.slice(lastUserIndex);
      }
      lastUserIndex = i;
    }
  }
  return messages;
}

// ── Tool use/result pairing repair ──────────────────────────────────

/**
 * Repair orphaned tool_use and tool_result blocks.
 *
 * After history truncation (or corruption), assistant messages may
 * contain tool_use blocks whose matching tool_result no longer exists
 * in a subsequent user message, or user messages may contain
 * tool_result blocks without a matching tool_use. This removes
 * orphaned blocks to prevent API errors.
 */
export function sanitizeToolUseResultPairing(
  messages: AgentMessage[],
): AgentMessage[] {
  // Collect all tool_use IDs from assistant messages
  const toolUseIds = new Set<string>();
  // Collect all tool_result tool_use_ids from user messages
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && typeof block.id === "string") {
        toolUseIds.add(block.id);
      }
      if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        toolResultIds.add(block.tool_use_id);
      }
    }
  }

  // Find orphans
  const orphanedToolUseIds = new Set<string>();
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) {
      orphanedToolUseIds.add(id);
    }
  }
  const orphanedToolResultIds = new Set<string>();
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) {
      orphanedToolResultIds.add(id);
    }
  }

  if (orphanedToolUseIds.size === 0 && orphanedToolResultIds.size === 0) {
    return messages;
  }

  // Remove orphaned blocks
  const repaired: AgentMessage[] = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) {
      repaired.push(msg);
      continue;
    }

    const filtered = msg.content.filter((block) => {
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        orphanedToolUseIds.has(block.id)
      ) {
        return false;
      }
      if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string" &&
        orphanedToolResultIds.has(block.tool_use_id)
      ) {
        return false;
      }
      return true;
    });

    // Skip messages that became empty after filtering
    if (filtered.length === 0) {
      continue;
    }

    repaired.push({ ...msg, content: filtered });
  }

  const dropped =
    orphanedToolUseIds.size + orphanedToolResultIds.size;
  if (dropped > 0) {
    console.log(
      `[agent] Repaired ${dropped} orphaned tool_use/tool_result block(s)`,
    );
  }

  return repaired;
}

/**
 * Apply history limiting and tool pairing repair to session messages.
 * Call this before session.prompt() to keep history bounded.
 */
export function sanitizeSessionHistory(
  messages: AgentMessage[],
  historyLimit?: number,
): AgentMessage[] {
  const limited = limitHistoryTurns(messages, historyLimit);
  const repaired = sanitizeToolUseResultPairing(limited);
  return repaired;
}
