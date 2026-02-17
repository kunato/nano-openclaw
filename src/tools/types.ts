export interface NanoToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: unknown,
    onUpdate?: unknown,
    ctx?: unknown,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function jsonTextResult(payload: unknown) {
  return textResult(JSON.stringify(payload, null, 2));
}
