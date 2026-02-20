import type { NanoToolDefinition } from "./types.js";
import { textResult, jsonTextResult } from "./types.js";
import { fetchWithSsrfGuard, SsrfBlockedError } from "../security/ssrf.js";

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const PDF_MAX_PAGES = 100;
const PDF_MAX_BYTES = 50 * 1024 * 1024; // 50 MB download cap for PDFs
const DEFAULT_FIRECRAWL_BASE_URL = "https://api.firecrawl.dev";
const FIRECRAWL_TIMEOUT_MS = 60_000;

// Lazy-loaded pdfjs-dist (same approach as openclaw's src/media/input-files.ts)
type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

async function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsModulePromise) {
    pdfJsModulePromise = import("pdfjs-dist/legacy/build/pdf.mjs").catch((err) => {
      pdfJsModulePromise = null;
      throw new Error(
        `pdfjs-dist is required for PDF extraction: ${String(err)}`,
      );
    });
  }
  return pdfJsModulePromise;
}

async function extractPdfText(buffer: ArrayBuffer): Promise<{ text: string; numPages: number }> {
  const { getDocument } = await loadPdfJs();
  const pdf = await getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
  }).promise;

  const maxPages = Math.min(pdf.numPages, PDF_MAX_PAGES);
  const textParts: string[] = [];

  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => ("str" in item ? String(item.str) : ""))
      .filter(Boolean)
      .join(" ");
    if (pageText) {
      textParts.push(pageText);
    }
  }

  return { text: textParts.join("\n\n"), numPages: pdf.numPages };
}

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

interface FirecrawlResult {
  success: boolean;
  markdown?: string;
  content?: string;
  title?: string;
  error?: string;
}

