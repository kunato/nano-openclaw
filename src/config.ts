import { config } from "dotenv";
import path from "node:path";
import os from "node:os";

config();

export interface NanoConfig {
  provider: string;
  modelId: string;
  apiKey: string;
  workspaceDir: string;
  discordToken: string;
  agentDir: string;
  braveApiKey?: string;
  puppeteerExecutable?: string;
}

export function loadConfig(): NanoConfig {
  const provider = process.env.MODEL_PROVIDER || "anthropic";
  const modelId = process.env.MODEL_ID || "claude-sonnet-4-20250514";
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) throw new Error("MODEL_API_KEY is required");

  const discordToken = process.env.DISCORD_TOKEN;
  if (!discordToken) throw new Error("DISCORD_TOKEN is required");

  const workspaceDir =
    process.env.WORKSPACE_DIR?.trim() ||
    path.join(os.homedir(), "nano-openclaw-workspace");

  const agentDir =
    process.env.AGENT_DIR?.trim() ||
    path.join(os.homedir(), ".nano-openclaw");

  const braveApiKey = process.env.BRAVE_API_KEY?.trim() || undefined;
  const puppeteerExecutable = process.env.PUPPETEER_EXECUTABLE?.trim() || undefined;

  return {
    provider,
    modelId,
    apiKey,
    workspaceDir,
    discordToken,
    agentDir,
    braveApiKey,
    puppeteerExecutable,
  };
}
