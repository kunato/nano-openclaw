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
  createMemorySearchTool,
  createMemoryGetTool,
} from "./tools.js";
import type { NanoToolDefinition } from "./tools.js";
import type { Scheduler } from "./scheduler.js";
import { buildSystemPrompt } from "./prompt.js";
import { postProcessCitations } from "./agent/citations.js";
import {
  SubagentRegistry,
  buildSubagentSystemPrompt,
  buildAnnounceMessage,
  MAX_SPAWN_DEPTH,
  type AnnounceCallback,
  type SpawnProgressCallback,
  type SubagentToolProgressCallback,
} from "./subagent.js";
import { createSubagentTool } from "./tools/subagent.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SandboxContext } from "./sandbox/types.js";
import { resolveSandboxContext, createSandboxedExecTool } from "./sandbox/index.js";

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
import { MemoryConsolidator } from "./agent/consolidation.js";

const AGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class AgentRunner {
  private config: NanoConfig;
  private memoryStore: MemoryStore;
  private activeSessions = new Map<string, Promise<void>>();
  private activeAbortControllers = new Map<string, AbortController>();
  private scheduler?: Scheduler;
  private cachedSkills: LoadedSkill[] = [];
  private cachedBootstrapContext: string | null = null;
  private sandboxContextCache = new Map<string, SandboxContext>();
  private consolidator: MemoryConsolidator;
  private subagentRegistry: SubagentRegistry;
  private announceCallback?: AnnounceCallback;
  private spawnProgressCallback?: SpawnProgressCallback;
  private subagentToolProgressCallback?: SubagentToolProgressCallback;

  constructor(config: NanoConfig) {
    this.config = config;
    this.memoryStore = new MemoryStore(config.workspaceDir);
    this.consolidator = new MemoryConsolidator({
      config: config.consolidation,
      workspaceDir: config.workspaceDir,
      agentDir: config.agentDir,
    });
    this.subagentRegistry = new SubagentRegistry(config.agentDir);
  }

  setScheduler(scheduler: Scheduler): void {
    this.scheduler = scheduler;
  }

  setAnnounceCallback(callback: AnnounceCallback): void {
    this.announceCallback = callback;
  }

  setSpawnProgressCallback(callback: SpawnProgressCallback): void {
    this.spawnProgressCallback = callback;
  }

  setSubagentToolProgressCallback(callback: SubagentToolProgressCallback): void {
    this.subagentToolProgressCallback = callback;
  }

  getSubagentRegistry(): SubagentRegistry {
    return this.subagentRegistry;
  }

  /**
   * Spawn a background subagent that runs in an isolated session.
   * The result is auto-announced back to the parent session when complete.
   */
  async spawnSubagent(params: {
    task: string;
    parentSessionKey: string;
    parentChannelId: string;
    label?: string;
  }): Promise<{ runId: string; childSessionKey: string }> {
    const runId = randomUUID();
    const childSessionKey = `subagent:${runId.slice(0, 8)}`;
    const parentDepth = this.subagentRegistry.getDepthForSession(params.parentSessionKey);
    const childDepth = parentDepth + 1;

    console.log(`[subagent.spawn] runId=${runId.slice(0, 8)}, parentSession=${params.parentSessionKey}, parentChannel=${params.parentChannelId}, depth=${childDepth}, label=${params.label || 'none'}`);

    // Register the run before starting
    this.subagentRegistry.register({
      runId,
      childSessionKey,
      parentSessionKey: params.parentSessionKey,
      parentChannelId: params.parentChannelId,
      task: params.task,
      label: params.label,
      depth: childDepth,
      status: "running",
      createdAt: Date.now(),
    });

    const startedAt = Date.now();
    const totalSpawned = this.subagentRegistry.countActiveForSession(params.parentSessionKey);
    console.log(`[subagent.spawn] Active children for session: ${totalSpawned}`);

    // Notify spawn progress to channel
    if (this.spawnProgressCallback) {
      console.log(`[subagent.spawn] Calling spawnProgressCallback (parentChannelId=${params.parentChannelId})`);
      this.spawnProgressCallback({
        parentSessionKey: params.parentSessionKey,
        parentChannelId: params.parentChannelId,
        runId,
        label: params.label,
        task: params.task,
        depth: childDepth,
        totalSpawned,
      }).catch((err) => {
        console.error(`[subagent.spawn] Spawn progress callback FAILED:`, err);
      });
    } else {
      console.log(`[subagent.spawn] WARNING: No spawnProgressCallback set`);
    }

    // Fire-and-forget: run the subagent in the background
    const run = async () => {
      const childSystemPrompt = buildSubagentSystemPrompt({
        parentSessionKey: params.parentSessionKey,
        childSessionKey,
        task: params.task,
        label: params.label,
        depth: childDepth,
        maxDepth: MAX_SPAWN_DEPTH,
      });

      const msg: InboundMessage = {
        text: params.task,
        sessionKey: childSessionKey,
        channelId: params.parentChannelId,
        userId: "system",
        userName: "parent-agent",
        isGroup: false,
      };

      // Build stream callbacks for subagent so tool progress is visible
      const subagentStream: StreamCallbacks = {};
      if (this.subagentToolProgressCallback) {
        const progressCb = this.subagentToolProgressCallback;
        const subLabel = params.label;
        const subChannelId = params.parentChannelId;
        const subRunId = runId;
        const subToolTimers = new Map<string, number>();

        subagentStream.onToolStart = async (toolName: string, meta?: string) => {
          subToolTimers.set(toolName, Date.now());
          progressCb({
            parentChannelId: subChannelId,
            runId: subRunId,
            label: subLabel,
            event: "tool_start",
            toolName,
            meta,
          }).catch(() => {});
        };
        subagentStream.onToolEnd = async (
          toolName: string,
          info: { durationMs: number; error?: string; preview?: string },
        ) => {
          subToolTimers.delete(toolName);
          progressCb({
            parentChannelId: subChannelId,
            runId: subRunId,
            label: subLabel,
            event: "tool_end",
            toolName,
            durationMs: info.durationMs,
            error: info.error,
            preview: info.preview,
          }).catch(() => {});
        };
      }

      let resultText: string;
      let status: "ok" | "error";
      try {
        console.log(`[subagent.run] Starting _handleMessage for ${runId.slice(0, 8)} (${params.label || 'no label'})`);
        const response = await this._handleMessage(msg, subagentStream, { extraSystemPrompt: childSystemPrompt });
        resultText = response?.text || "(no output)";
        status = "ok";
        console.log(`[subagent.run] Completed ${runId.slice(0, 8)}: status=ok, resultLen=${resultText.length}`);
      } catch (err) {
        resultText = err instanceof Error ? err.message : String(err);
        status = "error";
        console.error(`[subagent.run] Failed ${runId.slice(0, 8)}: ${resultText.slice(0, 200)}`);
      }

      const endedAt = Date.now();
      this.subagentRegistry.markComplete(runId, resultText, status);

      console.log(
        `[subagent] ${params.label || runId.slice(0, 8)} ${status} in ${Math.round((endedAt - startedAt) / 1000)}s`,
      );

      // Announce result back to parent session
      if (this.announceCallback) {
        console.log(`[subagent.announce] Announcing ${runId.slice(0, 8)} (${status}) to ${params.parentSessionKey}, channelId=${params.parentChannelId}`);
        try {
          await this.announceCallback({
            parentSessionKey: params.parentSessionKey,
            parentChannelId: params.parentChannelId,
            runId,
            label: params.label,
            task: params.task,
            status,
            result: resultText,
            startedAt,
            endedAt,
          });
        } catch (announceErr) {
          console.error(
            `[subagent] Announce failed for ${runId}:`,
            announceErr instanceof Error ? announceErr.message : String(announceErr),
          );
        }
      }
    };

    run().catch((err) => {
      console.error(`[subagent] Fatal error in ${runId}:`, err);
      this.subagentRegistry.markComplete(runId, String(err), "error");
    });

    return { runId, childSessionKey };
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
    await fs.mkdir(this.config.codeDir, { recursive: true });
    await fs.mkdir(this.config.agentDir, { recursive: true });
    await this.memoryStore.load();
    await this.subagentRegistry.load();
    await this.ensureAgentFiles();

    // Load skills and bootstrap context from workspace
    this.cachedSkills = await loadWorkspaceSkills(this.config.workspaceDir);
    this.cachedBootstrapContext = await loadBootstrapContext(this.config.workspaceDir);

    console.log(`[agent] Workspace: ${this.config.workspaceDir}`);
    console.log(`[agent] Code dir:  ${this.config.codeDir}`);
    console.log(
      `[agent] Model: ${this.config.provider}/${this.config.modelId}`,
    );
    console.log(
      `[agent] Web search: ${this.config.braveApiKey ? "enabled" : "disabled (no BRAVE_API_KEY)"}`,
    );
    console.log(
      `[agent] Sandbox: ${this.config.sandbox.enabled ? `enabled (scope=${this.config.sandbox.scope}, image=${this.config.sandbox.docker.image})` : "disabled"}`,
    );
  }

  /**
   * Resolve sandbox context for a session (creates/reuses Docker container).
   * Caches per session key to avoid re-resolving on every message.
   */
  private async resolveSandbox(sessionKey: string): Promise<SandboxContext | null> {
    if (!this.config.sandbox.enabled) return null;

    const cached = this.sandboxContextCache.get(
      this.config.sandbox.scope === "shared" ? "__shared__" : sessionKey,
    );
    if (cached) return cached;

    const ctx = await resolveSandboxContext({
      config: this.config.sandbox,
      sessionKey,
      workspaceDir: this.config.codeDir,
    });
    if (ctx) {
      const cacheKey = this.config.sandbox.scope === "shared" ? "__shared__" : sessionKey;
      this.sandboxContextCache.set(cacheKey, ctx);
    }
    return ctx;
  }

  /**
   * Make a direct LLM API call for consolidation (bypasses Pi SDK session).
   * Uses the Anthropic Messages API or OpenAI-compatible chat completions
   * depending on the configured provider.
   */
  private async makeLlmCall(systemPrompt: string, userPrompt: string): Promise<string> {
    if (this.config.provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.config.modelId,
          max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });
      if (!res.ok) {
        throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
      }
      const data = (await res.json()) as {
        content: Array<{ type: string; text?: string }>;
      };
      return data.content
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!)
        .join("");
    }

    // OpenAI-compatible fallback
    const baseUrl = this.config.provider === "openai"
      ? "https://api.openai.com/v1"
      : `https://api.${this.config.provider}.com/v1`;
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.modelId,
        max_tokens: 4096,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`LLM API error: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content ?? "";
  }

  /**
   * Build a fallback model when the Pi SDK built-in registry doesn't have it.
   * Follows OpenClaw's resolveModel pattern: construct the Model object manually
   * using the configured provider, modelId, baseUrl, and sensible defaults.
   * This enables OpenRouter models (e.g. minimax/minimax-m2.5), custom endpoints, etc.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildFallbackModel(): any | undefined {
    const { provider, modelId, baseUrl } = this.config;

    // Default base URLs for known providers
    const KNOWN_BASE_URLS: Record<string, string> = {
      openrouter: "https://openrouter.ai/api/v1",
      openai: "https://api.openai.com/v1",
      groq: "https://api.groq.com/openai/v1",
      cerebras: "https://api.cerebras.ai/v1",
      mistral: "https://api.mistral.ai/v1",
      xai: "https://api.x.ai/v1",
      minimax: "https://api.minimax.chat/v1",
      "minimax-cn": "https://api.minimax.chat/v1",
      huggingface: "https://api-inference.huggingface.co/v1",
      "vercel-ai-gateway": "https://ai-gateway.vercel.sh/v1",
    };

    // Known providers that use anthropic-messages API
    const ANTHROPIC_API_PROVIDERS = new Set(["anthropic"]);
    // Known providers that use openai-responses API
    const RESPONSES_API_PROVIDERS = new Set(["openai", "azure-openai-responses"]);

    const resolvedBaseUrl = baseUrl || KNOWN_BASE_URLS[provider];
    if (!resolvedBaseUrl) {
      console.warn(`[agent] No base URL for provider "${provider}". Set MODEL_BASE_URL env var.`);
      return undefined;
    }

    // Determine the API type based on provider
    let api: string;
    if (ANTHROPIC_API_PROVIDERS.has(provider)) {
      api = "anthropic-messages";
    } else if (RESPONSES_API_PROVIDERS.has(provider)) {
      api = "openai-responses";
    } else {
      // OpenRouter and most custom providers are OpenAI-completions compatible
      api = "openai-completions";
    }

    console.log(`[agent] Building fallback model: provider=${provider}, modelId=${modelId}, api=${api}, baseUrl=${resolvedBaseUrl}`);

    return {
      id: modelId,
      name: modelId,
      api,
      provider,
      baseUrl: resolvedBaseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    };
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

  private async writeDebugLog(logPath: string, entry: Record<string, unknown>): Promise<void> {
    try {
      let entries: Array<Record<string, unknown>> = [];
      try {
        const existing = await fs.readFile(logPath, "utf-8");
        entries = JSON.parse(existing);
        if (!Array.isArray(entries)) entries = [];
      } catch {
        // File doesn't exist or is invalid, start fresh
      }
      
      // Keep only last 100 entries to prevent unbounded growth
      entries.push(entry);
      if (entries.length > 100) {
        entries = entries.slice(-100);
      }
      
      await fs.writeFile(logPath, JSON.stringify(entries, null, 2));
    } catch (err) {
      console.warn(`[debug] Failed to write debug log:`, err instanceof Error ? err.message : String(err));
    }
  }

  private buildCustomTools(sessionKey: string, channelId?: string): NanoToolDefinition[] {
    const tools: NanoToolDefinition[] = [];

    tools.push(createMemoryTool(this.memoryStore));

    // Citation-aware memory search + get tools (search across memory/*.md files)
    tools.push(
      createMemorySearchTool({
        workspaceDir: this.config.workspaceDir,
        citationsMode: this.config.consolidation.citations,
        sessionKey,
      }),
    );
    tools.push(createMemoryGetTool({ workspaceDir: this.config.workspaceDir }));

    tools.push(createWebFetchTool({
      firecrawlApiKey: this.config.firecrawl.apiKey,
      firecrawlBaseUrl: this.config.firecrawl.baseUrl,
      firecrawlOnlyMainContent: this.config.firecrawl.onlyMainContent,
      allowLocalhost: this.config.allowLocalhost,
    }));

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

    // Subagent tool — allows spawning parallel background agent runs
    tools.push(
      createSubagentTool(
        this.subagentRegistry,
        this.spawnSubagent.bind(this),
        sessionKey,
        channelId || "unknown",
      ),
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
    opts?: { extraSystemPrompt?: string },
  ): Promise<OutboundMessage | null> {
    const sessionFile = this.resolveSessionFile(msg.sessionKey);
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });

    // Debug logging: capture turn input
    const turnId = randomUUID().slice(0, 8);
    const debugLogPath = path.join(this.config.agentDir, "debug.json");
    const debugEntry: Record<string, unknown> = {
      turnId,
      timestamp: new Date().toISOString(),
      sessionKey: msg.sessionKey,
      input: {
        text: msg.text,
        userId: msg.userId,
        userName: msg.userName,
        channelId: msg.channelId,
        isGroup: msg.isGroup,
        hasImages: !!msg.images?.length,
      },
      tools: [] as Array<{ name: string; args: unknown; result: unknown; error?: string; durationMs: number }>,
    };
    console.log(`[debug] Turn ${turnId} started: ${msg.text.slice(0, 80)}`);

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
    let model = modelRegistry.find(
      this.config.provider,
      this.config.modelId,
    );

    // Fallback model resolution (follows OpenClaw's resolveModel pattern):
    // When the model isn't in the Pi SDK built-in registry, construct one.
    // This enables OpenRouter models (e.g. minimax/minimax-m2.5) and custom endpoints.
    if (!model) {
      const fallback = this.buildFallbackModel();
      if (fallback) {
        model = fallback as typeof model;
        console.log(`[agent] Using fallback model: ${this.config.provider}/${this.config.modelId} (api=${fallback.api}, baseUrl=${fallback.baseUrl})`);
      } else {
        console.error(
          `[agent] Model not found: ${this.config.provider}/${this.config.modelId}`,
        );
        return {
          text: `Error: model ${this.config.provider}/${this.config.modelId} not found in Pi SDK registry.`,
        };
      }
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

    // Resolve sandbox context (creates Docker container if enabled)
    const sandbox = await this.resolveSandbox(msg.sessionKey);

    // Custom tools
    const customTools = this.buildCustomTools(msg.sessionKey, msg.channelId);
    console.log(`[debug] Built ${customTools.length} custom tools: ${customTools.map(t => t.name).join(', ')}`);

    // When sandbox is enabled, add the sandboxed exec tool and filter out
    // the built-in bash/exec from codingTools (same pattern as OpenClaw's
    // createOpenClawCodingTools which does: if tool.name === "bash" || "exec" → skip)
    if (sandbox) {
      customTools.push(createSandboxedExecTool(sandbox));
    }
    const tools = sandbox
      ? (codingTools as unknown as Array<{ name: string }>).filter(
          (t) => t.name !== "bash" && t.name !== "exec",
        )
      : codingTools;

    console.log(`[debug] Total tools for session: ${tools.length} built-in + ${customTools.length} custom`);
    console.log(`[debug] Custom tools: ${customTools.map(t => t.name).join(', ')}`);

    // Create agent session — cwd is codeDir so coding tools operate in the isolated code directory
    const { session } = await createAgentSession({
      cwd: this.config.codeDir,
      agentDir: this.config.agentDir,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: this.config.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high",
      tools: tools as typeof codingTools,
      customTools: customTools as never[],
      sessionManager,
      settingsManager,
    });

    session.agent.streamFn = streamSimple;

    // Set system prompt with current time, skills, bootstrap context, and sandbox info
    // Read persistent memory for injection into system prompt
    const memoryContext = await this.consolidator.readMemory();

    // Derive channel name from session key (e.g. "discord:dm:123" → "Discord")
    const channelName = msg.sessionKey.split(":")[0] ?? "unknown";
    const channelLabel = channelName.charAt(0).toUpperCase() + channelName.slice(1);

    const systemPrompt = buildSystemPrompt({
      workspaceDir: this.config.workspaceDir,
      hasWebSearch: Boolean(this.config.braveApiKey),
      memoryContext: memoryContext ?? undefined,
      citationsMode: this.config.consolidation.citations,
      channelContext: [
        `Platform: ${channelLabel}`,
        "User: " + msg.userName + " (ID: " + msg.userId + ")",
        msg.isGroup ? "Group chat" : "Direct message",
      ].join(" | "),
      skillsSection: formatSkillsForPrompt(this.cachedSkills),
      bootstrapContext: this.cachedBootstrapContext ?? undefined,
      currentTime: new Date().toISOString(),
      sandbox: sandbox
        ? {
            containerName: sandbox.containerName,
            workdir: sandbox.containerWorkdir,
            image: sandbox.config.docker.image,
            network: sandbox.config.docker.network,
            readOnlyRoot: sandbox.config.docker.readOnlyRoot,
          }
        : undefined,
    });
    // Append extra system prompt for subagent context
    const finalSystemPrompt = opts?.extraSystemPrompt
      ? systemPrompt + "\n\n---\n\n" + opts.extraSystemPrompt
      : systemPrompt;
    // Set Pi system prompt
    session.agent.setSystemPrompt(finalSystemPrompt);
    // Override Pi SDK's internal prompt rebuilding
    const mutableSession = session as unknown as {
      _baseSystemPrompt?: string;
      _rebuildSystemPrompt?: (toolNames: string[]) => string;
    };
    mutableSession._baseSystemPrompt = finalSystemPrompt;
    mutableSession._rebuildSystemPrompt = () => finalSystemPrompt;

    // Subscribe to session events for streaming feedback
    const collectedImages: ImageAttachment[] = [];
    const toolTimers = new Map<string, number>();
    const toolDebugMap = new Map<string, { name: string; args: unknown; startTime: number }>();
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
            const startTime = Date.now();
            toolTimers.set(toolCallId, startTime);
            toolDebugMap.set(toolCallId, { name: toolName, args: evt.args, startTime });
            stream.onToolStart?.(toolName, meta);
            break;
          }
          case "tool_execution_end": {
            const toolName = String(evt.toolName ?? "tool");
            const toolCallId = String(evt.toolCallId ?? toolName);
            const startTime = toolTimers.get(toolCallId) ?? Date.now();
            const durationMs = Date.now() - startTime;
            toolTimers.delete(toolCallId);
            
            // Capture tool call for debug log
            const toolDebug = toolDebugMap.get(toolCallId);
            if (toolDebug) {
              const result = evt.result as Record<string, unknown> | undefined;
              const content = result?.content;
              let resultText: string | undefined;
              let errorText: string | undefined;
              
              if (Array.isArray(content)) {
                const textBlock = content.find(
                  (b: unknown) =>
                    typeof b === "object" &&
                    b !== null &&
                    (b as Record<string, unknown>).type === "text",
                ) as { text?: string } | undefined;
                if (textBlock?.text) {
                  if (textBlock.text.startsWith("Error:") || textBlock.text.includes('"status": "error"')) {
                    errorText = textBlock.text.slice(0, 500);
                  } else {
                    resultText = textBlock.text.slice(0, 500);
                  }
                }
              }
              
              (debugEntry.tools as Array<unknown>).push({
                name: toolDebug.name,
                args: toolDebug.args,
                result: resultText,
                error: errorText,
                durationMs,
              });
              toolDebugMap.delete(toolCallId);
            }

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
          // Run actual prompt [Run agent loop until error / stop]
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

          // Post-process citations in the final response
          const processedText = text
            ? await postProcessCitations({
                text,
                citationsMode: this.config.consolidation.citations,
                workspaceDir: this.config.workspaceDir,
                isGroup: msg.isGroup,
              })
            : "(no text response)";

          // Debug logging: capture turn output
          debugEntry.output = {
            text: processedText,
            hasImages: allImages.length > 0,
            imageCount: allImages.length,
          };
          debugEntry.elapsed = Date.now() - startTime;
          await this.writeDebugLog(debugLogPath, debugEntry);
          console.log(`[debug] Turn ${turnId} completed: ${(debugEntry.tools as Array<unknown>).length} tools, ${debugEntry.elapsed}ms`);

          return {
            text: processedText,
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
      // noop — falls through to the error handler below
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[agent] Unexpected error:`, err);
      return { text: `Error: ${errMsg}` };
    } finally {
      // Run LLM-driven memory consolidation (non-blocking — errors are logged, not thrown)
      try {
        const allMessages = session.messages as Array<{ role?: string; content?: unknown }>;
        if (Array.isArray(allMessages) && allMessages.length > 0) {
          const shouldConsolidate = await this.consolidator.shouldConsolidate(
            msg.sessionKey,
            allMessages.length,
          );
          if (shouldConsolidate) {
            const messagesForConsolidation = allMessages
              .filter((m) => m.role && m.content)
              .map((m) => ({
                role: m.role as string,
                content: typeof m.content === "string"
                  ? m.content
                  : JSON.stringify(m.content).slice(0, 2000),
              }));

            await this.consolidator.consolidate(
              msg.sessionKey,
              messagesForConsolidation,
              allMessages.length,
              this.makeLlmCall.bind(this),
            );
          }
        }
      } catch (consolidationErr) {
        console.warn(
          `[agent] Memory consolidation failed (non-critical):`,
          consolidationErr instanceof Error ? consolidationErr.message : String(consolidationErr),
        );
      }

      this.activeAbortControllers.delete(msg.sessionKey);
      unsubscribe();
      session.dispose();
    }
  }
}
