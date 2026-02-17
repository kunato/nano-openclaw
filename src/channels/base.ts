export interface InboundMessage {
  text: string;
  sessionKey: string;
  channelId: string;
  userId: string;
  userName: string;
  isGroup: boolean;
  /** Images attached to the inbound message (downloaded, ready for vision models). */
  images?: ImageAttachment[];
}

export interface ImageAttachment {
  data: Buffer;
  name: string;
  mimeType: string;
}

export interface OutboundMessage {
  text: string;
  images?: ImageAttachment[];
}

export interface StreamCallbacks {
  onThinking?: () => void | Promise<void>;
  onToolStart?: (toolName: string, meta?: string) => void | Promise<void>;
  onToolEnd?: (
    toolName: string,
    info: { durationMs: number; error?: string; preview?: string },
  ) => void | Promise<void>;
}

export type MessageHandler = (
  msg: InboundMessage,
  stream: StreamCallbacks,
) => Promise<OutboundMessage | null>;

export type CommandHandler = (
  command: string,
  args: string,
  sessionKey: string,
  channelId: string,
) => Promise<string | null>;

export interface Channel {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: MessageHandler): void;
  onCommand?(handler: CommandHandler): void;
}
