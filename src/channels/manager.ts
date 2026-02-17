import type { Channel, MessageHandler, CommandHandler } from "./base.js";

/**
 * Manages multiple chat channels and routes messages/commands through them.
 * Each channel independently receives messages and forwards them to the shared handlers.
 */
export class ChannelManager {
  private channels: Channel[] = [];
  private messageHandler?: MessageHandler;
  private commandHandler?: CommandHandler;

  add(channel: Channel): void {
    this.channels.push(channel);
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
    for (const ch of this.channels) {
      ch.onMessage(handler);
    }
  }

  onCommand(handler: CommandHandler): void {
    this.commandHandler = handler;
    for (const ch of this.channels) {
      ch.onCommand?.(handler);
    }
  }

  async startAll(): Promise<void> {
    const results = await Promise.allSettled(
      this.channels.map(async (ch) => {
        console.log(`[channels] Starting ${ch.name}...`);
        await ch.start();
        console.log(`[channels] ${ch.name} started`);
      }),
    );
    for (const r of results) {
      if (r.status === "rejected") {
        console.error(`[channels] Channel failed to start:`, r.reason);
      }
    }
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(
      this.channels.map(async (ch) => {
        try {
          await ch.stop();
          console.log(`[channels] ${ch.name} stopped`);
        } catch (err) {
          console.error(`[channels] Error stopping ${ch.name}:`, err);
        }
      }),
    );
  }

  /** Get a channel by name (for scheduler delivery, etc.). */
  get(name: string): Channel | undefined {
    return this.channels.find((ch) => ch.name === name);
  }

  get enabledNames(): string[] {
    return this.channels.map((ch) => ch.name);
  }
}
