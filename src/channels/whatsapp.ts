import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
  type proto,
} from "@whiskeysockets/baileys";
import type {
  Channel,
  CommandHandler,
  ImageAttachment,
  InboundMessage,
  MessageHandler,
  StreamCallbacks,
} from "./base.js";
import type { WhatsAppConfig } from "../config.js";
import fs from "node:fs/promises";

export class WhatsAppChannel implements Channel {
  readonly name = "whatsapp";
  private config: WhatsAppConfig;
  private sock?: WASocket;
  private handler?: MessageHandler;
  private commandHandler?: CommandHandler;

  constructor(config: WhatsAppConfig) {
    this.config = config;
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  onCommand(handler: CommandHandler): void {
    this.commandHandler = handler;
  }

  async start(): Promise<void> {
    await fs.mkdir(this.config.authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(this.config.authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, undefined as never),
      },
      printQRInTerminal: true,
      generateHighQualityLinkPreview: false,
    });

    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })
          ?.output?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
          console.log("[whatsapp] Logged out — delete auth dir and restart to re-link");
        } else {
          console.log(`[whatsapp] Disconnected (code=${statusCode}), reconnecting...`);
          // Reconnect after a short delay
          setTimeout(() => this.start().catch(console.error), 3000);
        }
      } else if (connection === "open") {
        console.log("[whatsapp] Connected");
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      if (!this.handler) return;

      for (const msg of messages) {
        try {
          await this.handleIncoming(msg);
        } catch (err) {
          console.error("[whatsapp] Error handling message:", err);
        }
      }
    });
  }

  private async handleIncoming(msg: proto.IWebMessageInfo): Promise<void> {
    if (!this.handler || !this.sock) return;
    if (!msg.message || msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    if (!jid) return;

    // Access control
    if (this.config.allowFrom && this.config.allowFrom.length > 0) {
      const senderId = jid.replace(/@s\.whatsapp\.net$/, "");
      if (!this.config.allowFrom.includes(senderId) && !this.config.allowFrom.includes(jid)) {
        console.log(`[whatsapp] Blocked message from ${senderId} (not in allowFrom)`);
        return;
      }
    }

    const isGroup = jid.endsWith("@g.us");
    const sessionKey = `whatsapp:${jid}`;
    const senderId = msg.key.participant || jid;

    // Extract text from various message types
    let text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      "";

    // Download image attachments
    const images: ImageAttachment[] = [];
    const imageMsg = msg.message.imageMessage;
    if (imageMsg) {
      try {
        const stream = await (await import("@whiskeysockets/baileys")).downloadMediaMessage(
          msg,
          "buffer",
          {},
        );
        if (Buffer.isBuffer(stream)) {
          images.push({
            data: stream,
            name: "image.jpg",
            mimeType: imageMsg.mimetype || "image/jpeg",
          });
        }
      } catch (err) {
        console.warn("[whatsapp] Failed to download image:", err);
      }
    }

    if (!text && images.length === 0) return;
    if (!text && images.length > 0) text = "(see attached image)";

    // Handle /commands
    if (text.startsWith("/") && this.commandHandler) {
      const spaceIdx = text.indexOf(" ");
      const command = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
      const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();
      try {
        const reply = await this.commandHandler(command, args, sessionKey, jid);
        if (reply !== null) {
          await this.sock.sendMessage(jid, { text: reply });
          return;
        }
      } catch (err) {
        console.error("[whatsapp] Command error:", err);
        await this.sock.sendMessage(jid, { text: "Error processing command." });
        return;
      }
    }

    const inbound: InboundMessage = {
      text,
      sessionKey,
      channelId: jid,
      userId: senderId.replace(/@.*$/, ""),
      userName: msg.pushName || senderId.replace(/@.*$/, ""),
      isGroup,
      images: images.length > 0 ? images : undefined,
    };

    const noopStream: StreamCallbacks = {};
    try {
      const response = await this.handler(inbound, noopStream);
      if (response?.text) {
        await this.sock.sendMessage(jid, { text: response.text });
      }
    } catch (err) {
      console.error("[whatsapp] Error processing message:", err);
      try {
        await this.sock.sendMessage(jid, { text: "Sorry, something went wrong." });
      } catch { /* ignore */ }
    }
  }

  /** Send a message to a specific JID (used by scheduler for cron delivery). */
  async sendToChannel(channelId: string, text: string): Promise<void> {
    if (!this.sock) {
      console.error("[whatsapp] Cannot send: not connected");
      return;
    }
    await this.sock.sendMessage(channelId, { text });
  }

  async stop(): Promise<void> {
    this.sock?.end(undefined);
    this.sock = undefined;
  }
}
