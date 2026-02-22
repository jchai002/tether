import { Message, Thread, SearchOptions } from "./types";

/**
 * Interface for any business context source (Slack, Teams, Outlook, etc.).
 * Each implementation adapts a platform-specific API to this common contract.
 */
export interface BusinessContextProvider {
  readonly id: string;
  readonly displayName: string;

  isConfigured(): boolean | Promise<boolean>;
  configure(): Promise<void>;
  searchMessages(options: SearchOptions): Promise<Message[]>;
  getThread(channelId: string, threadId: string): Promise<Thread | null>;
}
