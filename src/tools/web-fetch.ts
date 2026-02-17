import type { NanoToolDefinition } from "./types.js";
import { textResult, jsonTextResult } from "./types.js";

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function htmlToMarkdown(html: string): { text: string; title?: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]).trim() : undefined;
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, title };
}

async function extractReadable(
  html: string,
  url: string,
): Promise<{ text: string; title?: string }> {
  try {
    const { Readability } = await import("@mozilla/readability");
    const { parseHTML } = await import("linkedom");
    const { document } = parseHTML(html);
    try {
      (document as unknown as { baseURI?: string }).baseURI = url;
    } catch {
      // best-effort
    }
    const reader = new Readability(document as never, { charThreshold: 0 });
    const parsed = reader.parse();
    if (!parsed?.content) {
      return htmlToMarkdown(html);
    }
    const title = parsed.title || undefined;
    const rendered = htmlToMarkdown(parsed.content);
    return { text: rendered.text, title: title ?? rendered.title };
  } catch {
    return htmlToMarkdown(html);
  }
}

export function createWebFetchTool(): NanoToolDefinition {
  return {
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL and extract its readable content as markdown or text. Use for reading documentation, articles, or any web page content.",
    parameters: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "HTTP or HTTPS URL to fetch." },
        maxChars: {
          type: "number",
          description:
            "Maximum characters to return (default 50000). Truncates if exceeded.",
        },
      },
    },
    execute: async (_toolCallId, params) => {
      const p = params as Record<string, unknown>;
      const rawUrl = p.url as string;
      if (!rawUrl?.trim()) return textResult("Error: url is required");

      const maxChars = Math.max(
        100,
        Math.min(
          DEFAULT_MAX_CHARS * 2,
          Number(p.maxChars) || DEFAULT_MAX_CHARS,
        ),
      );

      try {
        const res = await fetch(rawUrl, {
          method: "GET",
          headers: {
            "User-Agent": DEFAULT_USER_AGENT,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          redirect: "follow",
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });

        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          const truncated = detail.slice(0, 2000);
          return jsonTextResult({
            status: "error",
            httpStatus: res.status,
            url: rawUrl,
            error: truncated || res.statusText,
          });
        }

        const contentType = res.headers.get("content-type") ?? "";
        const body = await res.text();

        // If it looks like HTML, extract readable content
        const isHtml =
          contentType.includes("text/html") ||
          body.trimStart().slice(0, 256).toLowerCase().startsWith("<!doctype") ||
          body.trimStart().slice(0, 256).toLowerCase().startsWith("<html");

        let text: string;
        let title: string | undefined;

        if (isHtml) {
          const extracted = await extractReadable(body, rawUrl);
          text = extracted.text;
          title = extracted.title;
        } else {
          text = body;
        }

        // Truncate
        const truncated = text.length > maxChars;
        if (truncated) {
          text = text.slice(0, maxChars) + "\n\n[... truncated]";
        }

        return jsonTextResult({
          url: rawUrl,
          finalUrl: res.url !== rawUrl ? res.url : undefined,
          title,
          contentType: contentType.split(";")[0].trim(),
          charCount: text.length,
          truncated,
          content: text,
        });
      } catch (err) {
        return textResult(
          `Error fetching ${rawUrl}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
