import path from "node:path";
import { loadConfig } from "./config.js";
import { AgentRunner } from "./agent.js";
import { DiscordChannel } from "./channels/discord.js";
import { ChannelManager } from "./channels/manager.js";
import { Scheduler } from "./scheduler.js";
import { HeartbeatService } from "./heartbeat.js";
import { removeAllSandboxContainers } from "./sandbox/index.js";
import { buildAnnounceMessage, buildSpawnProgressMessage } from "./subagent.js";

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
  }, config.scheduler);

  // Connect scheduler to agent (so the cron tool is available)
  agent.setScheduler(scheduler);

  // Wire subagent spawn progress callback: notify channel when subagents are spawned
  agent.setSpawnProgressCallback(async (params) => {
    const progressText = buildSpawnProgressMessage({
      label: params.label,
      task: params.task,
      totalSpawned: params.totalSpawned,
    });

    const channelName = params.parentSessionKey.split(":")[0] || "discord";
    console.log(
      `[subagent.progress] label="${params.label || 'none'}" channelName=${channelName} parentChannelId=${params.parentChannelId} totalSpawned=${params.totalSpawned}`,
    );

    // Send progress update to the channel — use parentChannelId (actual channel ID),
    // NOT the session key suffix (which is a user ID for DMs, not the channel ID).
    if (params.parentChannelId) {
      const targetChannel = channels.get(channelName);
      console.log(`[subagent.progress] targetChannel found: ${!!targetChannel}, hasSendToChannel: ${!!(targetChannel && "sendToChannel" in targetChannel)}`);
      if (targetChannel && "sendToChannel" in targetChannel) {
        try {
          await (targetChannel as { sendToChannel: (id: string, text: string) => Promise<void> }).sendToChannel(params.parentChannelId, progressText);
          console.log(`[subagent.progress] Sent to ${channelName}:${params.parentChannelId}`);
        } catch (err) {
          console.error(`[subagent.progress] sendToChannel FAILED:`, err instanceof Error ? err.message : String(err));
        }
      }
    } else {
      console.log(`[subagent.progress] WARNING: parentChannelId is empty/missing`);
    }
  });

  // Wire subagent tool progress callback: send each tool call from subagents to the channel
  agent.setSubagentToolProgressCallback(async (params) => {
    const channelName = "discord"; // subagents always inherit parent channel
    const emoji: Record<string, string> = {
      web_search: "🔍", web_fetch: "🌐", browser: "🖥️", read: "📄",
      write: "✏️", edit: "📝", exec: "💻", bash: "💻", memory: "🧠",
    };
    const icon = emoji[params.toolName] ?? "🔧";
    const labelTag = params.label ? `[${params.label.split(":").slice(1).join(":")}]` : "";

    let text: string;
    if (params.event === "tool_start") {
      const meta = params.meta ? ` ${params.meta}` : "";
      text = `${icon} ${labelTag} **${params.toolName}**${meta} ⏳`;
    } else {
      const dur = params.durationMs ? ` (${(params.durationMs / 1000).toFixed(1)}s)` : "";
      if (params.error) {
        text = `❌ ${labelTag} **${params.toolName}** failed: ${params.error.slice(0, 120)}${dur}`;
      } else {
        const prev = params.preview ? ` — ${params.preview}` : "";
        text = `${icon} ${labelTag} **${params.toolName}**${prev}${dur} ✅`;
      }
    }

    if (params.parentChannelId) {
      const targetChannel = channels.get(channelName);
      if (targetChannel && "sendToChannel" in targetChannel) {
        await (targetChannel as { sendToChannel: (id: string, text: string) => Promise<void> }).sendToChannel(params.parentChannelId, text).catch(() => {});
      }
    }
  });

  // Wire subagent announce callback: when a child subagent completes,
  // inject its result back into the parent session and deliver to the channel.
  agent.setAnnounceCallback(async (params) => {
    const registry = agent.getSubagentRegistry();
    const remainingActive = registry.countActiveForSession(params.parentSessionKey);

    const announceText = buildAnnounceMessage({
      task: params.task,
      label: params.label,
      status: params.status,
      result: params.result,
      startedAt: params.startedAt,
      endedAt: params.endedAt,
      remainingActiveChildren: remainingActive,
    });

    const channelName = params.parentSessionKey.split(":")[0] || "discord";
    console.log(
      `[subagent.announce] label="${params.label || 'none'}" status=${params.status} channelName=${channelName} parentChannelId=${params.parentChannelId} remainingActive=${remainingActive}`,
    );

    // Inject the announce as a new message into the parent agent session
    console.log(`[subagent.announce] Injecting announce message into parent session: ${params.parentSessionKey}`);
    const response = await agent.handleMessage({
      text: announceText,
      sessionKey: params.parentSessionKey,
      channelId: params.parentChannelId,
      userId: "system",
      userName: "subagent-announce",
      isGroup: false,
    }, {});
    console.log(`[subagent.announce] Parent response: text=${response?.text ? response.text.slice(0, 80) + '...' : 'null'}, isNoReply=${response?.text === 'NO_REPLY'}`);

    // Deliver response to the appropriate channel — use parentChannelId (actual channel ID),
    // NOT the session key suffix (which is a user ID for DMs, not the channel ID).
    if (response?.text && response.text !== "NO_REPLY") {
      if (params.parentChannelId) {
        const targetChannel = channels.get(channelName);
        console.log(`[subagent.announce] Delivering to ${channelName}:${params.parentChannelId}, targetChannel=${!!targetChannel}`);
        if (targetChannel && "sendToChannel" in targetChannel) {
          const images = response.images?.map((img) => ({
            data: img.data,
            name: img.name,
          }));
          try {
            await (targetChannel as { sendToChannel: (id: string, text: string, images?: unknown) => Promise<void> }).sendToChannel(params.parentChannelId, response.text, images);
            console.log(`[subagent.announce] Delivered to ${channelName}:${params.parentChannelId}`);
          } catch (err) {
            console.error(`[subagent.announce] sendToChannel FAILED:`, err instanceof Error ? err.message : String(err));
          }
        }
      } else {
        console.log(`[subagent.announce] WARNING: parentChannelId is empty/missing, cannot deliver`);
      }
    } else {
      console.log(`[subagent.announce] No delivery needed (no text or NO_REPLY)`);
    }
  });

  await scheduler.start();

  const schedulerStatus = scheduler.status();
  if (schedulerStatus.total > 0) {
    console.log(
      `[scheduler] ${schedulerStatus.enabled} enabled / ${schedulerStatus.total} total jobs`,
    );
  }

  // Initialize heartbeat service (proactive agent wake-up)
  const heartbeat = new HeartbeatService({
    config: config.heartbeat,
    workspaceDir: config.workspaceDir,
    agentDir: config.agentDir,
    onHeartbeat: async (prompt) => {
      // Run heartbeat through the agent, delivering to the first available channel
      const firstChannel = channels.enabledNames[0];
      if (!firstChannel) {
        console.log("[heartbeat] No channels available for delivery");
        return null;
      }
      const response = await agent.handleCronAgentTurn(
        `heartbeat:${firstChannel}`,
        prompt,
      );
      return response?.text ?? null;
    },
  });
  await heartbeat.start();

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
    heartbeat.stop();
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
