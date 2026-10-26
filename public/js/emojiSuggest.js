// Suggests Unicode emojis for a YouTube shortcode by matching the words in its
// name against Emojibase's English labels and tags. The dataset (~540 KB) is
// fetched from the CDN the first time it is needed and cached by the browser.

const EMOJI_DATA_URL = "https://cdn.jsdelivr.net/npm/emojibase-data@16.0.3/en/compact.json";

// Words in YouTube's emoji names that describe the artwork, not the meaning
const IGNORED_WORDS = new Set([
  "blue",
  "fuchsia",
  "green",
  "orange",
  "pink",
  "purple",
  "red",
  "teal",
  "turquoise",
  "turqouise",
  "white",
  "yellow",
  "shape",
  "with"
]);

// Emojibase group 2 holds skin tones and hair components, not emojis
const COMPONENT_GROUP = 2;

function stem(word) {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/**
 * Split a shortcode such as ":face-blue-smiling:" or ":_kandyHype:" into
 * lowercase words, dropping colors and filler.
 */
export function shortcodeWords(shortcode) {
  return shortcode
    .replace(/^:+|:+$/g, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 1 && !IGNORED_WORDS.has(w));
}

/**
 * Rank emojis for a shortcode.
 * @param {string} shortcode
 * @param {Array<{ label: string, unicode: string, tags?: string[], group?: number }>} data
 * @param {number} [limit]
 * @returns {string[]} Unicode emojis, best match first
 */
export function suggestEmojis(shortcode, data, limit = 3) {
  const words = shortcodeWords(shortcode).map(stem);
  if (words.length === 0) return [];

  const scored = [];
  for (const entry of data) {
    if (entry.group === undefined || entry.group === COMPONENT_GROUP) continue;
    const labelWords = entry.label
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map(stem);
    const tags = (entry.tags || []).map((t) => stem(t.toLowerCase()));

    let score = 0;
    let meaningful = 0;
    for (const word of words) {
      let points = 0;
      if (labelWords.includes(word)) points = 2;
      else if (tags.includes(word)) points = 1.5;
      else if (word.length >= 4 && labelWords.some((l) => l.length >= 4 && l.startsWith(word))) {
        points = 0.5;
      }
      score += points;
      // "face" alone matches a hundred emojis; require some other word to hit
      if (points > 0 && word !== "face") meaningful += 1;
    }
    if (meaningful === 0) continue;
    // Prefer short labels: "smiling face" over "smiling face with open hands"
    score -= labelWords.length * 0.05;
    scored.push({ unicode: entry.unicode, score, order: entry.order ?? 0 });
  }

  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, limit).map((s) => s.unicode);
}

let dataPromise = null;

/** Fetch the Emojibase dataset once per page load. Resolves to [] when unavailable. */
export function loadEmojiData() {
  if (!dataPromise) {
    dataPromise = fetch(EMOJI_DATA_URL)
      .then((res) => (res.ok ? res.json() : []))
      .catch(() => {
        dataPromise = null;
        return [];
      });
  }
  return dataPromise;
}
