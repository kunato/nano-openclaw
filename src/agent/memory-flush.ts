const COMPACTION_RESERVE_TOKENS = 20_000;
const MEMORY_FLUSH_SOFT_TOKENS = 4_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;

const FLUSH_PROMPT = [
  "[System: Pre-compaction memory flush]",
  "The session is approaching the context limit and will be auto-compacted soon.",
  "Save any important context, decisions, or facts to persistent memory NOW using the memory tool (action: store).",
  "Focus on: key decisions made, important facts learned, ongoing task state, and user preferences discovered.",
  "If nothing important needs saving, just acknowledge briefly.",
].join(" ");

/**
 * Estimate total tokens in a session from message content chars.
 * Pi SDK doesn't expose token counts directly; ~4 chars per token is a
 * widely-used heuristic for English text.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function estimateSessionTokens(messages: any[]): number {
  let totalChars = 0;
  for (const msg of messages) {
    const content = (msg as { content?: unknown }).content;
    if (typeof content === "string") {
      totalChars += content.length;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object") {
          const text = (block as { text?: unknown }).text;
          if (typeof text === "string") totalChars += text.length;
        }
      }
    }
  }
  return Math.floor(totalChars / 4);
}

/**
 * Pre-compaction memory flush (like OpenClaw's memory-flush.ts).
 *
 * If the session is near the compaction threshold, inject a silent turn
 * prompting the agent to save important context to memory files before
 * auto-compaction summarizes (and potentially loses) it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function maybeRunMemoryFlush(session: any, sessionKey: string): Promise<void> {
  const messages = session.messages;
  if (!Array.isArray(messages) || messages.length < 6) return;

  const estimatedTokens = estimateSessionTokens(messages);
  const threshold = DEFAULT_CONTEXT_WINDOW - COMPACTION_RESERVE_TOKENS - MEMORY_FLUSH_SOFT_TOKENS;

  if (estimatedTokens < threshold) return;

  console.log(
    `[agent] Memory flush triggered for ${sessionKey}: ~${estimatedTokens} tokens (threshold: ${threshold})`,
  );

  try {
    await session.prompt(FLUSH_PROMPT);
  } catch (err) {
    console.warn(
      `[agent] Memory flush prompt failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
