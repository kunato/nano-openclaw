import type { NanoToolDefinition } from "./types.ts";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;
const DEFAULT_TIMEOUT_MS = 15_000;

type BraveResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
};

type BraveResponse = {
  web?: { results?: BraveResult[] };
};

export function createWebSearchTool(apiKey: string): NanoToolDefinition {
  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using Brave Search API. Returns titles, URLs, and snippets. Use for real-time information, documentation lookups, or researching unfamiliar topics.",
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Search query string." },
        count: {
          type: "number",
          description: "Number of results (1-10, default 5).",
        },
      },
    },
    execute: async (_toolCallId, params) => {
      const p = params as Record<string, unknown>;
      const query = p.query as string;
      if (!query?.trim()) return textResult("Error: query is required");

      const count = Math.max(
        1,
        Math.min(MAX_COUNT, Number(p.count) || DEFAULT_COUNT),
      );

      try {
        const url = new URL(BRAVE_SEARCH_ENDPOINT);
        url.searchParams.set("q", query);
        url.searchParams.set("count", String(count));

        const res = await fetch(url.toString(), {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": apiKey,
          },
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });

        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          return textResult(
            `Error: Brave Search API ${res.status}: ${detail || res.statusText}`,
          );
        }

        const data = (await res.json()) as BraveResponse;
        const results = (data.web?.results ?? []).map((r) => ({
          title: r.title ?? "",
          url: r.url ?? "",
          description: r.description ?? "",
          age: r.age,
        }));

        return jsonTextResult({
          query,
          count: results.length,
          results,
        });
      } catch (err) {
        return textResult(
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonTextResult(payload: unknown) {
  return textResult(JSON.stringify(payload, null, 2));
}
