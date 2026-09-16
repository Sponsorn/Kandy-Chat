import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  loadEmojiMappings,
  addEmojiMapping,
  removeEmojiMapping,
  loadUnmappedEmojis
} from "../src/emojiMappingStore.js";
import { promises as fs } from "node:fs";

vi.mock("node:fs", () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn()
  }
}));

describe("emojiMappingStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("loadEmojiMappings", () => {
    it("returns saved mappings merged with defaults", async () => {
      fs.readFile.mockResolvedValue(JSON.stringify({ ":custom:": "CustomEmote" }));
      const mappings = await loadEmojiMappings();
      expect(mappings[":custom:"]).toBe("CustomEmote");
      // Defaults should also be present
      expect(mappings[":thumbsup:"]).toBe("\uD83D\uDC4D");
    });

    it("returns defaults when file does not exist", async () => {
      fs.readFile.mockRejectedValue(Object.assign(new Error(), { code: "ENOENT" }));
      const mappings = await loadEmojiMappings();
      expect(mappings[":thumbsup:"]).toBe("\uD83D\uDC4D");
      expect(mappings[":heart:"]).toBe("\u2764\uFE0F");
    });
  });

  describe("addEmojiMapping", () => {
    it("adds a new mapping and persists", async () => {
      fs.readFile.mockResolvedValue(JSON.stringify({}));
      fs.mkdir.mockResolvedValue(undefined);
      fs.writeFile.mockResolvedValue(undefined);

      const result = await addEmojiMapping(":test:", "TestEmote");
      expect(result.added).toBe(true);
      expect(result.mappings[":test:"]).toBe("TestEmote");
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it("updates existing mapping", async () => {
      fs.readFile.mockResolvedValue(JSON.stringify({ ":test:": "OldValue" }));
      fs.mkdir.mockResolvedValue(undefined);
      fs.writeFile.mockResolvedValue(undefined);

      const result = await addEmojiMapping(":test:", "NewValue");
      expect(result.added).toBe(true);
      expect(result.mappings[":test:"]).toBe("NewValue");
    });
  });

  describe("removeEmojiMapping", () => {
    it("removes an existing mapping", async () => {
      fs.readFile.mockResolvedValue(JSON.stringify({ ":test:": "Val" }));
      fs.mkdir.mockResolvedValue(undefined);
      fs.writeFile.mockResolvedValue(undefined);

      const result = await removeEmojiMapping(":test:");
      expect(result.removed).toBe(true);
      expect(result.mappings[":test:"]).toBeUndefined();
    });

    it("returns removed=false for non-existent mapping", async () => {
      fs.readFile.mockResolvedValue(JSON.stringify({}));

      const result = await removeEmojiMapping(":nope:");
      expect(result.removed).toBe(false);
    });
  });

  describe("loadUnmappedEmojis", () => {
    const unmappedFile = JSON.stringify({
      ":rare:": { count: 1, last_seen: "2026-09-16T10:00:00Z", sample: "a :rare: one" },
      ":common:": { count: 7, last_seen: "2026-09-16T09:00:00Z", sample: ":common: hi" },
      ":thumbsup:": { count: 3, last_seen: "2026-09-16T09:30:00Z", sample: "" },
      ":broken:": "not an object"
    });

    function mockFiles({ unmapped, mappings }) {
      fs.readFile.mockImplementation(async (path) => {
        if (String(path).endsWith("emoji-unmapped.json")) {
          if (unmapped instanceof Error) throw unmapped;
          return unmapped;
        }
        if (mappings instanceof Error) throw mappings;
        return mappings;
      });
    }

    it("returns entries sorted by count, excluding already mapped and malformed ones", async () => {
      mockFiles({ unmapped: unmappedFile, mappings: JSON.stringify({}) });
      const result = await loadUnmappedEmojis();
      // :thumbsup: is a default mapping, :broken: is malformed
      expect(result.map((e) => e.emoji)).toEqual([":common:", ":rare:"]);
      expect(result[0]).toEqual({
        emoji: ":common:",
        count: 7,
        lastSeen: "2026-09-16T09:00:00Z",
        sample: ":common: hi"
      });
    });

    it("drops entries that were mapped in the saved mappings file", async () => {
      mockFiles({ unmapped: unmappedFile, mappings: JSON.stringify({ ":common:": "C" }) });
      const result = await loadUnmappedEmojis();
      expect(result.map((e) => e.emoji)).toEqual([":rare:"]);
    });

    it("returns an empty list when the relay has not written the file yet", async () => {
      mockFiles({
        unmapped: Object.assign(new Error(), { code: "ENOENT" }),
        mappings: JSON.stringify({})
      });
      expect(await loadUnmappedEmojis()).toEqual([]);
    });

    it("returns an empty list when the file is being rewritten and is not valid JSON", async () => {
      mockFiles({ unmapped: "{ partial", mappings: JSON.stringify({}) });
      expect(await loadUnmappedEmojis()).toEqual([]);
    });
  });
});
