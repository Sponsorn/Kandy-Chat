import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  loadAutoBanRules,
  saveAutoBanRules,
  addAutoBanRule,
  updateAutoBanRule,
  removeAutoBanRule,
  parseRegexInput,
  normalizeAutoBanRule
} from "../src/autoBanStore.js";

const storePath = join(process.cwd(), "data", "auto-ban-rules.json");

async function cleanup() {
  try {
    await fs.unlink(storePath);
  } catch {
    // ignore
  }
}

describe("autoBanStore", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  describe("loadAutoBanRules", () => {
    it("returns empty array when file does not exist", async () => {
      const rules = await loadAutoBanRules();
      expect(rules).toEqual([]);
    });

    it("returns rules from file", async () => {
      const rules = [
        {
          id: "test-1",
          pattern: "spam",
          isRegex: false,
          flags: "i",
          enabled: true,
          firstMsgOnly: true,
          createdAt: "2026-03-13T00:00:00Z"
        }
      ];
      await fs.mkdir(join(process.cwd(), "data"), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify({ rules }), "utf8");
      const loaded = await loadAutoBanRules();
      expect(loaded).toEqual(rules);
    });

    it("returns empty array for malformed JSON", async () => {
      await fs.mkdir(join(process.cwd(), "data"), { recursive: true });
      await fs.writeFile(storePath, "not json", "utf8");
      const rules = await loadAutoBanRules();
      expect(rules).toEqual([]);
    });
  });

  describe("parseRegexInput", () => {
    it("returns bare patterns unchanged with default flags", () => {
      expect(parseRegexInput("\\bfoo\\b")).toEqual({ pattern: "\\bfoo\\b", flags: "i" });
    });

    it("strips /pattern/flags delimiters", () => {
      const typed = "/\\bstream\\s*boo\\s*(?:\\.|,|\\(?dot\\)?)\\s*c\\s*o\\s*m\\b/i";
      const parsed = parseRegexInput(typed);
      expect(parsed).toEqual({
        pattern: "\\bstream\\s*boo\\s*(?:\\.|,|\\(?dot\\)?)\\s*c\\s*o\\s*m\\b",
        flags: "i"
      });
      expect(new RegExp(parsed.pattern, parsed.flags).test("Ai Viewers streamboo . Com")).toBe(
        true
      );
    });

    it("keeps flags from the literal and falls back to i when none are given", () => {
      expect(parseRegexInput("/foo/gi")).toEqual({ pattern: "foo", flags: "gi" });
      expect(parseRegexInput("/foo/")).toEqual({ pattern: "foo", flags: "i" });
      expect(parseRegexInput("/foo/", "m")).toEqual({ pattern: "foo", flags: "m" });
    });

    it("drops invalid and duplicate flags", () => {
      expect(parseRegexInput("foo", "iix")).toEqual({ pattern: "foo", flags: "i" });
      expect(parseRegexInput("foo", "xyz")).toEqual({ pattern: "foo", flags: "y" });
    });

    it("does not treat a lone slash or escaped slashes inside a pattern as delimiters", () => {
      expect(parseRegexInput("/")).toEqual({ pattern: "/", flags: "i" });
      expect(parseRegexInput("a/b")).toEqual({ pattern: "a/b", flags: "i" });
      expect(parseRegexInput("/https?:\\/\\/foo/i")).toEqual({
        pattern: "https?:\\/\\/foo",
        flags: "i"
      });
    });
  });

  describe("normalizeAutoBanRule", () => {
    it("unwraps regex rules that were saved with delimiters", () => {
      const rule = { id: "x", pattern: "/foo/i", isRegex: true, flags: "i" };
      expect(normalizeAutoBanRule(rule)).toEqual({ ...rule, pattern: "foo", flags: "i" });
    });

    it("leaves plain-text rules alone", () => {
      const rule = { id: "x", pattern: "/foo/i", isRegex: false, flags: "i" };
      expect(normalizeAutoBanRule(rule)).toBe(rule);
    });
  });

  describe("addAutoBanRule", () => {
    it("adds a rule with generated id and createdAt", async () => {
      const result = await addAutoBanRule({
        pattern: "\\w+\\s+\\.com",
        isRegex: true,
        flags: "i",
        enabled: true,
        firstMsgOnly: true
      });
      expect(result.id).toBeDefined();
      expect(result.pattern).toBe("\\w+\\s+\\.com");
      expect(result.isRegex).toBe(true);
      expect(result.createdAt).toBeDefined();

      const loaded = await loadAutoBanRules();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe(result.id);
    });

    it("strips /pattern/flags delimiters from regex rules", async () => {
      const rule = await addAutoBanRule({
        pattern: "/\\bfoo\\b/gi",
        isRegex: true,
        flags: "i",
        enabled: true,
        firstMsgOnly: false
      });
      expect(rule.pattern).toBe("\\bfoo\\b");
      expect(rule.flags).toBe("gi");
      const [stored] = await loadAutoBanRules();
      expect(stored.pattern).toBe("\\bfoo\\b");
    });

    it("keeps plain-text patterns verbatim", async () => {
      const rule = await addAutoBanRule({
        pattern: "/not a regex/",
        isRegex: false,
        enabled: true,
        firstMsgOnly: false
      });
      expect(rule.pattern).toBe("/not a regex/");
      expect(rule.flags).toBe("i");
    });
  });

  describe("loadAutoBanRules with legacy delimited patterns", () => {
    it("unwraps regex rules saved with delimiters", async () => {
      await saveAutoBanRules([
        { id: "legacy", pattern: "/foo/i", isRegex: true, flags: "i", enabled: true }
      ]);
      const [rule] = await loadAutoBanRules();
      expect(rule.pattern).toBe("foo");
      expect(rule.flags).toBe("i");
    });
  });

  describe("updateAutoBanRule", () => {
    it("strips delimiters when the pattern is updated", async () => {
      const created = await addAutoBanRule({
        pattern: "foo",
        isRegex: true,
        enabled: true,
        firstMsgOnly: false
      });
      const updated = await updateAutoBanRule(created.id, { pattern: "/bar/m" });
      expect(updated.pattern).toBe("bar");
      expect(updated.flags).toBe("m");
    });

    it("updates specified fields only", async () => {
      const rule = await addAutoBanRule({
        pattern: "test",
        isRegex: false,
        flags: "i",
        enabled: true,
        firstMsgOnly: false
      });

      const updated = await updateAutoBanRule(rule.id, { enabled: false });
      expect(updated.enabled).toBe(false);
      expect(updated.pattern).toBe("test");
      expect(updated.firstMsgOnly).toBe(false);
    });

    it("returns null for non-existent rule", async () => {
      const result = await updateAutoBanRule("nonexistent", { enabled: false });
      expect(result).toBeNull();
    });
  });

  describe("removeAutoBanRule", () => {
    it("removes a rule by id", async () => {
      const rule = await addAutoBanRule({
        pattern: "test",
        isRegex: false,
        flags: "i",
        enabled: true,
        firstMsgOnly: false
      });

      const removed = await removeAutoBanRule(rule.id);
      expect(removed).toBe(true);

      const loaded = await loadAutoBanRules();
      expect(loaded).toHaveLength(0);
    });

    it("returns false for non-existent rule", async () => {
      const removed = await removeAutoBanRule("nonexistent");
      expect(removed).toBe(false);
    });
  });
});
