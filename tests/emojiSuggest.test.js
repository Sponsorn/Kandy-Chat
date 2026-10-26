import { describe, it, expect } from "vitest";
import { shortcodeWords, suggestEmojis } from "../public/js/emojiSuggest.js";

const DATA = [
  { label: "regional indicator A", unicode: "🇦" },
  { label: "light skin tone", unicode: "🏻", group: 2, tags: ["smiling"] },
  { label: "smiling face", unicode: "☺️", group: 0, tags: ["face", "smile"], order: 10 },
  {
    label: "smiling face with open hands",
    unicode: "🤗",
    group: 0,
    tags: ["hug", "smile"],
    order: 20
  },
  { label: "waving hand", unicode: "👋", group: 1, tags: ["hand", "wave"], order: 30 },
  { label: "loudly crying face", unicode: "😭", group: 0, tags: ["cry", "sob"], order: 40 },
  { label: "face with tears of joy", unicode: "😂", group: 0, tags: ["joy", "laugh"], order: 5 }
];

describe("shortcodeWords", () => {
  it("drops colors and splits dashes, underscores and camelCase", () => {
    expect(shortcodeWords(":face-blue-smiling:")).toEqual(["face", "smiling"]);
    expect(shortcodeWords(":_kandyHype:")).toEqual(["kandy", "hype"]);
    expect(shortcodeWords(":face_with_tears_of_joy:")).toEqual(["face", "tears", "of", "joy"]);
  });
});

describe("suggestEmojis", () => {
  it("ranks the closest label first and skips components", () => {
    expect(suggestEmojis(":face-blue-smiling:", DATA)).toEqual(["☺️", "🤗"]);
    expect(suggestEmojis(":hand-pink-waving:", DATA)[0]).toBe("👋");
    expect(suggestEmojis(":face-purple-crying:", DATA)[0]).toBe("😭");
  });

  it("matches tags", () => {
    expect(suggestEmojis(":joy:", DATA)).toEqual(["😂"]);
  });

  it("does not suggest on the word face alone", () => {
    expect(suggestEmojis(":face-orange:", DATA)).toEqual([]);
  });

  it("returns nothing for names with no known words", () => {
    expect(suggestEmojis(":_kandyHype:", DATA)).toEqual([]);
  });
});
