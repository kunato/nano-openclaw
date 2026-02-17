import fs from "node:fs/promises";
import path from "node:path";
import type { NanoToolDefinition } from "./types.js";
import { textResult, jsonTextResult } from "./types.js";
import type { CitationsMode } from "../config.js";

export interface MemorySearchResult {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  citation?: string;
}

/**
 * Search across memory markdown files (MEMORY.md, HISTORY.md, and any
 * other *.md in memory/) using line-based substring matching.
 *
 * Returns snippets with `Source: path#L<start>-L<end>` citations so the
 * user can verify where recalled information came from.
 */
export function createMemorySearchTool(opts: {
  workspaceDir: string;
  citationsMode: CitationsMode;
  sessionKey?: string;
}): NanoToolDefinition {
  return {
    name: "memory_search",
    label: "Memory Search",
    description: [
      "Search long-term memory files (MEMORY.md, HISTORY.md, and other memory/*.md) for relevant information.",
      "Use this BEFORE answering questions about prior work, decisions, dates, people, preferences, or todos.",
      "Returns matching snippets with source citations (file path + line numbers).",
      "After finding relevant results, use memory_get to pull full context around specific lines.",
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "Search query — terms to look for in memory files",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of results to return (default: 10)",
        },
      },
    },
    execute: async (
      _toolCallId: string,
      params: unknown,
    ): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const p = params as Record<string, unknown>;
      const query = p.query as string;
      if (!query) return textResult("Error: query is required");
      const maxResults = (p.maxResults as number) || 10;

      try {
        const memoryDir = path.join(opts.workspaceDir, "memory");
        const files = await discoverMemoryFiles(memoryDir);

        if (files.length === 0) {
          return jsonTextResult({
            results: [],
            message: "No memory files found. Memory is empty.",
          });
        }

        const allResults: MemorySearchResult[] = [];

        for (const filePath of files) {
          const relPath = path.relative(opts.workspaceDir, filePath);
          const results = await searchFile(filePath, relPath, query);
          allResults.push(...results);
        }

        // Sort by score descending (higher = more query terms matched)
        allResults.sort((a, b) => b.score - a.score);
        const topResults = allResults.slice(0, maxResults);

        // Apply citation decorations based on mode
        const includeCitations = shouldIncludeCitations(
          opts.citationsMode,
          opts.sessionKey,
        );
        const decorated = decorateCitations(topResults, includeCitations);

        return jsonTextResult({
          results: decorated,
          total: allResults.length,
          citations: opts.citationsMode,
        });
      } catch (err) {
        return textResult(
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

/** Discover all .md files in the memory directory. */
async function discoverMemoryFiles(memoryDir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(path.join(memoryDir, entry.name));
      }
    }
  } catch {
    // memory dir doesn't exist yet
  }
  return files;
}

/**
 * Search a single file for lines matching the query.
 * Groups consecutive matching lines into snippet windows
 * with configurable context (lines before/after).
 */
async function searchFile(
  filePath: string,
  relPath: string,
  query: string,
): Promise<MemorySearchResult[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const lines = content.split("\n");
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (queryTerms.length === 0) return [];

  // Score each line: count how many query terms appear
  const lineScores: Array<{ lineNum: number; score: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      if (lineLower.includes(term)) {
        score += 1;
        // Bonus for exact word boundary match
        const wordRegex = new RegExp(`\\b${escapeRegex(term)}\\b`, "i");
        if (wordRegex.test(lines[i])) {
          score += 0.5;
        }
      }
    }
    if (score > 0) {
      lineScores.push({ lineNum: i + 1, score }); // 1-indexed
    }
  }

  if (lineScores.length === 0) return [];

  // Group consecutive matching lines into windows (with ±2 context lines)
  const CONTEXT_LINES = 2;
  const windows = groupIntoWindows(lineScores, CONTEXT_LINES);

  return windows.map((window) => {
    const startLine = Math.max(1, window.startLine - CONTEXT_LINES);
    const endLine = Math.min(lines.length, window.endLine + CONTEXT_LINES);
    const snippet = lines
      .slice(startLine - 1, endLine)
      .join("\n")
      .trim();

    return {
      path: relPath,
      startLine,
      endLine,
      snippet,
      score: window.totalScore / queryTerms.length, // normalized
    };
  });
}

interface LineWindow {
  startLine: number;
  endLine: number;
  totalScore: number;
}

/** Group matching lines into contiguous windows (merge if gap ≤ 3 lines). */
function groupIntoWindows(
  scored: Array<{ lineNum: number; score: number }>,
  mergeGap: number,
): LineWindow[] {
  if (scored.length === 0) return [];

  const sorted = [...scored].sort((a, b) => a.lineNum - b.lineNum);
  const windows: LineWindow[] = [];
  let current: LineWindow = {
    startLine: sorted[0].lineNum,
    endLine: sorted[0].lineNum,
    totalScore: sorted[0].score,
  };

  for (let i = 1; i < sorted.length; i++) {
    const line = sorted[i];
    if (line.lineNum - current.endLine <= mergeGap + 1) {
      // Merge into current window
      current.endLine = line.lineNum;
      current.totalScore += line.score;
    } else {
      windows.push(current);
      current = {
        startLine: line.lineNum,
        endLine: line.lineNum,
        totalScore: line.score,
      };
    }
  }
  windows.push(current);
  return windows;
}

/** Format a citation string: `path#L5-L7` or `path#L5`. */
function formatCitation(result: MemorySearchResult): string {
  const lineRange =
    result.startLine === result.endLine
      ? `#L${result.startLine}`
      : `#L${result.startLine}-L${result.endLine}`;
  return `${result.path}${lineRange}`;
}

/** Decorate results with citation info. */
function decorateCitations(
  results: MemorySearchResult[],
  include: boolean,
): MemorySearchResult[] {
  if (!include) {
    return results.map((entry) => ({ ...entry, citation: undefined }));
  }
  return results.map((entry) => {
    const citation = formatCitation(entry);
    const snippet = `${entry.snippet.trim()}\n\nSource: ${citation}`;
    return { ...entry, citation, snippet };
  });
}

/**
 * Determine whether to include citations based on mode and session context.
 * - "on": always include
 * - "off": never include
 * - "auto": include in DMs, suppress in groups/channels
 */
function shouldIncludeCitations(
  mode: CitationsMode,
  sessionKey?: string,
): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  // auto: derive from session key
  const chatType = deriveChatTypeFromSessionKey(sessionKey);
  return chatType === "direct";
}

function deriveChatTypeFromSessionKey(
  sessionKey?: string,
): "direct" | "group" | "channel" {
  if (!sessionKey) return "direct";
  const lower = sessionKey.toLowerCase();
  if (lower.includes("group")) return "group";
  if (lower.includes("channel")) return "channel";
  return "direct";
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
