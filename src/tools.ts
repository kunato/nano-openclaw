import type { MemoryStore } from "./memory.js";
import type { NanoToolDefinition } from "./tools/types.js";
import { textResult, jsonTextResult } from "./tools/types.js";

export type { NanoToolDefinition } from "./tools/types.js";
export { createWebSearchTool } from "./tools/web-search.js";
export { createWebFetchTool } from "./tools/web-fetch.js";
export { createReminderTool } from "./tools/reminder.js";
export { createBrowserTool } from "./tools/browser.js";
export { createFileOpsTool } from "./tools/file-ops.js";
export { createSubagentTool } from "./tools/subagent.js";

export function createMemoryTool(store: MemoryStore): NanoToolDefinition {
  return {
    name: "memory",
    label: "memory",
    description: [
      "Manage persistent memory that survives across conversations.",
      "Actions:",
      "  store   - Save a new memory (requires: content, optional: tags)",
      "  search  - Find memories matching a query (requires: query)",
      "  list    - List all stored memories",
      "  delete  - Remove a memory by ID (requires: id)",
      "  update  - Update a memory by ID (requires: id, content, optional: tags)",
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["store", "search", "list", "delete", "update"],
          description: "The action to perform",
        },
        content: {
          type: "string",
          description: "Content for store/update actions",
        },
        query: {
          type: "string",
          description: "Search query for search action",
        },
        id: {
          type: "string",
          description: "Memory ID for delete/update actions",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for store/update actions",
        },
      },
    },
    execute: async (
      _toolCallId: string,
      params: unknown,
    ): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const p = params as Record<string, unknown>;
      const action = p.action as string;

      try {
        switch (action) {
          case "store": {
            const content = p.content as string;
            if (!content)
              return textResult("Error: content is required for store action");
            const tags = (p.tags as string[]) || [];
            const entry = await store.store(content, tags);
            return jsonTextResult({ status: "stored", memory: entry });
          }
          case "search": {
            const query = p.query as string;
            if (!query)
              return textResult("Error: query is required for search action");
            const results = await store.search(query);
            return jsonTextResult({
              status: "ok",
              count: results.length,
              results,
            });
          }
          case "list": {
            const all = await store.list();
            return jsonTextResult({
              status: "ok",
              count: all.length,
              memories: all,
            });
          }
          case "delete": {
            const id = p.id as string;
            if (!id)
              return textResult("Error: id is required for delete action");
            const deleted = await store.remove(id);
            return jsonTextResult({
              status: deleted ? "deleted" : "not_found",
            });
          }
          case "update": {
            const id = p.id as string;
            const content = p.content as string;
            if (!id)
              return textResult("Error: id is required for update action");
            if (!content)
              return textResult("Error: content is required for update action");
            const tags = p.tags as string[] | undefined;
            const updated = await store.update(id, content, tags);
            return jsonTextResult({
              status: updated ? "updated" : "not_found",
              memory: updated,
            });
          }
          default:
            return textResult(`Error: unknown action "${action}"`);
        }
      } catch (err) {
        return textResult(
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
