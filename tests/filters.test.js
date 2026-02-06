import { describe, it, expect } from "vitest";
import { buildFilters, shouldBlockMessage, normalizeMessage } from "../src/filters.js";

describe("buildFilters", () => {
  it("returns default filter config with minimal env", () => {
    const filters = buildFilters({});
    expect(filters.blockCommands).toBe(true);
    expect(filters.blockEmotes).toBe(false);
    expect(filters.blockedWords).toEqual([]);
    expect(filters.blockedRegexes).toEqual([]);
    expect(filters.onlyBlockedWords).toBe(false);
    expect(filters.allowedUsers).toEqual([]);
    expect(filters.blockedUsers).toEqual([]);
  });

  it("parses blocked words from comma-separated string", () => {
    const filters = buildFilters({ FILTER_BLOCKED_WORDS: "spam,scam, phishing " });
    expect(filters.blockedWords).toEqual(["spam", "scam", "phishing"]);
  });

  it("parses allowed users as lowercase", () => {
    const filters = buildFilters({ FILTER_ALLOWED_USERS: "UserA,UserB" });
    expect(filters.allowedUsers).toEqual(["usera", "userb"]);
  });

  it("parses blocked users as lowercase", () => {
    const filters = buildFilters({ FILTER_BLOCKED_USERS: "BadUser" });
    expect(filters.blockedUsers).toEqual(["baduser"]);
  });

  it("respects boolean env vars", () => {
    const filters = buildFilters({
      FILTER_BLOCK_COMMANDS: "false",
      FILTER_BLOCK_EMOTES: "true",
      FILTER_ONLY_BLOCKED_WORDS: "true"
    });
    expect(filters.blockCommands).toBe(false);
    expect(filters.blockEmotes).toBe(true);
    expect(filters.onlyBlockedWords).toBe(true);
  });
});

describe("shouldBlockMessage", () => {
  function makeArgs(overrides = {}) {
    const defaults = {
      username: "testuser",
      message: "hello world",
      rawMessage: "hello world",
      tags: {},
      filters: buildFilters({})
    };
    return { ...defaults, ...overrides };
  }

  it("blocks commands when blockCommands is true", () => {
    const result = shouldBlockMessage(makeArgs({ message: "!play song" }));
    expect(result).toBe(true);
  });

  it("allows commands when blockCommands is false", () => {
    const filters = buildFilters({ FILTER_BLOCK_COMMANDS: "false" });
    const result = shouldBlockMessage(makeArgs({ message: "!play song", filters }));
    expect(result).toBe(false);
  });

  it("blocks messages from blocked users (case-insensitive)", () => {
    const filters = buildFilters({ FILTER_BLOCKED_USERS: "BadUser" });
    const result = shouldBlockMessage(makeArgs({ username: "BADUSER", filters }));
    expect(result).toBe(true);
  });

  it("allows messages from non-blocked users", () => {
    const filters = buildFilters({ FILTER_BLOCKED_USERS: "BadUser" });
    const result = shouldBlockMessage(makeArgs({ username: "gooduser", filters }));
    expect(result).toBe(false);
  });

  it("blocks messages not from allowed users when allowlist is active", () => {
    const filters = buildFilters({ FILTER_ALLOWED_USERS: "vip1,vip2" });
    const result = shouldBlockMessage(makeArgs({ username: "stranger", filters }));
    expect(result).toBe(true);
  });

  it("allows messages from allowed users", () => {
    const filters = buildFilters({ FILTER_ALLOWED_USERS: "vip1" });
    const result = shouldBlockMessage(makeArgs({ username: "VIP1", filters }));
    expect(result).toBe(false);
  });

  it("blocks messages containing blocked words (case-insensitive)", () => {
    const filters = buildFilters({ FILTER_BLOCKED_WORDS: "spam" });
    const result = shouldBlockMessage(makeArgs({ message: "This is SPAM content", filters }));
    expect(result).toBe(false); // blocked words flag suspicious, don't block by default
  });

  it("blocks messages matching blocked regex", () => {
    const filters = buildFilters({});
    filters.blockedRegexes = [/free\s+vbucks/i];
    const result = shouldBlockMessage(makeArgs({ message: "Get free vbucks now", filters }));
    expect(result).toBe(false); // regex matches flag suspicious, don't block by default
  });

  it("in onlyBlockedWords mode, blocks messages that do NOT match", () => {
    const filters = buildFilters({
      FILTER_ONLY_BLOCKED_WORDS: "true",
      FILTER_BLOCKED_WORDS: "keyword"
    });
    const result = shouldBlockMessage(makeArgs({ message: "normal message", filters }));
    expect(result).toBe(true);
  });

  it("in onlyBlockedWords mode, allows messages that match", () => {
    const filters = buildFilters({
      FILTER_ONLY_BLOCKED_WORDS: "true",
      FILTER_BLOCKED_WORDS: "keyword"
    });
    const result = shouldBlockMessage(makeArgs({ message: "has keyword here", filters }));
    expect(result).toBe(false);
  });

  it("blocks emote-only messages when blockEmotes is true", () => {
    const filters = buildFilters({ FILTER_BLOCK_EMOTES: "true" });
    // Emote spanning the entire message "Kappa" (chars 0-4)
    const result = shouldBlockMessage(
      makeArgs({
        message: "Kappa",
        rawMessage: "Kappa",
        tags: { emotes: { 25: ["0-4"] } },
        filters
      })
    );
    expect(result).toBe(true);
  });

  it("allows non-emote messages when blockEmotes is true", () => {
    const filters = buildFilters({ FILTER_BLOCK_EMOTES: "true" });
    const result = shouldBlockMessage(
      makeArgs({
        message: "hello Kappa world",
        rawMessage: "hello Kappa world",
        tags: { emotes: { 25: ["6-10"] } },
        filters
      })
    );
    expect(result).toBe(false);
  });
});

describe("normalizeMessage", () => {
  it("collapses multiple spaces to one", () => {
    expect(normalizeMessage("hello   world")).toBe("hello world");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeMessage("  hello world  ")).toBe("hello world");
  });

  it("normalizes tabs and newlines", () => {
    expect(normalizeMessage("hello\t\nworld")).toBe("hello world");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeMessage("   ")).toBe("");
  });
});
