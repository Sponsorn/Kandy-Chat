import { promises as fs } from "node:fs";
import { join } from "node:path";

const storeDir = join(process.cwd(), "data");
const storePath = join(storeDir, "blacklist.json");

async function loadBlacklist() {
  try {
    const data = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function saveBlacklist(words) {
  await fs.mkdir(storeDir, { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(words, null, 2), "utf8");
}

async function addBlacklistWord(word) {
  const cleaned = word.trim();
  if (!cleaned) return { added: false, words: await loadBlacklist() };
  const words = await loadBlacklist();
  if (words.includes(cleaned)) {
    return { added: false, words };
  }
  words.push(cleaned);
  await saveBlacklist(words);
  return { added: true, words };
}

async function removeBlacklistWord(word) {
  const cleaned = word.trim();
  if (!cleaned) return { removed: false, words: await loadBlacklist() };
  const words = await loadBlacklist();
  const next = words.filter((item) => item !== cleaned);
  if (next.length === words.length) {
    return { removed: false, words };
  }
  await saveBlacklist(next);
  return { removed: true, words: next };
}

export { addBlacklistWord, loadBlacklist, removeBlacklistWord };