async function fetchWithFirecrawl(params: {
  url: string;
  apiKey: string;
  baseUrl: string;
  onlyMainContent: boolean;
}): Promise<{ text: string; title?: string; extractor: string }> {
  const endpoint = `${params.baseUrl.replace(/\/$/, "")}/v1/scrape`;
  
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify({
      url: params.url,
      formats: ["markdown"],
      onlyMainContent: params.onlyMainContent,
    }),
    signal: AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Firecrawl API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as { data?: FirecrawlResult };
  const result = data.data;
  
  if (!result?.success) {
    throw new Error(result?.error || "Firecrawl extraction failed");
  }

  const text = result.markdown || result.content || "";
  return { text, title: result.title, extractor: "firecrawl" };
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

export interface WebFetchOptions {
  /** Firecrawl API key (enables Firecrawl extraction for JS-heavy sites) */
  firecrawlApiKey?: string;
  /** Firecrawl base URL (default: https://api.firecrawl.dev) */
  firecrawlBaseUrl?: string;
  /** Only extract main content (default: true) */
  firecrawlOnlyMainContent?: boolean;
  /** Allow localhost URLs (for development, default: false) */
  allowLocalhost?: boolean;
}

export function createWebFetchTool(options: WebFetchOptions = {}): NanoToolDefinition {
  const firecrawlApiKey = options.firecrawlApiKey || process.env.FIRECRAWL_API_KEY?.trim();
  const firecrawlBaseUrl = options.firecrawlBaseUrl || DEFAULT_FIRECRAWL_BASE_URL;
  const firecrawlOnlyMainContent = options.firecrawlOnlyMainContent ?? true;
  const allowLocalhost = options.allowLocalhost ?? false;
  return {
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL and extract its readable content. Supports HTML pages (extracted via Readability), PDF documents (text extraction), JSON, and plain text. For research papers (e.g. arXiv), fetch the PDF URL directly (e.g. https://arxiv.org/pdf/XXXX.XXXXX) for best results.",
    parameters: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "HTTP or HTTPS URL to fetch." },
        useFirecrawl: {
          type: "boolean",
          description:
            "Use Firecrawl for JS-heavy sites (requires FIRECRAWL_API_KEY). Auto-detected if not specified.",
        },
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
        // SSRF protection: validate URL before fetching
        // Firecrawl is only used when explicitly requested via useFirecrawl: true
        const useFirecrawl = p.useFirecrawl === true;

        // Try Firecrawl first when explicitly requested
        if (useFirecrawl && firecrawlApiKey) {
          try {
            const fcResult = await fetchWithFirecrawl({
              url: rawUrl,
              apiKey: firecrawlApiKey,
              baseUrl: firecrawlBaseUrl,
              onlyMainContent: firecrawlOnlyMainContent,
            });
            let text = fcResult.text;
            const isTruncated = text.length > maxChars;
            if (isTruncated) {
              text = text.slice(0, maxChars) + "\n\n[... truncated]";
            }
            return jsonTextResult({
              url: rawUrl,
              title: fcResult.title,
              extractor: fcResult.extractor,
              charCount: text.length,
              truncated: isTruncated,
              content: text,
            });
          } catch (fcErr) {
            // Fall back to direct fetch if Firecrawl fails
            console.warn(
              `[web_fetch] Firecrawl failed, falling back to direct fetch: ${fcErr instanceof Error ? fcErr.message : String(fcErr)}`
            );
          }
        }

        const res = await fetchWithSsrfGuard(rawUrl, {
          method: "GET",
          headers: {
            "User-Agent": DEFAULT_USER_AGENT,
            Accept: "application/pdf,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          redirect: "follow",
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        }, { allowLocalhost });

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
        const normalizedCt = contentType.split(";")[0].trim().toLowerCase();

        // ── PDF handling ─────────────────────────────────────────────
        if (normalizedCt === "application/pdf" || rawUrl.match(/\.pdf(\?|#|$)/i)) {
          const arrayBuf = await res.arrayBuffer();
          if (arrayBuf.byteLength > PDF_MAX_BYTES) {
            return jsonTextResult({
              status: "error",
              url: rawUrl,
              error: `PDF too large: ${(arrayBuf.byteLength / 1024 / 1024).toFixed(1)} MB (limit: ${PDF_MAX_BYTES / 1024 / 1024} MB)`,
            });
          }
          try {
            const { text: pdfText, numPages } = await extractPdfText(arrayBuf);
            let text = pdfText;
            const isTruncated = text.length > maxChars;
            if (isTruncated) {
              text = text.slice(0, maxChars) + "\n\n[... truncated]";
            }
            return jsonTextResult({
              url: rawUrl,
              finalUrl: res.url !== rawUrl ? res.url : undefined,
              contentType: "application/pdf",
              extractor: "pdfjs",
              numPages,
              charCount: text.length,
              truncated: isTruncated,
              content: text,
            });
          } catch (pdfErr) {
            return textResult(
              `Error extracting PDF text from ${rawUrl}: ${pdfErr instanceof Error ? pdfErr.message : String(pdfErr)}`,
            );
          }
        }

        // ── Non-PDF: read as text ────────────────────────────────────
        const body = await res.text();

        // If it looks like HTML, extract readable content
        const isHtml =
          normalizedCt.includes("text/html") ||
          body.trimStart().slice(0, 256).toLowerCase().startsWith("<!doctype") ||
          body.trimStart().slice(0, 256).toLowerCase().startsWith("<html");

        let text: string;
        let title: string | undefined;

        if (isHtml) {
          const extracted = await extractReadable(body, rawUrl);
          text = extracted.text;
          title = extracted.title;
        } else if (normalizedCt.includes("application/json")) {
          try {
            text = JSON.stringify(JSON.parse(body), null, 2);
          } catch {
            text = body;
          }
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
          contentType: normalizedCt || undefined,
          charCount: text.length,
          truncated,
          content: text,
        });
      } catch (err) {
        if (err instanceof SsrfBlockedError) {
          return jsonTextResult({
            status: "error",
            url: rawUrl,
            error: `Security: ${err.reason}`,
            ssrfBlocked: true,
          });
        }
        return textResult(
          `Error fetching ${rawUrl}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

