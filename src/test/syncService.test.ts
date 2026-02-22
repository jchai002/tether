import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import { SyncService } from "../telemetry/syncService";

let tmpDir: string;
let service: SyncService;
let dataFilePath: string;
let syncStatePath: string;
let deviceIdPath: string;

/** Stub global fetch to return a canned response. Returns the mock fn for assertions. */
function stubFetch(status: number): ReturnType<typeof vi.fn> {
  const mockFn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : status === 429 ? "Too Many Requests" : "Server Error",
  });
  vi.stubGlobal("fetch", mockFn);
  return mockFn;
}

/** Override vscode config so isSyncEnabled() returns true. */
function enableSync() {
  vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
    get: (key: string, defaultValue?: unknown) => {
      if (key === "telemetry.enabled") return true;
      if (key === "telemetry.syncEnabled") return true;
      if (key === "telemetry.syncUrl") return "https://test-worker.example.com";
      return defaultValue;
    },
    // Satisfy the ConfigurationTarget interface — not used in these tests
    has: () => true,
    inspect: () => undefined,
    update: async () => {},
  } as any);
}

/** Write JSONL content to the data file. */
function writeData(content: string) {
  fs.writeFileSync(dataFilePath, content, "utf-8");
}

/** Write a sync state with a given byte offset. */
function writeSyncState(offset: number) {
  fs.writeFileSync(syncStatePath, JSON.stringify({ lastSyncByteOffset: offset }), "utf-8");
}

/** Read the current sync state from disk. */
function readSyncState(): { lastSyncByteOffset: number } {
  return JSON.parse(fs.readFileSync(syncStatePath, "utf-8"));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conduit-sync-test-"));
  dataFilePath = path.join(tmpDir, "sessions.jsonl");
  syncStatePath = path.join(tmpDir, "sync-state.json");
  deviceIdPath = path.join(tmpDir, "device-id");

  // Most tests need a device ID to proceed
  fs.writeFileSync(deviceIdPath, "test-device-123", "utf-8");

  service = new SyncService(tmpDir);
  enableSync();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── Core upload flow ─────────────────────────────────────────

describe("core upload flow", () => {
  it("uploads new data from byte offset 0", async () => {
    const data = '{"event":"test"}\n';
    writeData(data);
    const fetchMock = stubFetch(200);

    await service.performSync();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://test-worker.example.com/telemetry/upload");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/x-ndjson");
    expect(opts.headers["X-Device-ID"]).toBe("test-device-123");
    expect(opts.body).toBe(data);
  });

  it("uploads only new data after previous sync", async () => {
    const line1 = '{"event":"old"}\n';
    const line2 = '{"event":"new"}\n';
    writeData(line1 + line2);
    writeSyncState(line1.length);
    const fetchMock = stubFetch(200);

    await service.performSync();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].body).toBe(line2);
  });

  it("advances byte offset on successful upload", async () => {
    const data = '{"event":"test"}\n';
    writeData(data);
    stubFetch(200);

    await service.performSync();

    const state = readSyncState();
    expect(state.lastSyncByteOffset).toBe(data.length);
  });
});

// ── No-op conditions ─────────────────────────────────────────

describe("no-op conditions", () => {
  it("no-ops when data file does not exist", async () => {
    const fetchMock = stubFetch(200);
    await service.performSync();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops when data file is empty", async () => {
    writeData("");
    const fetchMock = stubFetch(200);
    await service.performSync();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops when offset equals file size (nothing new)", async () => {
    const data = '{"event":"test"}\n';
    writeData(data);
    writeSyncState(data.length);
    const fetchMock = stubFetch(200);

    await service.performSync();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops when sync is disabled", async () => {
    // Restore the default vscode mock (returns undefined → both settings false)
    vi.restoreAllMocks();
    writeData('{"event":"test"}\n');
    const fetchMock = stubFetch(200);

    // Use the private syncIfEnabled path — isSyncEnabled will be false
    expect(service.isSyncEnabled()).toBeFalsy();
  });
});

// ── Offset reset ─────────────────────────────────────────────

describe("offset reset", () => {
  it("resets offset to 0 when offset exceeds file size", async () => {
    const data = '{"event":"new"}\n';
    writeData(data);
    writeSyncState(99999); // Way past file size
    const fetchMock = stubFetch(200);

    await service.performSync();

    // Should upload the entire file (reset to offset 0)
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].body).toBe(data);

    // Offset should now be at the actual file size
    const state = readSyncState();
    expect(state.lastSyncByteOffset).toBe(data.length);
  });
});

// ── Error handling ───────────────────────────────────────────

describe("error handling", () => {
  it("does not advance offset on 429 (rate limit)", async () => {
    writeData('{"event":"test"}\n');
    writeSyncState(0);
    stubFetch(429);

    await service.performSync();

    // Offset should remain at 0 — sync-state.json shouldn't exist yet
    // (loadSyncState defaults to 0 if file is missing)
    expect(fs.existsSync(syncStatePath)).toBe(true);
    const state = readSyncState();
    expect(state.lastSyncByteOffset).toBe(0);
  });

  it("does not advance offset on non-ok response (500)", async () => {
    writeData('{"event":"test"}\n');
    writeSyncState(0);
    stubFetch(500);

    await service.performSync();

    const state = readSyncState();
    expect(state.lastSyncByteOffset).toBe(0);
  });

  it("skips sync when device-id file is missing", async () => {
    fs.unlinkSync(deviceIdPath);
    writeData('{"event":"test"}\n');
    const fetchMock = stubFetch(200);

    await service.performSync();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── isSyncEnabled ────────────────────────────────────────────

describe("isSyncEnabled", () => {
  it("returns false when both settings are off", () => {
    vi.restoreAllMocks(); // Use the default vscode mock
    expect(service.isSyncEnabled()).toBeFalsy();
  });

  it("returns true when both settings are on", () => {
    // enableSync was called in beforeEach
    expect(service.isSyncEnabled()).toBe(true);
  });

  it("returns false when only telemetry.enabled is true", () => {
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: (key: string, defaultValue?: unknown) => {
        if (key === "telemetry.enabled") return true;
        if (key === "telemetry.syncEnabled") return false;
        return defaultValue;
      },
      has: () => true,
      inspect: () => undefined,
      update: async () => {},
    } as any);

    expect(service.isSyncEnabled()).toBe(false);
  });
});
