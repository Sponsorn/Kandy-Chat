import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotState } from "../src/state/BotState.js";
import {
  configureLogStore,
  loadPersistedLogs,
  attachLogPersistence,
  detachLogPersistence,
  flushLogs
} from "../src/logStore.js";

let dir;

function readJson(name) {
  return JSON.parse(readFileSync(join(dir, name), "utf8"));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kandy-logs-"));
  configureLogStore({ dir });
});

afterEach(() => {
  detachLogPersistence();
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("loadPersistedLogs", () => {
  it("returns empty logs when no files exist", () => {
    expect(loadPersistedLogs()).toEqual({ logBuffer: [], auditLog: [], modActions: [] });
  });

  it("ignores corrupt files and malformed entries", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(join(dir, "bot-log.json"), "{not json");
    writeFileSync(
      join(dir, "audit-log.json"),
      JSON.stringify([{ id: "ok", action: "restart", timestamp: 1 }, "junk", null, { id: "x" }])
    );
    const logs = loadPersistedLogs();
    expect(logs.logBuffer).toEqual([]);
    expect(logs.auditLog).toEqual([{ id: "ok", action: "restart", timestamp: 1 }]);
    expect(logs.modActions).toEqual([]);
  });
});

describe("attachLogPersistence", () => {
  it("writes each log to disk and restores it into a fresh BotState", () => {
    const state = new BotState();
    attachLogPersistence(state, { installShutdownHooks: false });

    state.addLogEntry("info", ["hello", { a: 1 }]);
    state.addLogEntry("error", ["boom"]);
    state.recordAuditEvent("restart", "anton", { reason: "test" }, "dashboard");
    state.recordModerationAction("ban", "anton", "spammer", { channel: "kandyland" });
    flushLogs();

    expect(readJson("bot-log.json").map((e) => e.message)).toEqual(['hello {"a":1}', "boom"]);
    expect(readJson("audit-log.json")[0].action).toBe("restart");
    expect(readJson("mod-log.json")[0].target).toBe("spammer");

    // Simulate a restart
    detachLogPersistence();
    const restarted = new BotState();
    const { restored } = attachLogPersistence(restarted, { installShutdownHooks: false });

    expect(restored).toEqual({ logBuffer: 2, auditLog: 1, modActions: 1 });
    expect(restarted.logBuffer.map((e) => e.message)).toEqual(['hello {"a":1}', "boom"]);
    expect(restarted.getAuditLog()[0].actor).toBe("anton");
    expect(restarted.getModLog()[0].action).toBe("ban");
  });

  it("keeps entries recorded before hydration in the right order", () => {
    const first = new BotState();
    attachLogPersistence(first, { installShutdownHooks: false });
    first.addLogEntry("info", ["old line"]);
    first.recordAuditEvent("stop", "system");
    flushLogs();
    detachLogPersistence();

    // Startup logs are emitted before the store is attached
    const second = new BotState();
    second.addLogEntry("info", ["startup line"]);
    second.recordAuditEvent("start", "system");
    attachLogPersistence(second, { installShutdownHooks: false });

    expect(second.logBuffer.map((e) => e.message)).toEqual(["old line", "startup line"]);
    expect(second.auditLog.map((e) => e.action)).toEqual(["start", "stop"]);
  });

  it("trims restored logs to the configured maximum", () => {
    const entries = Array.from({ length: 600 }, (_, i) => ({
      id: String(i),
      level: "info",
      message: `m${i}`,
      timestamp: i
    }));
    writeFileSync(join(dir, "bot-log.json"), JSON.stringify(entries));

    const state = new BotState();
    attachLogPersistence(state, { installShutdownHooks: false });

    expect(state.logBuffer).toHaveLength(state.maxLogBuffer);
    expect(state.logBuffer[0].message).toBe("m100");
    expect(state.logBuffer.at(-1).message).toBe("m599");
  });

  it("debounces writes and flushes them on the timer", () => {
    vi.useFakeTimers();
    const state = new BotState();
    attachLogPersistence(state, { installShutdownHooks: false });

    state.addLogEntry("info", ["one"]);
    state.addLogEntry("info", ["two"]);
    expect(existsSync(join(dir, "bot-log.json"))).toBe(false);

    vi.advanceTimersByTime(2000);
    expect(readJson("bot-log.json")).toHaveLength(2);
  });

  it("stops writing after detach", () => {
    const state = new BotState();
    attachLogPersistence(state, { installShutdownHooks: false });
    detachLogPersistence();

    state.addLogEntry("info", ["ignored"]);
    flushLogs();
    expect(existsSync(join(dir, "bot-log.json"))).toBe(false);
  });
});
