import { Message, Thread, SearchOptions, ResolvedUser, ResolvedChannel } from "./types";

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

  /** Fuzzy-match a name to platform users. Used to resolve "anna" → "anna.pico"
   *  before searching with from: operators. Optional — not all providers support it. */
  resolveUser?(input: string): Promise<ResolvedUser[]>;

  /** Fuzzy-match a name to platform channels. Used to resolve "dashi" → "all-dashi"
   *  before searching with in: operators. Optional — not all providers support it. */
  resolveChannel?(input: string): Promise<ResolvedChannel[]>;
}
