/**
 * SyncService — periodically uploads local telemetry data to R2 via the
 * Cloudflare Worker.
 *
 * Reads new JSONL lines from ~/.conduit/telemetry/sessions.jsonl (using a
 * byte offset to avoid re-uploading old data) and POSTs them directly to
 * the Worker's /telemetry/upload endpoint. The Worker writes to R2.
 *
 * The upload flow:
 * 1. Read sessions.jsonl from the last synced byte offset to EOF
 * 2. POST the JSONL chunk to the Worker with the device ID in a header
 * 3. Worker validates, rate-limits, and writes to R2
 * 4. Update the byte offset in sync-state.json
 *
 * Runs on a timer (every 30 minutes) and can be triggered manually.
 * Silently skips if offline, disabled, or no new data exists.
 *
 * Data is partitioned in R2 as: {deviceId}/{date}/{timestamp}.jsonl
 * This makes per-device deletion trivial for GDPR compliance.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";

/** How often to sync (in milliseconds). 30 minutes. */
const SYNC_INTERVAL_MS = 30 * 60 * 1000;

/** Sync state persisted between runs — tracks how much data has been uploaded. */
interface SyncState {
  lastSyncByteOffset: number;
}

export class SyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private dataDir: string;
  private dataFilePath: string;
  private syncStatePath: string;
  private deviceIdPath: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? path.join(os.homedir(), ".conduit", "telemetry");
    this.dataFilePath = path.join(this.dataDir, "sessions.jsonl");
    this.syncStatePath = path.join(this.dataDir, "sync-state.json");
    this.deviceIdPath = path.join(this.dataDir, "device-id");
  }

  /** Start the periodic sync timer. Call once from extension activation. */
  start(): void {
    // Run an initial sync after a short delay (don't block activation)
    setTimeout(() => this.syncIfEnabled(), 30_000);

    this.timer = setInterval(() => this.syncIfEnabled(), SYNC_INTERVAL_MS);
  }

  /** Stop the periodic sync timer. Call from extension deactivation. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Attempt a final sync on deactivation. Best-effort — VS Code gives ~5s. */
  async syncOnDeactivate(): Promise<void> {
    this.stop();
    await this.syncIfEnabled();
  }

  /** Manual sync trigger (for the "Conduit: Sync Now" command). */
  async syncNow(): Promise<void> {
    if (!this.isSyncEnabled()) {
      vscode.window.showInformationMessage(
        "Telemetry sync is not enabled. Enable it in settings: businessContext.telemetry.syncEnabled"
      );
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Syncing telemetry data..." },
      () => this.performSync()
    );
  }

  // ── Internals ───────────────────────────────────────────────

  /** Check settings and sync if enabled. Silently no-ops otherwise. */
  private async syncIfEnabled(): Promise<void> {
    if (!this.isSyncEnabled()) return;
    try {
      await this.performSync();
    } catch (err) {
      console.error("[Conduit] Telemetry sync failed:", err);
    }
  }

  isSyncEnabled(): boolean {
    const config = vscode.workspace.getConfiguration("businessContext");
    return config.get<boolean>("telemetry.enabled", false) &&
           config.get<boolean>("telemetry.syncEnabled", false);
  }

  /** Core sync logic — reads new data and POSTs it to the Worker. */
  async performSync(): Promise<void> {
    // Read the data file — bail if it doesn't exist or is empty
    if (!fs.existsSync(this.dataFilePath)) return;
    const stat = fs.statSync(this.dataFilePath);
    if (stat.size === 0) return;

    // Load sync state — start from the last synced byte offset.
    // If the offset is past the file size, the file was reset (size cap
    // or manual deletion). Start from the beginning of the new file.
    const syncState = this.loadSyncState();
    if (syncState.lastSyncByteOffset > stat.size) {
      syncState.lastSyncByteOffset = 0;
    }
    if (syncState.lastSyncByteOffset >= stat.size) return; // nothing new

    // Read new data from the byte offset to EOF
    const fd = fs.openSync(this.dataFilePath, "r");
    const buffer = Buffer.alloc(stat.size - syncState.lastSyncByteOffset);
    fs.readSync(fd, buffer, 0, buffer.length, syncState.lastSyncByteOffset);
    fs.closeSync(fd);
    const newData = buffer.toString("utf-8");

    if (!newData.trim()) return; // no meaningful content

    // Load device ID
    let deviceId: string;
    try {
      deviceId = fs.readFileSync(this.deviceIdPath, "utf-8").trim();
    } catch {
      console.error("[Conduit] No device ID found — skipping sync");
      return;
    }

    // Upload URL — defaults to the production Worker
    const workerUrl = vscode.workspace.getConfiguration("businessContext")
      .get<string>("telemetry.syncUrl", "https://conduit-oauth.jchai002.workers.dev");

    // POST directly to the Worker. It handles rate limiting and writes to R2.
    const response = await fetch(`${workerUrl}/telemetry/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-ndjson",
        "X-Device-ID": deviceId,
      },
      body: newData,
    });

    if (response.status === 429) {
      console.log("[Conduit] Telemetry upload rate-limited — will retry next cycle");
      return;
    }

    if (!response.ok) {
      console.error(`[Conduit] Telemetry upload failed: ${response.status} ${response.statusText}`);
      return;
    }

    // Success — advance the byte offset
    this.saveSyncState({ lastSyncByteOffset: stat.size });
    console.log(`[Conduit] Telemetry synced: ${buffer.length} bytes uploaded`);
  }

  private loadSyncState(): SyncState {
    try {
      const raw = fs.readFileSync(this.syncStatePath, "utf-8");
      return JSON.parse(raw) as SyncState;
    } catch {
      return { lastSyncByteOffset: 0 };
    }
  }

  private saveSyncState(state: SyncState): void {
    fs.writeFileSync(this.syncStatePath, JSON.stringify(state), "utf-8");
  }
}
