import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const storeDir = join(process.cwd(), "data");
const storePath = join(storeDir, "auto-ban-rules.json");

export async function loadAutoBanRules() {
  try {
    const data = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(data);
    return Array.isArray(parsed?.rules) ? parsed.rules : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    console.warn("Failed to parse auto-ban rules file:", error.message);
    return [];
  }
}

export async function saveAutoBanRules(rules) {
  await fs.mkdir(storeDir, { recursive: true });
  await fs.writeFile(storePath, JSON.stringify({ rules }, null, 2), "utf8");
}

export async function addAutoBanRule({ pattern, isRegex, flags = "i", enabled, firstMsgOnly }) {
  const rules = await loadAutoBanRules();
  const rule = {
    id: randomUUID(),
    pattern,
    isRegex: Boolean(isRegex),
    flags: isRegex ? flags : "i",
    enabled: Boolean(enabled),
    firstMsgOnly: Boolean(firstMsgOnly),
    createdAt: new Date().toISOString()
  };
  rules.push(rule);
  await saveAutoBanRules(rules);
  return rule;
}

export async function updateAutoBanRule(id, updates) {
  const rules = await loadAutoBanRules();
  const index = rules.findIndex((r) => r.id === id);
  if (index === -1) return null;

  const allowed = ["pattern", "isRegex", "flags", "enabled", "firstMsgOnly"];
  for (const key of allowed) {
    if (key in updates) {
      rules[index][key] = updates[key];
    }
  }
  await saveAutoBanRules(rules);
  return rules[index];
}

export async function removeAutoBanRule(id) {
  const rules = await loadAutoBanRules();
  const filtered = rules.filter((r) => r.id !== id);
  if (filtered.length === rules.length) return false;
  await saveAutoBanRules(filtered);
  return true;
}
