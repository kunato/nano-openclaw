import path from "node:path";
import { loadConfig } from "./config.js";
import { AgentRunner } from "./agent.js";
import { DiscordChannel } from "./channels/discord.js";
import { Scheduler } from "./scheduler.js";

async function main() {
  console.log("nano-openclaw starting...");

  const config = loadConfig();

  // Initialize agent runner
  const agent = new AgentRunner(config);
  await agent.init();

  // Initialize Discord channel
  const discord = new DiscordChannel(config.discordToken);

  // Initialize scheduler for cron jobs / reminders
  const schedulerStorePath = path.join(config.agentDir, "cron-store.json");
  const scheduler = new Scheduler(schedulerStorePath, async (job) => {
    // Extract the channel ID from the session key (e.g. "discord:channel:123" → "123")
    const channelId = job.sessionKey.split(":").pop();
    if (!channelId) {
      console.error(`[scheduler] Cannot resolve channel from session key: ${job.sessionKey}`);
      return;
    }

    if (job.payload.kind === "systemEvent") {
      // Simple text message — send directly to Discord
      console.log(`[scheduler] Delivering systemEvent to ${channelId}: ${job.payload.text.slice(0, 80)}`);
      await discord.sendToChannel(channelId, job.payload.text);
    } else if (job.payload.kind === "agentTurn") {
      // Full agent turn — run the agent with tools, then deliver the result
      console.log(`[scheduler] Running agentTurn for ${channelId}: ${job.payload.message.slice(0, 80)}`);
      const response = await agent.handleCronAgentTurn(
        job.sessionKey,
        job.payload.message,
      );
      if (response?.text) {
        const images = response.images?.map((img) => ({
          data: img.data,
          name: img.name,
        }));
        await discord.sendToChannel(channelId, response.text, images);
        console.log(`[scheduler] Delivered agentTurn result to ${channelId}`);
      }
    }
  });

  // Connect scheduler to agent (so the cron tool is available)
  agent.setScheduler(scheduler);
  await scheduler.start();

  discord.onCommand(async (command, _args, sessionKey, _channelId) => {
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

  discord.onMessage(async (msg, stream) => {
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

  await discord.start();
  console.log("nano-openclaw ready.");

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    scheduler.stop();
    await discord.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
