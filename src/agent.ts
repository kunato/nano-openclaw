import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  codingTools,
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { streamSimple } from "@mariozechner/pi-ai";
import type { NanoConfig } from "./config.js";
import type {
  ImageAttachment,
  InboundMessage,
  OutboundMessage,
  StreamCallbacks,
} from "./channels/base.js";
import { MemoryStore } from "./memory.js";
import {
  createMemoryTool,
  createWebSearchTool,
  createWebFetchTool,
  createReminderTool,
  createBrowserTool,
  createFileOpsTool,
} from "./tools.js";
import type { NanoToolDefinition } from "./tools.js";
import type { Scheduler } from "./scheduler.js";
import { buildSystemPrompt } from "./prompt.js";
import fs from "node:fs/promises";
import path from "node:path";

import {
  wrapToolWithImageNormalization,
  wrapToolWithResultTruncation,
} from "./agent/tool-wrappers.js";
import { normalizeImage } from "./media/image-ops.js";
import { maybeRunMemoryFlush } from "./agent/memory-flush.js";
import { resolvePromptError } from "./agent/context-overflow.js";
import { ensureCompactionReserveTokens } from "./agent/compaction.js";
import {
  inferToolMeta,
  extractResultPreview,
  extractAssistantResponse,
} from "./agent/utils.js";
import {
  loadWorkspaceSkills,
  loadBootstrapContext,
  formatSkillsForPrompt,
} from "./agent/skills.js";
import type { LoadedSkill } from "./agent/skills.js";
import { sanitizeSessionHistory } from "./agent/history.js";
import { repairSessionFileIfNeeded } from "./agent/session-repair.js";

const AGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class AgentRunner {
  private config: NanoConfig;
  private memoryStore: MemoryStore;
  private activeSessions = new Map<string, Promise<void>>();
  private activeAbortControllers = new Map<string, AbortController>();
  private scheduler?: Scheduler;
  private cachedSkills: LoadedSkill[] = [];
  private cachedBootstrapContext: string | null = null;

  constructor(config: NanoConfig) {
    this.config = config;
    this.memoryStore = new MemoryStore(config.workspaceDir);
  }

  setScheduler(scheduler: Scheduler): void {
    this.scheduler = scheduler;
  }

  /**
   * Abort a running agent session. Returns true if there was something to abort.
   */
  abortSession(sessionKey: string): boolean {
    const controller = this.activeAbortControllers.get(sessionKey);
    if (!controller) return false;
    controller.abort(new Error("Aborted by user"));
    return true;
  }

  /** Check if a session is currently running. */
  isSessionActive(sessionKey: string): boolean {
    return this.activeAbortControllers.has(sessionKey);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.config.workspaceDir, { recursive: true });
    await fs.mkdir(this.config.agentDir, { recursive: true });
    await this.memoryStore.load();
    await this.ensureAgentFiles();

    // Load skills and bootstrap context from workspace
    this.cachedSkills = await loadWorkspaceSkills(this.config.workspaceDir);
    this.cachedBootstrapContext = await loadBootstrapContext(this.config.workspaceDir);

    console.log(`[agent] Workspace: ${this.config.workspaceDir}`);
    console.log(
      `[agent] Model: ${this.config.provider}/${this.config.modelId}`,
    );
    console.log(
      `[agent] Web search: ${this.config.braveApiKey ? "enabled" : "disabled (no BRAVE_API_KEY)"}`,
    );
  }

  private async ensureAgentFiles(): Promise<void> {
    const authPath = path.join(this.config.agentDir, "auth.json");
    try {
      await fs.access(authPath);
    } catch {
      await fs.writeFile(authPath, JSON.stringify({}, null, 2));
    }

    const modelsPath = path.join(this.config.agentDir, "models.json");
    try {
      await fs.access(modelsPath);
    } catch {
      await fs.writeFile(modelsPath, JSON.stringify([], null, 2));
    }
  }

  private resolveSessionFile(sessionKey: string): string {
    const safe = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.config.agentDir, "sessions", `${safe}.jsonl`);
  }

  private buildCustomTools(sessionKey: string): NanoToolDefinition[] {
    const tools: NanoToolDefinition[] = [];

    tools.push(createMemoryTool(this.memoryStore));
    tools.push(createWebFetchTool());

    if (this.config.braveApiKey) {
      tools.push(createWebSearchTool(this.config.braveApiKey));
    }

    if (this.scheduler) {
      tools.push(createReminderTool(this.scheduler, sessionKey));
    }

    tools.push(
      createBrowserTool({
        executablePath: this.config.puppeteerExecutable,
        screenshotDir: path.join(this.config.agentDir, "screenshots"),
      }),
    );

    tools.push(
      createFileOpsTool({
        downloadDir: path.join(this.config.agentDir, "downloads"),
      }),
    );

    // Wrap all tools: truncate large text results (prevents context overflow)
    // then normalize images (prevents API size errors). Order matters:
    // truncate first (cheap), then normalize images (expensive).
    return tools
      .map((tool) => wrapToolWithResultTruncation(tool))
      .map(wrapToolWithImageNormalization);
  }

  /**
   * Handle a cron-fired agent turn: run the agent with the given prompt
   * and return the response text (for delivery to the channel).
   */
  async handleCronAgentTurn(
    sessionKey: string,
    prompt: string,
  ): Promise<OutboundMessage | null> {
    const msg: InboundMessage = {
      text: prompt,
      sessionKey: `cron:${sessionKey}`,
      channelId: sessionKey.split(":").slice(-1)[0] || "cron",
      userId: "system",
      userName: "cron",
      isGroup: false,
    };
    return this.handleMessage(msg, {});
  }

  async handleMessage(
    msg: InboundMessage,
    stream: StreamCallbacks = {},
  ): Promise<OutboundMessage | null> {
    // Serialize per session
    const existing = this.activeSessions.get(msg.sessionKey);
    if (existing) {
      try {
        await existing;
      } catch {
        // ignore
      }
    }

    const promise = this._handleMessage(msg, stream);
    this.activeSessions.set(
      msg.sessionKey,
      promise.then(
        () => {},
        () => {},
      ),
    );

    try {
      return await promise;
    } finally {
      this.activeSessions.delete(msg.sessionKey);
    }
  }

  private async _handleMessage(
    msg: InboundMessage,
    stream: StreamCallbacks,
  ): Promise<OutboundMessage | null> {
    const sessionFile = this.resolveSessionFile(msg.sessionKey);
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });

    // Abort controller for this run
    const abortController = new AbortController();
    this.activeAbortControllers.set(msg.sessionKey, abortController);

    // Pi SDK components
    const authStorage = new AuthStorage(
      path.join(this.config.agentDir, "auth.json"),
    );
    authStorage.setRuntimeApiKey(this.config.provider, this.config.apiKey);

    const modelRegistry = new ModelRegistry(
      authStorage,
      path.join(this.config.agentDir, "models.json"),
    );
    const model = modelRegistry.find(
      this.config.provider,
      this.config.modelId,
    );

    if (!model) {
      console.error(
        `[agent] Model not found: ${this.config.provider}/${this.config.modelId}`,
      );
      return {
        text: `Error: model ${this.config.provider}/${this.config.modelId} not found in Pi SDK registry.`,
      };
    }

    // Repair corrupted session file before opening
    await repairSessionFileIfNeeded({
      sessionFile,
      warn: (message) => console.warn(`[agent] ${message}`),
    });

    // Session & settings
    const sessionManager = SessionManager.open(sessionFile);
    const settingsManager = SettingsManager.create(
      this.config.workspaceDir,
      this.config.agentDir,
    );

    ensureCompactionReserveTokens(settingsManager);

    // Custom tools
    const customTools = this.buildCustomTools(msg.sessionKey);

    // Create agent session
    const { session } = await createAgentSession({
      cwd: this.config.workspaceDir,
      agentDir: this.config.agentDir,
      authStorage,
      modelRegistry,
      model,
      tools: codingTools,
      customTools: customTools as never[],
      sessionManager,
      settingsManager,
    });

    session.agent.streamFn = streamSimple;

    // Set system prompt with current time, skills, and bootstrap context
    const systemPrompt = buildSystemPrompt({
      workspaceDir: this.config.workspaceDir,
      hasWebSearch: Boolean(this.config.braveApiKey),
      channelContext: [
        "Platform: Discord",
        "User: " + msg.userName + " (ID: " + msg.userId + ")",
        msg.isGroup ? "Group chat" : "Direct message",
      ].join(" | "),
      skillsSection: formatSkillsForPrompt(this.cachedSkills),
      bootstrapContext: this.cachedBootstrapContext ?? undefined,
      currentTime: new Date().toISOString(),
    });
    session.agent.setSystemPrompt(systemPrompt);
    // Override Pi SDK's internal prompt rebuilding
    const mutableSession = session as unknown as {
      _baseSystemPrompt?: string;
      _rebuildSystemPrompt?: (toolNames: string[]) => string;
    };
    mutableSession._baseSystemPrompt = systemPrompt;
    mutableSession._rebuildSystemPrompt = () => systemPrompt;

    // Subscribe to session events for streaming feedback
    const collectedImages: ImageAttachment[] = [];
    const toolTimers = new Map<string, number>();
    let thinkingEmitted = false;

    const unsubscribe = session.subscribe(
      (evt: { type: string; [k: string]: unknown }) => {
        switch (evt.type) {
          case "assistant_text": {
            // Emit thinking indicator once when the model starts generating
            if (!thinkingEmitted) {
              thinkingEmitted = true;
              stream.onThinking?.();
            }
            break;
          }
          case "tool_execution_start": {
            const toolName = String(evt.toolName ?? "tool");
            const toolCallId = String(evt.toolCallId ?? toolName);
            const meta = inferToolMeta(toolName, evt.args);
            toolTimers.set(toolCallId, Date.now());
            stream.onToolStart?.(toolName, meta);
            break;
          }
          case "tool_execution_end": {
            const toolName = String(evt.toolName ?? "tool");
            const toolCallId = String(evt.toolCallId ?? toolName);
            const startTime = toolTimers.get(toolCallId) ?? Date.now();
            const durationMs = Date.now() - startTime;
            toolTimers.delete(toolCallId);

            const result = evt.result as Record<string, unknown> | undefined;
            const content = result?.content;
            let error: string | undefined;
            let preview: string | undefined;

            if (Array.isArray(content)) {
              const textBlock = content.find(
                (b: unknown) =>
                  typeof b === "object" &&
                  b !== null &&
                  (b as Record<string, unknown>).type === "text",
              ) as { text?: string } | undefined;

              if (
                textBlock?.text?.startsWith("Error:") ||
                textBlock?.text?.includes('"status": "error"')
              ) {
                error = textBlock.text.slice(0, 200);
              } else if (textBlock?.text) {
                // Extract a useful preview from the result
                preview = extractResultPreview(toolName, textBlock.text);
              }

              // Collect images from tool results (e.g. screenshots)
              // Images are already normalized by wrapToolWithImageNormalization.
              for (const block of content) {
                if (
                  typeof block === "object" &&
                  block !== null &&
                  (block as Record<string, unknown>).type === "image"
                ) {
                  const imgBlock = block as {
                    data?: string;
                    mimeType?: string;
                  };
                  if (imgBlock.data) {
                    const ext =
                      imgBlock.mimeType === "image/jpeg" ? "jpg" : "png";
                    collectedImages.push({
                      data: Buffer.from(imgBlock.data, "base64"),
                      name: `${toolName}-${collectedImages.length}.${ext}`,
                      mimeType: imgBlock.mimeType ?? "image/png",
                    });
                    if (!preview) preview = "captured image";
                  }
                }
              }
            }
            stream.onToolEnd?.(toolName, { durationMs, error, preview });
            break;
          }
        }
      },
    );

    try {
      const startTime = Date.now();

      // Memory flush: save important context before auto-compaction
      try {
        await maybeRunMemoryFlush(session, msg.sessionKey);
      } catch (flushErr) {
        console.warn(
          `[agent] Memory flush failed (continuing): ${flushErr instanceof Error ? flushErr.message : String(flushErr)}`,
        );
      }

      // ── Sanitize session history (limit turns + repair tool pairing) ─
      try {
        const original = session.messages;
        if (Array.isArray(original) && original.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sanitized = sanitizeSessionHistory(original as any[]);
          if (sanitized.length < original.length) {
            console.log(
              `[agent] History trimmed: ${original.length} → ${sanitized.length} messages for ${msg.sessionKey}`,
            );
            if (typeof session.agent?.replaceMessages === "function") {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              session.agent.replaceMessages(sanitized as any[]);
            }
          }
        }
      } catch (err) {
        console.warn(
          `[agent] History sanitization failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // ── Normalize inbound images for vision models ─────────────────
      type PromptImage = { type: "image"; data: string; mimeType: string };
      const promptImages: PromptImage[] = [];
      if (msg.images && msg.images.length > 0) {
        for (const img of msg.images) {
          try {
            const normalized = await normalizeImage(img.data, {
              maxSide: 2000,
              maxBytes: 5 * 1024 * 1024,
            });
            promptImages.push({
              type: "image",
              data: normalized.buffer.toString("base64"),
              mimeType: normalized.mimeType,
            });
          } catch (err) {
            console.warn(
              `[agent] Failed to normalize inbound image: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        if (promptImages.length > 0) {
          console.log(`[agent] Passing ${promptImages.length} image(s) to prompt`);
        }
      }

      // ── Retry loop with abort support ──────────────────────────────
      const MAX_PROMPT_ATTEMPTS = 3;
      for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt++) {
        const timeoutId = setTimeout(() => {
          abortController.abort(new Error("Agent timed out after 5 minutes"));
        }, AGENT_TIMEOUT_MS);

        const onAbort = () => { try { session.abort(); } catch {} };
        abortController.signal.addEventListener("abort", onAbort, { once: true });

        let promptError: string | undefined;

        try {
          if (promptImages.length > 0) {
            await session.prompt(msg.text, { images: promptImages });
          } else {
            await session.prompt(msg.text);
          }
        } catch (err) {
          promptError = err instanceof Error ? err.message : String(err);
          console.error(`[agent] Prompt error (attempt ${attempt}):`, promptError);
        } finally {
          clearTimeout(timeoutId);
          abortController.signal.removeEventListener("abort", onAbort);
        }

        // Check if the last message is an API error (some errors surface here instead of throwing)
        if (!promptError) {
          const lastMsg = session.messages[session.messages.length - 1];
          if (
            lastMsg &&
            typeof lastMsg === "object" &&
            (lastMsg as { stopReason?: string }).stopReason === "error"
          ) {
            promptError = (lastMsg as { errorMessage?: string }).errorMessage ?? "Unknown API error";
            console.error(`[agent] API error (attempt ${attempt}):`, promptError);
          }
        }

        // No error — extract response and return
        if (!promptError) {
          const elapsed = Date.now() - startTime;
          console.log(`[agent] Prompt completed in ${elapsed}ms for ${msg.sessionKey}`);

          const { text, images } = extractAssistantResponse(session.messages);
          const allImages = [...collectedImages, ...images];
          return {
            text: text || "(no text response)",
            images: allImages.length > 0 ? allImages : undefined,
          };
        }

        // Abort signal fired — don't retry
        if (abortController.signal.aborted) {
          return { text: "🛑 Task was stopped." };
        }

        // Resolve error → retry or respond
        const resolution = await resolvePromptError({
          error: promptError,
          sessionFile,
          sessionKey: msg.sessionKey,
          session,
          attempt,
        });

        if (resolution.action === "respond") {
          return { text: resolution.text };
        }

        // action === "retry" — wait if needed, then loop
        if (resolution.delayMs) {
          console.log(`[agent] Waiting ${resolution.delayMs}ms before retry...`);
          await new Promise((r) => setTimeout(r, resolution.delayMs));
        }
      }

      // Exhausted all attempts
      return { text: "Error: Failed after multiple retry attempts." };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[agent] Unexpected error:`, err);
      return { text: `Error: ${errMsg}` };
    } finally {
      this.activeAbortControllers.delete(msg.sessionKey);
      unsubscribe();
      session.dispose();
    }
  }
}
