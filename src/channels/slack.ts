import { App } from "@slack/bolt";
import type {
  Channel,
  CommandHandler,
  InboundMessage,
  MessageHandler,
  StreamCallbacks,
} from "./base.js";
import type { SlackConfig } from "../config.js";

export class SlackChannel implements Channel {
  readonly name = "slack";
  private config: SlackConfig;
  private app: App;
  private handler?: MessageHandler;
  private commandHandler?: CommandHandler;

  constructor(config: SlackConfig) {
    this.config = config;
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  onCommand(handler: CommandHandler): void {
    this.commandHandler = handler;
  }

  async start(): Promise<void> {
    // Handle regular messages
    this.app.message(async ({ message, say, client }) => {
      const msg = message as { subtype?: string; bot_id?: string; user: string; channel: string; channel_type?: string; text?: string };
      if (msg.subtype) return; // skip edits, deletes, etc.
      if (msg.bot_id) return; // skip bot messages
      if (!this.handler) return;

      const userId = msg.user;
      const channelId = msg.channel;
      const text = msg.text || "";

      // Access control
      if (this.config.allowFrom && this.config.allowFrom.length > 0) {
        if (!this.config.allowFrom.includes(userId)) {
          console.log(`[slack] Blocked message from ${userId} (not in allowFrom)`);
          return;
        }
      }

      const isGroup = msg.channel_type === "channel" || msg.channel_type === "group";
      const sessionKey = `slack:${channelId}`;

      // Resolve display name
      let userName = userId;
      try {
        const info = await client.users.info({ user: userId });
        userName = info.user?.real_name || info.user?.name || userId;
      } catch { /* fallback to userId */ }

      // Handle /commands (text starting with /)
      if (text.startsWith("/") && this.commandHandler) {
        const spaceIdx = text.indexOf(" ");
        const command = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
        const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();
        try {
          const reply = await this.commandHandler(command, args, sessionKey, channelId);
          if (reply !== null) {
            await say(reply);
            return;
          }
        } catch (err) {
          console.error("[slack] Command error:", err);
          await say("Error processing command.");
          return;
        }
      }

      if (!text) return;

      const inbound: InboundMessage = {
        text,
        sessionKey,
        channelId,
        userId,
        userName,
        isGroup,
      };

      const noopStream: StreamCallbacks = {};
      try {
        const response = await this.handler(inbound, noopStream);
        if (response?.text) {
          // Split long messages (Slack limit is 40,000 chars but best to chunk at ~3000)
          const chunks = splitText(response.text, 3000);
          for (const chunk of chunks) {
            await say(chunk);
          }
        }
      } catch (err) {
        console.error("[slack] Error processing message:", err);
        try {
          await say("Sorry, something went wrong.");
        } catch { /* ignore */ }
      }
    });

    await this.app.start();
    console.log("[slack] Connected via Socket Mode");
  }

  /** Send a message to a specific channel (used by scheduler for cron delivery). */
  async sendToChannel(channelId: string, text: string): Promise<void> {
    try {
      const chunks = splitText(text, 3000);
      for (const chunk of chunks) {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: chunk,
        });
      }
    } catch (err) {
      console.error(`[slack] Failed to send to ${channelId}:`, err);
    }
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }
}

function splitText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf("\n", maxLength);
    if (splitIdx === -1 || splitIdx < maxLength / 2) {
      splitIdx = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIdx === -1 || splitIdx < maxLength / 2) {
      splitIdx = maxLength;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  return chunks;
}
