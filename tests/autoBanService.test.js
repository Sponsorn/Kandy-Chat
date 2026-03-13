import { describe, it, expect, beforeEach } from "vitest";
import { checkAutoBan } from "../src/services/autoBanService.js";
import botState from "../src/state/BotState.js";

describe("checkAutoBan", () => {
  beforeEach(() => {
    botState.autoBanRules = [];
    botState.autoBanCompiledRegexes.clear();
  });

  it("returns not matched when no rules exist", () => {
    const result = checkAutoBan("hello world", { "first-msg": "1" });
    expect(result.matched).toBe(false);
  });

  it("matches a regex rule for first-time chatter", () => {
    const rule = {
      id: "r1",
      pattern: "\\w+\\s+\\.com",
      isRegex: true,
      flags: "i",
      enabled: true,
      firstMsgOnly: true
    };
    botState.autoBanRules = [rule];
    botState.autoBanCompiledRegexes.set("r1", new RegExp(rule.pattern, rule.flags));

    const result = checkAutoBan("visit example .com now", { "first-msg": "1" });
    expect(result.matched).toBe(true);
    expect(result.rule.id).toBe("r1");
  });

  it("skips firstMsgOnly rule when not first message", () => {
    const rule = {
      id: "r1",
      pattern: "\\w+\\s+\\.com",
      isRegex: true,
      flags: "i",
      enabled: true,
      firstMsgOnly: true
    };
    botState.autoBanRules = [rule];
    botState.autoBanCompiledRegexes.set("r1", new RegExp(rule.pattern, rule.flags));

    const result = checkAutoBan("visit example .com now", { "first-msg": "0" });
    expect(result.matched).toBe(false);
  });

  it("does not match firstMsgOnly rule when first-msg tag is missing", () => {
    const rule = {
      id: "r1",
      pattern: "spam",
      isRegex: false,
      enabled: true,
      firstMsgOnly: true
    };
    botState.autoBanRules = [rule];

    const result = checkAutoBan("spam link", {});
    expect(result.matched).toBe(false);
  });

  it("matches non-firstMsgOnly rule for any chatter", () => {
    const rule = {
      id: "r1",
      pattern: "free nitro",
      isRegex: false,
      enabled: true,
      firstMsgOnly: false
    };
    botState.autoBanRules = [rule];

    const result = checkAutoBan("get free nitro here", { "first-msg": "0" });
    expect(result.matched).toBe(true);
  });

  it("skips disabled rules", () => {
    const rule = {
      id: "r1",
      pattern: "spam",
      isRegex: false,
      enabled: false,
      firstMsgOnly: false
    };
    botState.autoBanRules = [rule];

    const result = checkAutoBan("spam link", { "first-msg": "1" });
    expect(result.matched).toBe(false);
  });

  it("plain text match is case-insensitive", () => {
    const rule = {
      id: "r1",
      pattern: "Free Nitro",
      isRegex: false,
      enabled: true,
      firstMsgOnly: false
    };
    botState.autoBanRules = [rule];

    const result = checkAutoBan("GET FREE NITRO NOW", {});
    expect(result.matched).toBe(true);
  });

  it("first match wins with multiple rules", () => {
    botState.autoBanRules = [
      { id: "r1", pattern: "first", isRegex: false, enabled: true, firstMsgOnly: false },
      { id: "r2", pattern: "first", isRegex: false, enabled: true, firstMsgOnly: false }
    ];

    const result = checkAutoBan("first match test", {});
    expect(result.rule.id).toBe("r1");
  });

  it("skips rule with missing compiled regex", () => {
    const rule = {
      id: "r1",
      pattern: "[invalid",
      isRegex: true,
      flags: "i",
      enabled: true,
      firstMsgOnly: false
    };
    botState.autoBanRules = [rule];
    // Don't add to compiledRegexes — simulates failed compilation

    const result = checkAutoBan("test", {});
    expect(result.matched).toBe(false);
  });
});
