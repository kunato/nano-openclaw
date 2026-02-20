import type { NanoToolDefinition } from "../tools/types.js";
import { normalizeBase64Image } from "../media/image-ops.js";

const MAX_TOOL_RESULT_CHARS = 50_000;

/**
 * Wraps a tool's execute function to normalize any image content blocks
 * in the result before they enter the session (and get sent to the API).
 * This prevents oversized images (>8000px / >5MB) from causing API errors.
 */
export function wrapToolWithImageNormalization(
  tool: NanoToolDefinition,
): NanoToolDefinition {
  const originalExecute = tool.execute;
  return {
    ...tool,
    execute: async (...args: Parameters<typeof originalExecute>) => {
      const result = await originalExecute(...args);
      if (!result?.content || !Array.isArray(result.content)) return result;

      const hasImage = result.content.some(
        (b: unknown) =>
          typeof b === "object" &&
          b !== null &&
          (b as Record<string, unknown>).type === "image",
      );
      if (!hasImage) return result;

      const normalizedContent = await Promise.all(
        result.content.map(async (block: unknown) => {
          if (
            typeof block !== "object" ||
            block === null ||
            (block as Record<string, unknown>).type !== "image"
          ) {
            return block;
          }
          const imgBlock = block as {
            type: string;
            data?: string;
            mimeType?: string;
          };
          if (!imgBlock.data) return block;

          try {
            const normalized = await normalizeBase64Image(
              imgBlock.data,
              imgBlock.mimeType ?? "image/png",
            );
            if (normalized.resized) {
              console.log(
                `[agent] Resized image from ${tool.name} (${imgBlock.mimeType} → ${normalized.mimeType})`,
              );
            }
            return {
              ...imgBlock,
              data: normalized.base64,
              mimeType: normalized.mimeType,
            };
          } catch (err) {
            console.error(
              `[agent] Failed to normalize image from ${tool.name}:`,
              err,
            );
            return {
              type: "text" as const,
              text: `[image omitted: ${err instanceof Error ? err.message : String(err)}]`,
            };
          }
        }),
      );

      return { content: normalizedContent as typeof result.content };
    },
  };
}

/**
 * Wraps a tool's execute function to truncate oversized text results
 * before they enter the session. Mirrors OpenClaw's tool result capping
 * to prevent context overflow from large web_fetch / browser.snapshot / etc.
 */
export function wrapToolWithResultTruncation(
  tool: NanoToolDefinition,
  maxChars = MAX_TOOL_RESULT_CHARS,
): NanoToolDefinition {
  const originalExecute = tool.execute;
  return {
    ...tool,
    execute: async (...args: Parameters<typeof originalExecute>) => {
      const result = await originalExecute(...args);
      if (!result?.content || !Array.isArray(result.content)) return result;

      let didTruncate = false;
      const truncatedContent = result.content.map((block: unknown) => {
        if (
          typeof block !== "object" ||
          block === null ||
          (block as Record<string, unknown>).type !== "text"
        ) {
          return block;
        }
        const textBlock = block as { type: string; text?: string };
        if (!textBlock.text || textBlock.text.length <= maxChars) return block;

        didTruncate = true;
        const truncated = textBlock.text.slice(0, maxChars);
        const note = `\n\n... [truncated ${textBlock.text.length - maxChars} chars — original ${textBlock.text.length} chars]`;
        return { ...textBlock, text: truncated + note };
      });

      if (didTruncate) {
        console.log(
          `[agent] Truncated text result from ${tool.name} to ${maxChars} chars`,
        );
      }
      return { content: truncatedContent as typeof result.content };
    },
  };
}
