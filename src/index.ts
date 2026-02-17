import path from "node:path";
import { loadConfig } from "./config.js";
import { AgentRunner } from "./agent.js";
import { DiscordChannel } from "./channels/discord.js";
import { ChannelManager } from "./channels/manager.js";
import { Scheduler } from "./scheduler.js";
import { removeAllSandboxContainers } from "./sandbox/index.js";

async function main() {
  console.log("nano-openclaw starting...");

  const config = loadConfig();

  // Initialize agent runner
  const agent = new AgentRunner(config);
  await agent.init();

  // Build channel manager with enabled channels
  const channels = new ChannelManager();

  if (config.channels.discord.enabled) {
    channels.add(new DiscordChannel(config.channels.discord.token));
  }

  if (config.channels.whatsapp.enabled) {
    const { WhatsAppChannel } = await import("./channels/whatsapp.js");
    channels.add(new WhatsAppChannel(config.channels.whatsapp));
  }

  if (config.channels.slack.enabled) {
    const { SlackChannel } = await import("./channels/slack.js");
    channels.add(new SlackChannel(config.channels.slack));
  }

  console.log(`[channels] Enabled: ${channels.enabledNames.join(", ")}`);

  // Initialize scheduler for cron jobs / reminders
  const schedulerStorePath = path.join(config.agentDir, "cron-store.json");
  const scheduler = new Scheduler(schedulerStorePath, async (job) => {
    // Extract channel name and channel ID from session key (e.g. "discord:channel:123")
    const parts = job.sessionKey.split(":");
    const channelName = parts[0] || "discord";
    const channelId = parts[parts.length - 1];
    if (!channelId) {
      console.error(`[scheduler] Cannot resolve channel from session key: ${job.sessionKey}`);
      return;
    }

    const targetChannel = channels.get(channelName);

    if (job.payload.kind === "systemEvent") {
      console.log(`[scheduler] Delivering systemEvent to ${channelName}:${channelId}: ${job.payload.text.slice(0, 80)}`);
      if (targetChannel && "sendToChannel" in targetChannel) {
        await (targetChannel as { sendToChannel: (id: string, text: string) => Promise<void> }).sendToChannel(channelId, job.payload.text);
      }
    } else if (job.payload.kind === "agentTurn") {
      console.log(`[scheduler] Running agentTurn for ${channelName}:${channelId}: ${job.payload.message.slice(0, 80)}`);
      const response = await agent.handleCronAgentTurn(
        job.sessionKey,
        job.payload.message,
      );
      if (response?.text && targetChannel && "sendToChannel" in targetChannel) {
        const images = response.images?.map((img) => ({
          data: img.data,
          name: img.name,
        }));
        await (targetChannel as { sendToChannel: (id: string, text: string, images?: unknown) => Promise<void> }).sendToChannel(channelId, response.text, images);
        console.log(`[scheduler] Delivered agentTurn result to ${channelName}:${channelId}`);
      }
    }
  });

  // Connect scheduler to agent (so the cron tool is available)
  agent.setScheduler(scheduler);
  await scheduler.start();

  channels.onCommand(async (command, _args, sessionKey, _channelId) => {
    switch (command) {
      case "stop": {
        const aborted = agent.abortSession(sessionKey);
        return aborted
          ? "🛑 Stopping current task..."
          : "No active task to stop.";
      }
      case "reset": {
        // Abort if running, then delete session file
        agent.abortSession(sessionKey);
        const safe = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
        const sessionFile = path.join(config.agentDir, "sessions", `${safe}.jsonl`);
        try {
          const fs = await import("node:fs/promises");
          await fs.unlink(sessionFile);
        } catch { /* ignore if not found */ }
        return "🔄 Session reset. Starting fresh.";
      }
      case "status": {
        const active = agent.isSessionActive(sessionKey);
        return active ? "⚙️ Agent is currently running." : "💤 No active task.";
      }
      case "help":
        return [
          "**Commands:**",
          "`/stop` — Cancel the current agent task",
          "`/reset` — Clear conversation history and start fresh",
          "`/status` — Check if the agent is busy",
          "`/help` — Show this message",
        ].join("\n");
      default:
        return null; // Not a known command — fall through to agent
    }
  });

  channels.onMessage(async (msg, stream) => {
    console.log(
      `[${msg.sessionKey}] ${msg.userName}: ${msg.text.slice(0, 100)}`,
    );
    const response = await agent.handleMessage(msg, stream);
    if (response) {
      const imgCount = response.images?.length ?? 0;
      console.log(
        `[${msg.sessionKey}] bot: ${response.text.slice(0, 80)}...${imgCount ? ` (+${imgCount} images)` : ""}`,
      );
    }
    return response;
  });

  await channels.startAll();
  console.log("nano-openclaw ready.");

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    scheduler.stop();
    await channels.stopAll();
    if (config.sandbox.enabled) {
      console.log("[sandbox] Cleaning up containers...");
      const result = await removeAllSandboxContainers();
      if (result.removed.length > 0) {
        console.log(`[sandbox] Removed ${result.removed.length} container(s)`);
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
