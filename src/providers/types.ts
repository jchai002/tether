/**
 * Platform-agnostic data types shared across all context providers and coding agents.
 */

export interface Message {
  id: string;
  text: string;
  author: string;
  source: string;
  channel: string;
  timestamp: string;
  threadId?: string;
  permalink?: string;
}

export interface Thread {
  parentMessage: Message;
  replies: Message[];
}

export interface SearchOptions {
  query: string;
  maxResults?: number;
}

/** A resolved user from a communication platform. */
export interface ResolvedUser {
  id: string;
  name: string;        // username (e.g. "anna.pico")
  displayName: string; // human name (e.g. "Anna Pico")
}

/** A resolved channel from a communication platform. */
export interface ResolvedChannel {
  id: string;
  name: string;        // channel name without prefix (e.g. "all-dashi")
}
