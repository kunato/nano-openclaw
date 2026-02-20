import fs from "node:fs/promises";
import path from "node:path";
import type { CitationsMode } from "../config.js";

/**
 * Parsed citation extracted from agent response text.
 */
interface ParsedCitation {
  /** Full match string in the text, e.g. `Source: memory/MEMORY.md#L5-L12` */
  raw: string;
  /** Relative path to the memory file */
  filePath: string;
  /** 1-indexed start line */
  startLine: number;
  /** 1-indexed end line (same as startLine for single-line refs) */
  endLine: number;
  /** Whether this citation was validated against the actual file */
  valid?: boolean;
}

/**
 * Regex that matches `Source: <path>#L<start>` or `Source: <path>#L<start>-L<end>`
 * anywhere in the text. Handles optional surrounding whitespace.
 */
const CITATION_REGEX =
  /Source:\s*([\w/.+-]+)#L(\d+)(?:-L(\d+))?/g;

/**
 * Post-process agent response text to validate, format, or strip
 * memory citations based on the configured citations mode.
 *
 * This runs on the final response text before it is sent to the user.
 *
 * Behaviour by mode:
 * - "off": strip all `Source: …` citations from the text
 * - "on": validate citations, mark invalid ones, collect into footnotes
 * - "auto": "on" for DMs, "off" for groups
 */
export async function postProcessCitations(opts: {
  text: string;
  citationsMode: CitationsMode;
  workspaceDir: string;
  isGroup: boolean;
}): Promise<string> {
  const { text, citationsMode, workspaceDir, isGroup } = opts;

  // Determine effective mode
  const effective = resolveEffectiveMode(citationsMode, isGroup);

  if (effective === "off") {
    return stripCitations(text);
  }

  // Mode is "on" — validate and format citations
  const parsed = parseCitations(text);
  if (parsed.length === 0) return text;

  // Validate each citation against the actual file
  const validated = await validateCitations(parsed, workspaceDir);

  // Replace inline citations with numbered references + append footnotes
  return formatWithFootnotes(text, validated);
}

function resolveEffectiveMode(
  mode: CitationsMode,
  isGroup: boolean,
): "on" | "off" {
  if (mode === "on") return "on";
  if (mode === "off") return "off";
  // auto: DMs → on, groups → off
  return isGroup ? "off" : "on";
}

/** Remove all `Source: path#L…` references from the text. */
function stripCitations(text: string): string {
  // Remove lines that are ONLY a source citation (with optional whitespace)
  let result = text.replace(/^\s*Source:\s*[\w/.+-]+#L\d+(?:-L\d+)?\s*$/gm, "");
  // Remove inline source citations
  result = result.replace(CITATION_REGEX, "");
  // Clean up extra blank lines left behind
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

/** Extract all citation references from the text. */
function parseCitations(text: string): ParsedCitation[] {
  const results: ParsedCitation[] = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  // Reset regex state
  CITATION_REGEX.lastIndex = 0;
  while ((match = CITATION_REGEX.exec(text)) !== null) {
    const raw = match[0];
    if (seen.has(raw)) continue;
    seen.add(raw);

    const filePath = match[1];
    const startLine = parseInt(match[2], 10);
    const endLine = match[3] ? parseInt(match[3], 10) : startLine;

    results.push({ raw, filePath, startLine, endLine });
  }
  return results;
}

/** Validate citations by checking whether the file and lines actually exist. */
async function validateCitations(
  citations: ParsedCitation[],
  workspaceDir: string,
): Promise<ParsedCitation[]> {
  const results: ParsedCitation[] = [];

  for (const cite of citations) {
    const resolved = path.resolve(workspaceDir, cite.filePath);
    // Security: ensure within workspace
    if (!resolved.startsWith(path.resolve(workspaceDir))) {
      results.push({ ...cite, valid: false });
      continue;
    }

    try {
      const content = await fs.readFile(resolved, "utf-8");
      const lineCount = content.split("\n").length;
      const valid =
        cite.startLine >= 1 &&
        cite.startLine <= lineCount &&
        cite.endLine >= cite.startLine &&
        cite.endLine <= lineCount;
      results.push({ ...cite, valid });
    } catch {
      results.push({ ...cite, valid: false });
    }
  }
  return results;
}

/**
 * Replace inline `Source: …` citations with numbered footnote markers
 * and append a "Sources" section at the bottom of the message.
 *
 * Invalid citations are stripped silently (the claim remains, citation removed).
 */
function formatWithFootnotes(
  text: string,
  citations: ParsedCitation[],
): string {
  if (citations.length === 0) return text;

  const validCitations = citations.filter((c) => c.valid);
  const invalidCitations = citations.filter((c) => !c.valid);

  let result = text;

  // Strip invalid citations
  for (const cite of invalidCitations) {
    // Remove the full "Source: …" for invalid ones
    result = result.split(cite.raw).join("");
  }

  // Replace valid inline citations with numbered markers
  const footnotes: string[] = [];
  for (let i = 0; i < validCitations.length; i++) {
    const cite = validCitations[i];
    const num = i + 1;
    const lineRange =
      cite.startLine === cite.endLine
        ? `L${cite.startLine}`
        : `L${cite.startLine}-L${cite.endLine}`;
    const marker = `[${num}]`;
    const footnote = `[${num}] ${cite.filePath}#${lineRange}`;

    // Replace the inline "Source: path#L…" with a short marker
    result = result.split(cite.raw).join(marker);
    footnotes.push(footnote);
  }

  // Clean up blank lines from removals
  result = result.replace(/\n{3,}/g, "\n\n").trim();

  // Append footnotes section if any valid citations
  if (footnotes.length > 0) {
    result += "\n\n---\n**Sources**\n" + footnotes.join("\n");
  }

  return result;
}
