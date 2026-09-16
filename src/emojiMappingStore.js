import { promises as fs } from "node:fs";
import { join } from "node:path";

const storeDir = join(process.cwd(), "data");
const storePath = join(storeDir, "emoji-mappings.json");
// Written by youtube-relay: shortcodes seen in YouTube chat that had no mapping
const unmappedPath = join(storeDir, "emoji-unmapped.json");

const DEFAULT_MAPPINGS = {
  ":thumbsup:": "\uD83D\uDC4D",
  ":thumbs_down:": "\uD83D\uDC4E",
  ":heart:": "\u2764\uFE0F",
  ":red_heart:": "\u2764\uFE0F",
  ":sparkling_heart:": "\u2764\uFE0F",
  ":broken_heart:": "\uD83D\uDC94",
  ":star:": "\u2B50",
  ":fire:": "\uD83D\uDD25",
  ":clap:": "\uD83D\uDC4F",
  ":eyes:": "\uD83D\uDC40",
  ":sob:": "\uD83D\uDE2D",
  ":joy:": "\uD83D\uDE02",
  ":skull:": "\uD83D\uDC80",
  ":100:": "\uD83D\uDCAF",
  ":wave:": "\uD83D\uDC4B",
  ":pray:": "\uD83D\uDE4F",
  ":raised_hands:": "\uD83D\uDE4C",
  ":muscle:": "\uD83D\uDCAA",
  ":crown:": "\uD83D\uDC51",
  ":sunglasses:": "\uD83D\uDE0E",
  ":thinking:": "\uD83E\uDD14",
  ":ok_hand:": "\uD83D\uDC4C",
  ":yt:": "",
  ":oops:": "",
  ":buffering:": ""
};

async function loadEmojiMappings() {
  try {
    const data = await fs.readFile(storePath, "utf8");
    const saved = JSON.parse(data);
    return { ...DEFAULT_MAPPINGS, ...saved };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { ...DEFAULT_MAPPINGS };
    }
    throw error;
  }
}

async function saveEmojiMappings(mappings) {
  await fs.mkdir(storeDir, { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(mappings, null, 2), "utf8");
}

async function addEmojiMapping(emoji, replacement) {
  const cleaned = emoji.trim();
  if (!cleaned) return { added: false, mappings: await loadEmojiMappings() };
  const mappings = await loadEmojiMappings();
  mappings[cleaned] = replacement;
  await saveEmojiMappings(mappings);
  return { added: true, mappings };
}

async function removeEmojiMapping(emoji) {
  const cleaned = emoji.trim();
  if (!cleaned) return { removed: false, mappings: await loadEmojiMappings() };
  const mappings = await loadEmojiMappings();
  if (!(cleaned in mappings)) {
    return { removed: false, mappings };
  }
  delete mappings[cleaned];
  await saveEmojiMappings(mappings);
  return { removed: true, mappings };
}

/**
 * Load the unmapped emojis recorded by youtube-relay, minus anything that has
 * been mapped since. Sorted by how often they were seen, most frequent first.
 * @returns {Promise<Array<{ emoji: string, count: number, lastSeen: string|null, sample: string }>>}
 */
async function loadUnmappedEmojis() {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(unmappedPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return [];
    throw error;
  }
  if (!raw || typeof raw !== "object") return [];

  const mappings = await loadEmojiMappings();
  const entries = [];
  for (const [emoji, entry] of Object.entries(raw)) {
    if (emoji in mappings) continue;
    if (!entry || typeof entry !== "object") continue;
    entries.push({
      emoji,
      count: Number.isFinite(entry.count) ? entry.count : 0,
      lastSeen: typeof entry.last_seen === "string" ? entry.last_seen : null,
      sample: typeof entry.sample === "string" ? entry.sample : ""
    });
  }

  entries.sort((a, b) => b.count - a.count || (b.lastSeen || "").localeCompare(a.lastSeen || ""));
  return entries;
}

export {
  loadEmojiMappings,
  addEmojiMapping,
  removeEmojiMapping,
  loadUnmappedEmojis,
  DEFAULT_MAPPINGS
};
