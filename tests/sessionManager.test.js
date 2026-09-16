import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureSessionStore,
  createSession,
  getSession,
  destroySession,
  setSessionPermission,
  flushSessions,
  sessionMiddleware,
  Permissions,
  SESSION_MAX_AGE
} from "../src/auth/sessionManager.js";

let dir;
let path;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kandy-sessions-"));
  path = join(dir, "sessions.json");
  configureSessionStore({ path });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("session persistence", () => {
  it("writes sessions to disk and restores them after a restart", () => {
    const id = createSession({ provider: "discord", username: "anton" });
    setSessionPermission(id, Permissions.ADMIN);
    flushSessions();

    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].user.username).toBe("anton");

    // Simulate a restart: fresh in-memory state, same file
    configureSessionStore({ path });
    const restored = getSession(id);
    expect(restored?.user.username).toBe("anton");
    expect(restored?.permission).toBe(Permissions.ADMIN);
  });

  it("does not restore expired sessions", () => {
    const stale = {
      id: "old",
      user: { username: "gone" },
      permission: 1,
      createdAt: Date.now() - SESSION_MAX_AGE - 1000,
      lastAccess: Date.now() - SESSION_MAX_AGE - 1000
    };
    writeFileSync(path, JSON.stringify([stale]));
    configureSessionStore({ path });
    expect(getSession("old")).toBeNull();
  });

  it("removes destroyed sessions from disk", () => {
    const id = createSession({ username: "x" });
    flushSessions();
    destroySession(id);
    flushSessions();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([]);
  });

  it("starts empty when the file is corrupt", () => {
    writeFileSync(path, "{ not json");
    configureSessionStore({ path });
    expect(getSession("anything")).toBeNull();
  });
});

describe("rolling expiry", () => {
  it("keeps an active session alive past the max age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T10:00:00Z"));
    const id = createSession({ username: "active" });

    // Visit every 10 days for 50 days
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(10 * 24 * 60 * 60 * 1000);
      expect(getSession(id)).not.toBeNull();
    }
  });

  it("expires a session left idle for more than the max age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T10:00:00Z"));
    const id = createSession({ username: "idle" });
    vi.advanceTimersByTime(SESSION_MAX_AGE + 1000);
    expect(getSession(id)).toBeNull();
  });

  it("re-issues the cookie through the middleware once the session was extended", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T10:00:00Z"));
    const id = createSession({ username: "cookie" });
    const middleware = sessionMiddleware({ domain: "dash.example.com", secure: true });

    const run = () => {
      const req = { headers: { cookie: `session=${id}` } };
      const res = { setHeader: vi.fn() };
      const next = vi.fn();
      middleware(req, res, next);
      expect(next).toHaveBeenCalled();
      return res.setHeader;
    };

    // Right after login: no re-issue
    expect(run()).not.toHaveBeenCalled();

    // Two hours later: lastAccess moved, cookie refreshed with the full lifetime
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    const setHeader = run();
    expect(setHeader).toHaveBeenCalledTimes(1);
    const [name, value] = setHeader.mock.calls[0];
    expect(name).toBe("Set-Cookie");
    expect(value).toContain(`session=${id}`);
    expect(value).toContain(`Max-Age=${Math.floor(SESSION_MAX_AGE / 1000)}`);
    expect(value).toContain("Domain=dash.example.com");

    // Immediately again: not refreshed twice
    expect(run()).not.toHaveBeenCalled();
  });
});
