import fs from "node:fs/promises";

/** Heuristic: detect API context-overflow errors from various providers. */
export function isContextOverflowError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("request_too_large") ||
    lower.includes("request exceeds the maximum size") ||
    lower.includes("context length exceeded") ||
    lower.includes("maximum context length") ||
    lower.includes("prompt is too long") ||
    lower.includes("exceeds model context window") ||
    (lower.includes("request size exceeds") && lower.includes("context window")) ||
    lower.includes("context overflow") ||
    (lower.includes("413") && lower.includes("too large"))
  );
}

/** Detect rate-limit / quota / overloaded errors worth retrying. */
export function isRetryableError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("rate limit") ||
    lower.includes("429") ||
    lower.includes("too many requests") ||
    lower.includes("overloaded") ||
    lower.includes("529") ||
    lower.includes("503") ||
    lower.includes("server error") ||
    lower.includes("internal error") ||
    lower.includes("connection reset") ||
    lower.includes("econnreset") ||
    lower.includes("socket hang up") ||
    lower.includes("timeout")
  );
}

/**
 * Retry strategy for prompt failures. Returns:
 *  - { action: "retry" } → caller should retry session.prompt()
 *  - { action: "respond", text } → caller should return this as the response
 *
 * Strategy:
 *  1. Context overflow → try session.compact() → retry
 *  2. Context overflow after compaction → reset session file → respond with error
 *  3. Retryable transient error → wait + retry (up to maxRetries)
 *  4. Unknown error → respond with error
 */
export async function resolvePromptError(opts: {
  error: string;
  sessionFile: string;
  sessionKey: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session: any;
  attempt: number;
  maxRetries?: number;
}): Promise<{ action: "retry"; delayMs?: number } | { action: "respond"; text: string }> {
  const { error, sessionFile, sessionKey, session, attempt } = opts;
  const maxRetries = opts.maxRetries ?? 2;

  // ── Context overflow ──────────────────────────────────────────────
  if (isContextOverflowError(error)) {
    if (attempt === 0) {
      // First overflow: try compaction
      console.warn(`[agent] Context overflow (attempt ${attempt}) — trying compaction for ${sessionKey}`);
      try {
        if (typeof session.compact === "function") {
          await session.compact();
          console.log(`[agent] Compaction succeeded for ${sessionKey} — retrying`);
          return { action: "retry" };
        }
        console.warn(`[agent] session.compact() not available — skipping`);
      } catch (compactErr) {
        console.warn(
          `[agent] Compaction failed: ${compactErr instanceof Error ? compactErr.message : String(compactErr)}`,
        );
      }
    }

    // Compaction didn't help or already tried — reset session
    console.warn(`[agent] Context overflow unrecoverable — resetting session ${sessionKey}`);
    try { await fs.unlink(sessionFile); } catch { /* ignore */ }
    return {
      action: "respond",
      text: "⚠️ Context limit exceeded. I've compacted and retried but it's still too large. Session has been reset — please try again.",
    };
  }

  // ── Retryable transient errors (rate limit, 503, timeout) ─────────
  if (isRetryableError(error) && attempt < maxRetries) {
    const delayMs = Math.min(1000 * 2 ** attempt, 15_000); // exponential backoff, cap 15s
    console.warn(
      `[agent] Retryable error (attempt ${attempt}/${maxRetries}): ${error.slice(0, 120)} — retrying in ${delayMs}ms`,
    );
    return { action: "retry", delayMs };
  }

  // ── Non-recoverable ───────────────────────────────────────────────
  return { action: "respond", text: `Error: ${error}` };
}
