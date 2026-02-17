import {
  Client,
  GatewayIntentBits,
  Events,
  AttachmentBuilder,
  type Message,
  Partials,
} from "discord.js";
import type {
  Channel,
  CommandHandler,
  ImageAttachment,
  InboundMessage,
  MessageHandler,
  StreamCallbacks,
} from "./base.js";

const TOOL_EMOJI: Record<string, string> = {
  read: "\u{1F4C4}",
  write: "\u{270F}\u{FE0F}",
  edit: "\u{1F4DD}",
  multi_edit: "\u{1F4DD}",
  bash: "\u{1F4BB}",
  exec: "\u{1F4BB}",
  memory: "\u{1F9E0}",
  web_search: "\u{1F50D}",
  web_fetch: "\u{1F310}",
  cron: "\u{23F0}",
  browser: "\u{1F5A5}\u{FE0F}",
  file_ops: "\u{1F4C1}",
};

function toolEmoji(name: string): string {
  return TOOL_EMOJI[name] ?? "\u{1F527}";
}

export class DiscordChannel implements Channel {
  readonly name = "discord";
  private client: Client;
  private token: string;
  private handler?: MessageHandler;
  private commandHandler?: CommandHandler;

  constructor(token: string) {
    this.token = token;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
      rest: {
        timeout: 60_000, // 60s timeout for large image uploads
      },
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  onCommand(handler: CommandHandler): void {
    this.commandHandler = handler;
  }

  async start(): Promise<void> {
    this.client.on(Events.MessageCreate, async (message: Message) => {
      if (message.author.bot) return;
      if (!this.handler) return;

      const isGroup = message.guild !== null;
      const sessionKey = isGroup
        ? `discord:channel:${message.channelId}`
        : `discord:dm:${message.author.id}`;

      // In group chats, only respond when mentioned
      if (isGroup && !message.mentions.has(this.client.user!)) return;

      // Strip bot mention from message text
      let text = message.content;
      if (this.client.user) {
        text = text
          .replace(new RegExp(`<@!?${this.client.user.id}>`, "g"), "")
          .trim();
      }

      // Download image attachments (jpg, png, gif, webp)
      const imageAttachments = await downloadImageAttachments(message);

      // Allow image-only messages (no text required if images are present)
      if (!text && imageAttachments.length === 0) return;
      if (!text && imageAttachments.length > 0) {
        text = "(see attached image)";
      }

      // Handle /commands before dispatching to agent
      if (text.startsWith("/") && this.commandHandler) {
        const spaceIdx = text.indexOf(" ");
        const command = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
        const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();
        try {
          const reply = await this.commandHandler(command, args, sessionKey, message.channelId);
          if (reply !== null) {
            await message.reply(reply).catch(() => {});
            return;
          }
          // null means "not handled" — fall through to agent
        } catch (err) {
          console.error("[discord] Command error:", err);
          await message.reply("Error processing command.").catch(() => {});
          return;
        }
      }

      const inbound: InboundMessage = {
        text,
        sessionKey,
        channelId: message.channelId,
        userId: message.author.id,
        userName: message.author.displayName ?? message.author.username,
        isGroup,
        images: imageAttachments.length > 0 ? imageAttachments : undefined,
      };

      try {
        // Typing indicator
        const channel = message.channel;
        const canType =
          "sendTyping" in channel &&
          typeof channel.sendTyping === "function";
        if (canType) {
          await (
            channel as { sendTyping: () => Promise<void> }
          ).sendTyping();
        }
        const typingInterval = canType
          ? setInterval(() => {
              (
                channel as { sendTyping: () => Promise<void> }
              )
                .sendTyping()
                .catch(() => {});
            }, 8_000)
          : undefined;

        // Step-by-step execution log
        let statusMsg: Message | null = null;
        let stepNum = 0;
        const steps: string[] = [];
        // Track which step index is currently "running" for each tool
        const runningStepIdx = new Map<string, number>();
        const startedAt = Date.now();

        const renderStatusContent = () => {
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
          const header = `\u{2699}\u{FE0F} **Working...** (${elapsed}s)`;
          const body = steps.join("\n");
          return `${header}\n${body}`.slice(0, 2000);
        };

        const updateStatus = async () => {
          const content = renderStatusContent();
          try {
            if (!statusMsg) {
              statusMsg = await message.reply(content);
            } else {
              await statusMsg.edit(content);
            }
          } catch {
            // ignore edit failures
          }
        };

        const streamCallbacks: StreamCallbacks = {
          onThinking: async () => {
            if (steps.length === 0) {
              steps.push(`\u{1F4AD} Thinking...`);
              await updateStatus();
            }
          },
          onToolStart: async (toolName: string, meta?: string) => {
            stepNum++;
            // Replace "Thinking..." with first step
            if (steps.length === 1 && steps[0].includes("Thinking")) {
              steps[0] = formatStepRunning(stepNum, toolName, meta);
            } else {
              steps.push(formatStepRunning(stepNum, toolName, meta));
            }
            runningStepIdx.set(toolName, steps.length - 1);
            await updateStatus();
          },
          onToolEnd: async (
            toolName: string,
            info: { durationMs: number; error?: string; preview?: string },
          ) => {
            const idx = runningStepIdx.get(toolName);
            if (idx !== undefined && idx < steps.length) {
              const duration = formatDuration(info.durationMs);
              if (info.error) {
                steps[idx] = formatStepError(
                  idx + 1,
                  toolName,
                  info.error,
                  duration,
                );
              } else {
                steps[idx] = formatStepDone(
                  idx + 1,
                  toolName,
                  info.preview,
                  duration,
                );
              }
              runningStepIdx.delete(toolName);
            }
            await updateStatus();
          },
        };

        const response = await this.handler(inbound, streamCallbacks);
        if (typingInterval) clearInterval(typingInterval);

        // Finalize the execution log — keep it as context
        const finalStatusMsg = statusMsg as Message | null;
        if (finalStatusMsg && steps.length > 0) {
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
          const header = `\u{2705} **Done** (${elapsed}s, ${stepNum} step${stepNum !== 1 ? "s" : ""})`;
          const finalContent = `${header}\n${steps.join("\n")}`.slice(0, 2000);
          await finalStatusMsg.edit(finalContent).catch(() => {});
        } else if (finalStatusMsg) {
          await finalStatusMsg.delete().catch(() => {});
        }

        if (response?.text) {
          const files = (response.images ?? []).map(
            (img, i) =>
              new AttachmentBuilder(img.data, {
                name: img.name || `image-${i}.png`,
              }),
          );

          const chunks = splitMessage(response.text, 2000);
          for (let i = 0; i < chunks.length; i++) {
            const isLast = i === chunks.length - 1;
            await message.reply({
              content: chunks[i],
              files: isLast ? files : [],
            });
          }
        }
      } catch (err) {
        console.error("[discord] Error handling message:", err);
        try {
          await message.reply(
            "Sorry, something went wrong processing your message.",
          );
        } catch {
          // ignore reply failure
        }
      }
    });

    this.client.on(Events.ClientReady, (c) => {
      console.log(`[discord] Logged in as ${c.user.tag}`);
    });

    await this.client.login(this.token);
  }

  /**
   * Send a message to a specific channel (used by the scheduler for cron delivery).
   */
  async sendToChannel(
    channelId: string,
    text: string,
    images?: Array<{ data: Buffer; name: string }>,
  ): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !("send" in channel) || typeof channel.send !== "function") {
      console.error(`[discord] Cannot send to channel ${channelId}: not a text channel`);
      return;
    }
    const files = (images ?? []).map(
      (img, i) =>
        new AttachmentBuilder(img.data, {
          name: img.name || `image-${i}.png`,
        }),
    );
    const chunks = splitMessage(text, 2000);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      await (channel as { send: (opts: unknown) => Promise<unknown> }).send({
        content: chunks[i],
        files: isLast ? files : [],
      });
    }
  }

  async stop(): Promise<void> {
    this.client.destroy();
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatStepRunning(
  step: number,
  toolName: string,
  meta?: string,
): string {
  const emoji = toolEmoji(toolName);
  const detail = meta ? ` \`${meta}\`` : "";
  return `${step}. ${emoji} **${toolName}**${detail} \u{23F3}`;
}

function formatStepDone(
  step: number,
  toolName: string,
  preview?: string,
  duration?: string,
): string {
  const emoji = toolEmoji(toolName);
  const dur = duration ? ` (${duration})` : "";
  const prev = preview ? ` — ${preview}` : "";
  return `${step}. ${emoji} **${toolName}**${prev}${dur} \u{2705}`;
}

function formatStepError(
  step: number,
  toolName: string,
  error: string,
  duration?: string,
): string {
  const dur = duration ? ` (${duration})` : "";
  return `${step}. \u{274C} **${toolName}** failed: ${error.slice(0, 120)}${dur}`;
}

const IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const MAX_IMAGE_DOWNLOAD_BYTES = 20 * 1024 * 1024; // 20MB download limit

async function downloadImageAttachments(
  message: Message,
): Promise<ImageAttachment[]> {
  const images: ImageAttachment[] = [];

  for (const [, attachment] of message.attachments) {
    const ct = attachment.contentType?.split(";")[0]?.trim().toLowerCase();
    if (!ct || !IMAGE_CONTENT_TYPES.has(ct)) continue;
    if (attachment.size > MAX_IMAGE_DOWNLOAD_BYTES) continue;

    try {
      const res = await fetch(attachment.url, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      images.push({
        data: buf,
        name: attachment.name ?? `attachment-${images.length}.png`,
        mimeType: ct,
      });
    } catch {
      // Skip failed downloads silently
    }
  }

  return images;
}

function splitMessage(text: string, maxLength: number): string[] {
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
