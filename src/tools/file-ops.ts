import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { NanoToolDefinition } from "./types.js";
import { textResult, jsonTextResult } from "./types.js";

const ACTIONS = [
  "download",
  "list",
  "info",
  "move",
  "copy",
  "delete",
  "mkdir",
] as const;

export function createFileOpsTool(opts?: {
  downloadDir?: string;
}): NanoToolDefinition {
  const defaultDownloadDir =
    opts?.downloadDir ?? path.join(process.env.HOME ?? "/tmp", "Downloads");

  return {
    name: "file_ops",
    label: "File Operations",
    description: `File system operations: download URLs, list directories, get file info, move/copy/delete files.

ACTIONS:
- download: Download a file from a URL and save it to disk
- list: List files and directories at a path
- info: Get file/directory metadata (size, type, modified date)
- move: Move or rename a file/directory
- copy: Copy a file
- delete: Delete a file or directory
- mkdir: Create a directory (with parents)

EXAMPLES:
- Download: { "action": "download", "url": "https://example.com/file.pdf", "dest": "~/Downloads/file.pdf" }
- List: { "action": "list", "path": "/Users/user/Documents" }
- Info: { "action": "info", "path": "/Users/user/file.txt" }
- Move: { "action": "move", "src": "/tmp/old.txt", "dest": "/tmp/new.txt" }
- Copy: { "action": "copy", "src": "/tmp/a.txt", "dest": "/tmp/b.txt" }
- Delete: { "action": "delete", "path": "/tmp/unwanted.txt" }
- Mkdir: { "action": "mkdir", "path": "/tmp/my-project/data" }`,
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: [...ACTIONS],
          description: "Action to perform",
        },
        url: {
          type: "string",
          description: "URL to download (for download action)",
        },
        path: {
          type: "string",
          description:
            "File/directory path (for list/info/delete/mkdir actions)",
        },
        src: {
          type: "string",
          description: "Source path (for move/copy actions)",
        },
        dest: {
          type: "string",
          description:
            "Destination path (for download/move/copy actions). For download, defaults to ~/Downloads/<filename>",
        },
        recursive: {
          type: "boolean",
          description:
            "Recursively list/delete (default: false for list, true for delete dirs)",
        },
      },
    },
    execute: async (_toolCallId, params) => {
      const p = params as Record<string, unknown>;
      const action = String(p.action ?? "");

      try {
        switch (action) {
          // ── download ─────────────────────────────────────────
          case "download": {
            const url = String(p.url ?? "");
            if (!url) return textResult("Error: url is required");

            // Determine destination path
            let dest = p.dest ? String(p.dest) : undefined;
            if (!dest) {
              const urlObj = new URL(url);
              const filename =
                path.basename(urlObj.pathname) || "download";
              dest = path.join(defaultDownloadDir, filename);
            }
            dest = expandHome(dest);

            // Ensure parent directory exists
            await fs.mkdir(path.dirname(dest), { recursive: true });

            // Download with fetch + stream to disk
            const response = await fetch(url, {
              headers: {
                "User-Agent":
                  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
              },
              redirect: "follow",
            });

            if (!response.ok) {
              return textResult(
                `Error: HTTP ${response.status} ${response.statusText} downloading ${url}`,
              );
            }

            if (!response.body) {
              return textResult("Error: No response body");
            }

            const writeStream = createWriteStream(dest);
            await pipeline(response.body as never, writeStream);

            const stats = await fs.stat(dest);
            const contentType =
              response.headers.get("content-type") ?? "unknown";

            return jsonTextResult({
              ok: true,
              url,
              path: dest,
              size: formatSize(stats.size),
              sizeBytes: stats.size,
              contentType,
            });
          }

          // ── list ─────────────────────────────────────────────
          case "list": {
            const dirPath = expandHome(String(p.path ?? "."));
            const recursive = p.recursive === true;

            const entries = await fs.readdir(dirPath, {
              withFileTypes: true,
            });

            const items = await Promise.all(
              entries.map(async (entry) => {
                const fullPath = path.join(dirPath, entry.name);
                try {
                  const stats = await fs.stat(fullPath);
                  return {
                    name: entry.name,
                    type: entry.isDirectory() ? "directory" : "file",
                    size: entry.isFile() ? formatSize(stats.size) : undefined,
                    sizeBytes: entry.isFile() ? stats.size : undefined,
                    modified: stats.mtime.toISOString(),
                    children: entry.isDirectory() && recursive
                      ? (await fs.readdir(fullPath)).length
                      : undefined,
                  };
                } catch {
                  return {
                    name: entry.name,
                    type: entry.isDirectory() ? "directory" : "file",
                    error: "stat failed",
                  };
                }
              }),
            );

            // Sort: directories first, then files
            items.sort((a, b) => {
              if (a.type !== b.type)
                return a.type === "directory" ? -1 : 1;
              return a.name.localeCompare(b.name);
            });

            return jsonTextResult({
              ok: true,
              path: dirPath,
              count: items.length,
              items,
            });
          }

          // ── info ─────────────────────────────────────────────
          case "info": {
            const filePath = expandHome(String(p.path ?? ""));
            if (!filePath) return textResult("Error: path is required");

            const stats = await fs.stat(filePath);
            const ext = path.extname(filePath).toLowerCase();

            return jsonTextResult({
              ok: true,
              path: filePath,
              name: path.basename(filePath),
              type: stats.isDirectory()
                ? "directory"
                : stats.isSymbolicLink()
                  ? "symlink"
                  : "file",
              size: formatSize(stats.size),
              sizeBytes: stats.size,
              extension: ext || undefined,
              created: stats.birthtime.toISOString(),
              modified: stats.mtime.toISOString(),
              permissions: stats.mode.toString(8).slice(-3),
            });
          }

          // ── move ─────────────────────────────────────────────
          case "move": {
            const src = expandHome(String(p.src ?? ""));
            const dest = expandHome(String(p.dest ?? ""));
            if (!src) return textResult("Error: src is required");
            if (!dest) return textResult("Error: dest is required");

            await fs.mkdir(path.dirname(dest), { recursive: true });
            await fs.rename(src, dest);

            return jsonTextResult({
              ok: true,
              from: src,
              to: dest,
            });
          }

          // ── copy ─────────────────────────────────────────────
          case "copy": {
            const src = expandHome(String(p.src ?? ""));
            const dest = expandHome(String(p.dest ?? ""));
            if (!src) return textResult("Error: src is required");
            if (!dest) return textResult("Error: dest is required");

            await fs.mkdir(path.dirname(dest), { recursive: true });
            await fs.copyFile(src, dest);

            const stats = await fs.stat(dest);
            return jsonTextResult({
              ok: true,
              from: src,
              to: dest,
              size: formatSize(stats.size),
            });
          }

          // ── delete ───────────────────────────────────────────
          case "delete": {
            const filePath = expandHome(String(p.path ?? ""));
            if (!filePath) return textResult("Error: path is required");

            const stats = await fs.stat(filePath);
            if (stats.isDirectory()) {
              await fs.rm(filePath, { recursive: true });
            } else {
              await fs.unlink(filePath);
            }

            return jsonTextResult({
              ok: true,
              deleted: filePath,
              type: stats.isDirectory() ? "directory" : "file",
            });
          }

          // ── mkdir ────────────────────────────────────────────
          case "mkdir": {
            const dirPath = expandHome(String(p.path ?? ""));
            if (!dirPath) return textResult("Error: path is required");

            await fs.mkdir(dirPath, { recursive: true });
            return jsonTextResult({ ok: true, created: dirPath });
          }

          default:
            return textResult(
              `Error: unknown action "${action}". Use: ${ACTIONS.join(", ")}`,
            );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return textResult(`Error [file_ops.${action}]: ${msg}`);
      }
    },
  };
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(process.env.HOME ?? "/tmp", p.slice(2));
  }
  return p;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
