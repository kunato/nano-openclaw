import type { ImageAttachment } from "../channels/base.js";

export function inferToolMeta(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  switch (toolName) {
    case "read":
      return typeof a.path === "string" ? a.path : undefined;
    case "write":
      return typeof a.path === "string" ? a.path : undefined;
    case "edit":
    case "multi_edit":
      return typeof a.file_path === "string" ? a.file_path : undefined;
    case "bash":
    case "exec": {
      const cmd = typeof a.command === "string" ? a.command : "";
      return cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd || undefined;
    }
    case "web_search":
      return typeof a.query === "string" ? a.query : undefined;
    case "web_fetch":
      return typeof a.url === "string" ? a.url : undefined;
    case "memory":
      return typeof a.action === "string" ? a.action : undefined;
    case "cron": {
      const cronAction = typeof a.action === "string" ? a.action : "";
      const cronName = typeof a.name === "string" ? a.name : "";
      return cronName ? `${cronAction}: ${cronName}` : cronAction || undefined;
    }
    case "browser": {
      const bAction = typeof a.action === "string" ? a.action : "";
      const bUrl = typeof a.url === "string" ? a.url : "";
      const bSelector = typeof a.selector === "string" ? a.selector : "";
      if (bUrl) return `${bAction}: ${bUrl.length > 60 ? bUrl.slice(0, 57) + "..." : bUrl}`;
      if (bSelector) return `${bAction}: ${bSelector}`;
      return bAction || undefined;
    }
    case "file_ops": {
      const fAction = typeof a.action === "string" ? a.action : "";
      const fUrl = typeof a.url === "string" ? a.url : "";
      const fPath = typeof a.path === "string" ? a.path : "";
      if (fUrl) return `${fAction}: ${fUrl.length > 60 ? fUrl.slice(0, 57) + "..." : fUrl}`;
      if (fPath) return `${fAction}: ${fPath}`;
      return fAction || undefined;
    }
    default:
      return undefined;
  }
}

export function extractResultPreview(toolName: string, text: string): string | undefined {
  const maxLen = 80;
  try {
    const parsed = JSON.parse(text);
    switch (toolName) {
      case "web_search": {
        const count = parsed.count ?? parsed.results?.length ?? 0;
        const first = parsed.results?.[0]?.title;
        return first
          ? `${count} results — "${first.slice(0, 50)}${first.length > 50 ? "..." : ""}"`
          : `${count} results`;
      }
      case "web_fetch": {
        const title = parsed.title;
        const chars = parsed.charCount;
        if (title) return `"${title.slice(0, 50)}${title.length > 50 ? "..." : ""}" (${chars ?? "?"} chars)`;
        return chars ? `${chars} chars fetched` : undefined;
      }
      case "memory": {
        const status = parsed.status;
        const count = parsed.count;
        if (count !== undefined) return `${status}: ${count} items`;
        return status ?? undefined;
      }
      case "screenshot": {
        const title = parsed.title;
        return title ? `"${title.slice(0, 50)}"` : "captured";
      }
      default:
        return undefined;
    }
  } catch {
    if (!text || text.length < 5) return undefined;
    const firstLine = text.split("\n")[0].trim();
    if (firstLine.length <= maxLen) return firstLine;
    return firstLine.slice(0, maxLen - 3) + "...";
  }
}

export function extractAssistantResponse(messages: unknown[]): {
  text: string;
  images: ImageAttachment[];
} {
  const lastAssistant = messages
    .slice()
    .reverse()
    .find(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).role === "assistant",
    );

  if (!lastAssistant) {
    return { text: "", images: [] };
  }

  const rawContent = (lastAssistant as unknown as Record<string, unknown>)
    .content;
  const contentBlocks = Array.isArray(rawContent) ? rawContent : [];

  const texts: string[] = [];
  const images: ImageAttachment[] = [];

  for (const block of contentBlocks) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;

    if (b.type === "text" && typeof b.text === "string") {
      texts.push(b.text);
    } else if (b.type === "image" && typeof b.data === "string") {
      const ext = b.mimeType === "image/jpeg" ? "jpg" : "png";
      images.push({
        data: Buffer.from(b.data as string, "base64"),
        name: `response-${images.length}.${ext}`,
        mimeType: (b.mimeType as string) ?? "image/png",
      });
    }
  }

  return { text: texts.join("\n").trim(), images };
}
