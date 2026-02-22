import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { DataCollector } from "../telemetry/dataCollector";

let tmpDir: string;
let collector: DataCollector;

/** Read all JSONL records from the test data file. */
function readRecords(): Record<string, unknown>[] {
  const filePath = path.join(tmpDir, "sessions.jsonl");
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conduit-test-"));
  collector = new DataCollector(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Session lifecycle ────────────────────────────────────────

describe("session lifecycle", () => {
  it("startSession returns a session ID", () => {
    const sid = collector.startSession({ model: "claude", permissionMode: "auto" });
    expect(sid).toBeTruthy();
    expect(typeof sid).toBe("string");
  });

  it("startSession uses provided conversationId", () => {
    const sid = collector.startSession({
      model: "claude",
      permissionMode: "auto",
      conversationId: "my-convo-123",
    });
    expect(sid).toBe("my-convo-123");
  });

  it("session_start is deferred until first real event", () => {
    collector.startSession({ model: "claude", permissionMode: "auto" });
    // No events yet — file should be empty or not exist
    expect(readRecords()).toHaveLength(0);

    // First real event triggers session_start + the event itself
    collector.recordUserQuery(10);
    const records = readRecords();
    expect(records).toHaveLength(2);
    expect(records[0].event).toBe("session_start");
    expect(records[1].event).toBe("user_query");
  });

  it("endSession with no events produces no records", () => {
    collector.startSession({ model: "claude", permissionMode: "auto" });
    collector.endSession({ outcome: "cancelled" });
    expect(readRecords()).toHaveLength(0);
  });

  it("endSession writes session_end with outcome fields", () => {
    collector.startSession({ model: "claude", permissionMode: "auto" });
    collector.recordUserQuery(5);
    collector.endSession({ outcome: "success", costUsd: 0.01, durationMs: 500 });

    const records = readRecords();
    const endRecord = records.find((r) => r.event === "session_end");
    expect(endRecord).toBeDefined();
    expect(endRecord!.outcome).toBe("success");
    expect(endRecord!.costUsd).toBe(0.01);
    expect(endRecord!.durationMs).toBe(500);
  });

  it("updateSessionId emits session_linked event", () => {
    const oldSid = collector.startSession({ model: "claude", permissionMode: "auto" });
    collector.recordUserQuery(5);
    collector.updateSessionId("new-id");

    const records = readRecords();
    const linked = records.find((r) => r.event === "session_linked");
    expect(linked).toBeDefined();
    expect(linked!.previousSid).toBe(oldSid);
    expect(linked!.sid).toBe("new-id");

    // Subsequent events use the new session ID
    collector.recordUserQuery(10);
    const lastRecord = readRecords().at(-1);
    expect(lastRecord!.sid).toBe("new-id");
  });
});

// ── Event recording ──────────────────────────────────────────

describe("event recording", () => {
  beforeEach(() => {
    collector.startSession({ model: "claude", permissionMode: "auto" });
  });

  it("recordUserQuery writes correct event shape", () => {
    collector.recordUserQuery(42);
    const records = readRecords();
    const query = records.find((r) => r.event === "user_query");
    expect(query).toBeDefined();
    expect(query!.textLength).toBe(42);
    expect(query!.v).toBe(1);
    expect(query!.sid).toBeTruthy();
    expect(query!.ts).toBeGreaterThan(0);
    expect(query!.did).toBeTruthy();
  });

  it("recordAssistantText includes full text", () => {
    collector.recordAssistantText(5, "hello");
    const records = readRecords();
    const text = records.find((r) => r.event === "assistant_text");
    expect(text!.text).toBe("hello");
    expect(text!.textLength).toBe(5);
  });

  it("recordToolCall includes toolName and toolInput", () => {
    collector.recordToolCall("search_slack", 50, '{"query":"test"}');
    const records = readRecords();
    const tool = records.find((r) => r.event === "tool_call");
    expect(tool!.toolName).toBe("search_slack");
    expect(tool!.toolInput).toBe('{"query":"test"}');
    expect(tool!.inputLength).toBe(50);
  });

  it("sequential events have incrementing seq numbers", () => {
    collector.recordUserQuery(5);
    collector.recordAssistantText(3, "hi");
    collector.recordUserFollowup(10);

    const records = readRecords();
    const seqs = records.map((r) => r.seq);
    // session_start=0, user_query=1, assistant_text=2, user_followup=3
    expect(seqs).toEqual([0, 1, 2, 3]);
  });

  it("all records share the same device ID", () => {
    collector.recordUserQuery(5);
    collector.recordAssistantText(3, "hi");

    const records = readRecords();
    const dids = new Set(records.map((r) => r.did));
    expect(dids.size).toBe(1);
    expect(records[0].did).toBeTruthy();
  });
});

// ── Enable / disable ─────────────────────────────────────────

describe("enable/disable", () => {
  it("disable() stops all recording", () => {
    collector.disable();
    collector.startSession({ model: "claude", permissionMode: "auto" });
    collector.recordUserQuery(10);
    expect(readRecords()).toHaveLength(0);
  });

  it("recording no-ops when no session is active", () => {
    // Don't call startSession
    collector.recordUserQuery(10);
    expect(readRecords()).toHaveLength(0);
  });

  it("enable() after disable() re-enables recording", () => {
    collector.disable();
    collector.enable();
    collector.startSession({ model: "claude", permissionMode: "auto" });
    collector.recordUserQuery(10);
    expect(readRecords().length).toBeGreaterThan(0);
  });
});

// ── deleteData ───────────────────────────────────────────────

describe("deleteData", () => {
  it("removes the JSONL file", () => {
    collector.startSession({ model: "claude", permissionMode: "auto" });
    collector.recordUserQuery(5);
    expect(readRecords().length).toBeGreaterThan(0);

    collector.deleteData();
    expect(fs.existsSync(path.join(tmpDir, "sessions.jsonl"))).toBe(false);
  });

  it("resets sync-state.json to offset 0", () => {
    // Seed a non-zero sync state
    fs.writeFileSync(
      path.join(tmpDir, "sync-state.json"),
      JSON.stringify({ lastSyncByteOffset: 5000 }),
      "utf-8"
    );

    collector.deleteData();

    const state = JSON.parse(fs.readFileSync(path.join(tmpDir, "sync-state.json"), "utf-8"));
    expect(state.lastSyncByteOffset).toBe(0);
  });

  it("is safe when file does not exist", () => {
    // Fresh collector, no data written — should not throw
    expect(() => collector.deleteData()).not.toThrow();
  });
});

// ── Device ID persistence ────────────────────────────────────

describe("device ID", () => {
  it("generates device-id file on first construction", () => {
    const deviceIdPath = path.join(tmpDir, "device-id");
    expect(fs.existsSync(deviceIdPath)).toBe(true);

    const deviceId = fs.readFileSync(deviceIdPath, "utf-8").trim();
    expect(deviceId.length).toBeGreaterThan(0);
  });

  it("reuses existing device-id on subsequent construction", () => {
    const collector2 = new DataCollector(tmpDir);

    // Both collectors should produce events with the same device ID
    collector.startSession({ model: "claude", permissionMode: "auto" });
    collector.recordUserQuery(5);

    collector2.startSession({ model: "claude", permissionMode: "auto" });
    collector2.recordUserQuery(10);

    const records = readRecords();
    const dids = new Set(records.map((r) => r.did));
    expect(dids.size).toBe(1);
  });
});
