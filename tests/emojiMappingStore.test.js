import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  loadEmojiMappings,
  addEmojiMapping,
  removeEmojiMapping
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
});
