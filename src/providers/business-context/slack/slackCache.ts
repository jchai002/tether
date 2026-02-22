import { WebClient } from "@slack/web-api";

export interface SlackUser {
  id: string;
  name: string;        // username (e.g. "sarah.chen")
  realName: string;    // display name (e.g. "Sarah Chen")
}

export interface SlackChannel {
  id: string;
  name: string;        // channel name without # (e.g. "backend")
}

/** Users rarely rename — cache for 24 hours. Channels change more often (4 hours). */
const USER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CHANNEL_CACHE_TTL_MS = 4 * 60 * 60 * 1000;

export class SlackCache {
  private users: SlackUser[] = [];
  private channels: SlackChannel[] = [];
  private usersLoadedAt = 0;
  private channelsLoadedAt = 0;

  constructor(private getClient: () => Promise<WebClient>) {}

  async getUsers(): Promise<SlackUser[]> {
    if (Date.now() - this.usersLoadedAt < USER_CACHE_TTL_MS && this.users.length > 0) {
      return this.users;
    }
    await this.loadUsers();
    return this.users;
  }

  async getChannels(): Promise<SlackChannel[]> {
    if (Date.now() - this.channelsLoadedAt < CHANNEL_CACHE_TTL_MS && this.channels.length > 0) {
      return this.channels;
    }
    await this.loadChannels();
    return this.channels;
  }

  /** Resolves a Slack user ID (e.g. "U0AG427DM4Z") to a display name.
   *  Returns realName if available, falls back to username, then the raw ID. */
  async resolveUserName(userId: string): Promise<string> {
    const users = await this.getUsers();
    const user = users.find((u) => u.id === userId);
    return user?.realName || user?.name || userId;
  }

  async fuzzyMatchUser(input: string): Promise<SlackUser[]> {
    const users = await this.getUsers();
    const lower = input.toLowerCase();

    // Exact match on username
    const exact = users.filter((u) => u.name.toLowerCase() === lower);
    if (exact.length > 0) return exact;

    // Substring match on name or realName
    const substring = users.filter(
      (u) =>
        u.name.toLowerCase().includes(lower) ||
        u.realName.toLowerCase().includes(lower)
    );
    if (substring.length > 0) return substring;

    // Levenshtein on username and first name
    return users
      .map((u) => {
        const nameDist = levenshtein(lower, u.name.toLowerCase());
        const firstName = u.realName.split(" ")[0]?.toLowerCase() ?? "";
        const firstNameDist = firstName ? levenshtein(lower, firstName) : Infinity;
        return { user: u, distance: Math.min(nameDist, firstNameDist) };
      })
      .filter((r) => r.distance <= 2)
      .sort((a, b) => a.distance - b.distance)
      .map((r) => r.user);
  }

  async fuzzyMatchChannel(input: string): Promise<SlackChannel[]> {
    const channels = await this.getChannels();
    const lower = input.toLowerCase();

    const exact = channels.filter((c) => c.name.toLowerCase() === lower);
    if (exact.length > 0) return exact;

    const substring = channels.filter((c) => c.name.toLowerCase().includes(lower));
    if (substring.length > 0) return substring;

    return channels
      .map((c) => ({
        channel: c,
        distance: levenshtein(lower, c.name.toLowerCase()),
      }))
      .filter((r) => r.distance <= 2)
      .sort((a, b) => a.distance - b.distance)
      .map((r) => r.channel);
  }

  invalidate(): void {
    this.usersLoadedAt = 0;
    this.channelsLoadedAt = 0;
  }

  private async loadUsers(): Promise<void> {
    const client = await this.getClient();
    const result = await client.users.list({});
    this.users = (result.members ?? [])
      .filter((m: any) => !m.deleted && !m.is_bot && m.id !== "USLACKBOT")
      .map((m: any) => ({
        id: m.id,
        name: m.name ?? "",
        realName: m.real_name ?? m.profile?.real_name ?? "",
      }));
    this.usersLoadedAt = Date.now();
  }

  private async loadChannels(): Promise<void> {
    const client = await this.getClient();
    const result = await client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 1000,
    });
    this.channels = (result.channels ?? []).map((c: any) => ({
      id: c.id,
      name: c.name ?? "",
    }));
    this.channelsLoadedAt = Date.now();
  }
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[b.length][a.length];
}
