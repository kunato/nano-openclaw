import { config } from "dotenv";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { SandboxConfig } from "./sandbox/types.js";
import { defaultSandboxConfig, defaultSandboxDockerConfig } from "./sandbox/types.js";

/** Resolve the repo-local workspace/ directory (sibling of src/). */
function resolveDefaultWorkspaceDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(thisFile), "..");
  return path.join(repoRoot, "workspace");
}

config();

export interface WhatsAppConfig {
  enabled: boolean;
  /** Directory to persist WhatsApp auth state (QR login). */
  authDir: string;
  /** Optional allowlist of phone numbers / JIDs that may interact. */
  allowFrom?: string[];
}

export interface SlackConfig {
  enabled: boolean;
  /** Bot token (xoxb-…) */
  botToken: string;
  /** App-level token (xapp-…) for Socket Mode */
  appToken: string;
  /** Optional allowlist of Slack user IDs. */
  allowFrom?: string[];
}

export interface ChannelsConfig {
  discord: { enabled: boolean; token: string };
  whatsapp: WhatsAppConfig;
  slack: SlackConfig;
}

export interface ConsolidationConfig {
  /** Enable LLM-driven memory consolidation. */
  enabled: boolean;
  /** Number of messages since last consolidation before triggering. */
  messageThreshold: number;
}

export interface NanoConfig {
  provider: string;
  modelId: string;
  apiKey: string;
  workspaceDir: string;
  /** Subdirectory of workspaceDir where the agent's coding tools operate. */
  codeDir: string;
  agentDir: string;
  braveApiKey?: string;
  puppeteerExecutable?: string;
  sandbox: SandboxConfig;
  channels: ChannelsConfig;
  consolidation: ConsolidationConfig;
}

function parseAllowList(envVar: string | undefined): string[] | undefined {
  if (!envVar?.trim()) return undefined;
  return envVar.split(",").map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(): NanoConfig {
  const provider = process.env.MODEL_PROVIDER || "anthropic";
  const modelId = process.env.MODEL_ID || "claude-sonnet-4-20250514";
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) throw new Error("MODEL_API_KEY is required");

  // If WORKSPACE_DIR is set, use that. Otherwise use the repo's workspace/ directory.
  const workspaceDir =
    process.env.WORKSPACE_DIR?.trim() || resolveDefaultWorkspaceDir();

  // Code directory: where agent coding tools (read/write/edit/bash) operate.
  // Keeps code isolated from workspace-level files (AGENTS.md, skills/, memory/).
  const codeDir = path.join(workspaceDir, "code");

  const agentDir =
    process.env.AGENT_DIR?.trim() ||
    path.join(os.homedir(), ".nano-openclaw");

  const braveApiKey = process.env.BRAVE_API_KEY?.trim() || undefined;
  const puppeteerExecutable = process.env.PUPPETEER_EXECUTABLE?.trim() || undefined;

  // Channel configs — each channel is optional
  const discordToken = process.env.DISCORD_TOKEN?.trim() || "";
  const channels: ChannelsConfig = {
    discord: {
      enabled: Boolean(discordToken),
      token: discordToken,
    },
    whatsapp: {
      enabled: process.env.WHATSAPP_ENABLED === "true" || process.env.WHATSAPP_ENABLED === "1",
      authDir: process.env.WHATSAPP_AUTH_DIR?.trim() || path.join(agentDir, "whatsapp-auth"),
      allowFrom: parseAllowList(process.env.WHATSAPP_ALLOW_FROM),
    },
    slack: {
      enabled: Boolean(process.env.SLACK_BOT_TOKEN?.trim() && process.env.SLACK_APP_TOKEN?.trim()),
      botToken: process.env.SLACK_BOT_TOKEN?.trim() || "",
      appToken: process.env.SLACK_APP_TOKEN?.trim() || "",
      allowFrom: parseAllowList(process.env.SLACK_ALLOW_FROM),
    },
  };

  const enabledChannels = [
    channels.discord.enabled && "discord",
    channels.whatsapp.enabled && "whatsapp",
    channels.slack.enabled && "slack",
  ].filter(Boolean);
  if (enabledChannels.length === 0) {
    throw new Error("At least one channel must be configured (DISCORD_TOKEN, WHATSAPP_ENABLED, or SLACK_BOT_TOKEN+SLACK_APP_TOKEN)");
  }

  // Memory consolidation config
  const consolidation: ConsolidationConfig = {
    enabled: process.env.CONSOLIDATION_ENABLED !== "false" && process.env.CONSOLIDATION_ENABLED !== "0",
    messageThreshold: process.env.CONSOLIDATION_THRESHOLD
      ? parseInt(process.env.CONSOLIDATION_THRESHOLD, 10)
      : 50,
  };

  // Sandbox config from environment
  const sandboxEnabled = process.env.SANDBOX_ENABLED === "true" || process.env.SANDBOX_ENABLED === "1";
  const sandboxDefaults = defaultSandboxDockerConfig();
  const sandbox: SandboxConfig = {
    ...defaultSandboxConfig(),
    enabled: sandboxEnabled,
    scope: (process.env.SANDBOX_SCOPE === "shared" ? "shared" : "session") as SandboxConfig["scope"],
    docker: {
      ...sandboxDefaults,
      image: process.env.SANDBOX_IMAGE?.trim() || sandboxDefaults.image,
      network: process.env.SANDBOX_NETWORK?.trim() || sandboxDefaults.network,
      memory: process.env.SANDBOX_MEMORY?.trim() || undefined,
      cpus: process.env.SANDBOX_CPUS ? parseFloat(process.env.SANDBOX_CPUS) : undefined,
      pidsLimit: process.env.SANDBOX_PIDS_LIMIT ? parseInt(process.env.SANDBOX_PIDS_LIMIT, 10) : 256,
      setupCommand: process.env.SANDBOX_SETUP_COMMAND?.trim() || undefined,
    },
  };

  return {
    provider,
    modelId,
    apiKey,
    workspaceDir,
    codeDir,
    agentDir,
    braveApiKey,
    puppeteerExecutable,
    sandbox,
    channels,
    consolidation,
  };
}
