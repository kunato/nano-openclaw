import fs from "node:fs/promises";
import path from "node:path";
import type { NanoToolDefinition } from "./types.js";
import { textResult, jsonTextResult } from "./types.js";

/**
 * Safe snippet read from memory files with optional line range.
 *
 * Use after memory_search to pull only the needed lines and keep
 * context small. Supports MEMORY.md, HISTORY.md, and any *.md
 * in the memory/ directory.
 */
export function createMemoryGetTool(opts: {
  workspaceDir: string;
}): NanoToolDefinition {
  return {
    name: "memory_get",
    label: "Memory Get",
    description: [
      "Read a specific section from a memory file (MEMORY.md, HISTORY.md, or other memory/*.md).",
      "Use after memory_search to pull full context around specific lines.",
      "Specify `from` and `lines` to read a specific range, or omit both to read the full file.",
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description:
            "Relative path to the memory file (e.g. 'memory/MEMORY.md')",
        },
        from: {
          type: "number",
          description: "1-indexed line number to start reading from",
        },
        lines: {
          type: "number",
          description:
            "Number of lines to read from the start position (default: 50)",
        },
      },
    },
    execute: async (
      _toolCallId: string,
      params: unknown,
    ): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const p = params as Record<string, unknown>;
      const relPath = p.path as string;
      if (!relPath) return textResult("Error: path is required");

      const from = (p.from as number) || undefined;
      const lineCount = (p.lines as number) || 50;

      try {
        // Resolve and validate the path stays within workspace
        const resolved = path.resolve(opts.workspaceDir, relPath);
        if (!resolved.startsWith(path.resolve(opts.workspaceDir))) {
          return textResult("Error: path must be within the workspace");
        }

        let content: string;
        try {
          content = await fs.readFile(resolved, "utf-8");
        } catch {
          return jsonTextResult({
            path: relPath,
            text: "",
            error: "File not found",
          });
        }

        const allLines = content.split("\n");
        const totalLines = allLines.length;

        if (from) {
          // Extract the requested range (1-indexed)
          const startIdx = Math.max(0, from - 1);
          const endIdx = Math.min(totalLines, startIdx + lineCount);
          const slice = allLines.slice(startIdx, endIdx);

          // Format with line numbers (like `cat -n`)
          const numbered = slice
            .map((line, i) => `${String(startIdx + i + 1).padStart(4)} │ ${line}`)
            .join("\n");

          return jsonTextResult({
            path: relPath,
            from: startIdx + 1,
            to: endIdx,
            totalLines,
            text: numbered,
          });
        }

        // No range specified — return full file (capped at 200 lines)
        const MAX_FULL_READ = 200;
        const capped = allLines.length > MAX_FULL_READ;
        const slice = capped ? allLines.slice(0, MAX_FULL_READ) : allLines;

        const numbered = slice
          .map((line, i) => `${String(i + 1).padStart(4)} │ ${line}`)
          .join("\n");

        return jsonTextResult({
          path: relPath,
          totalLines,
          truncated: capped,
          text: numbered,
        });
      } catch (err) {
        return textResult(
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
