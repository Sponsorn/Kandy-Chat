import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  loadAutoBanRules,
  saveAutoBanRules,
  addAutoBanRule,
  updateAutoBanRule,
  removeAutoBanRule
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
  });

  describe("updateAutoBanRule", () => {
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
