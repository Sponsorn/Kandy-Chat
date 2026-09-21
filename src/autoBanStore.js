import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const storeDir = join(process.cwd(), "data");
const storePath = join(storeDir, "auto-ban-rules.json");

const VALID_REGEX_FLAGS = new Set(["d", "g", "i", "m", "s", "u", "v", "y"]);

/**
 * Accept a regex typed as `/pattern/flags` (JavaScript literal syntax) and
 * split it into the bare pattern and its flags. Patterns without delimiters
 * are returned unchanged. Flags are deduplicated and limited to valid JS
 * regex flags; when none remain, "i" is used.
 * @param {string} pattern
 * @param {string} [flags]
 * @returns {{ pattern: string, flags: string }}
 */
export function parseRegexInput(pattern, flags = "i") {
  let body = typeof pattern === "string" ? pattern.trim() : "";
  let flagSource = typeof flags === "string" ? flags : "";

  const literal = /^\/(.+)\/([a-z]*)$/s.exec(body);
  if (literal) {
    body = literal[1];
    flagSource = literal[2] || flagSource;
  }

  const seen = new Set();
  for (const flag of flagSource) {
    if (VALID_REGEX_FLAGS.has(flag)) seen.add(flag);
  }
  const normalizedFlags = seen.size ? [...seen].join("") : "i";

  return { pattern: body, flags: normalizedFlags };
}

/**
 * Normalize a stored rule: regex rules that still carry `/.../flags`
 * delimiters (saved before delimiters were stripped) are unwrapped.
 * @param {Object} rule
 * @returns {Object}
 */
export function normalizeAutoBanRule(rule) {
  if (!rule || !rule.isRegex || typeof rule.pattern !== "string") return rule;
  const parsed = parseRegexInput(rule.pattern, rule.flags);
  if (parsed.pattern === rule.pattern && parsed.flags === (rule.flags || "i")) return rule;
  return { ...rule, pattern: parsed.pattern, flags: parsed.flags };
}

export async function loadAutoBanRules() {
  try {
    const data = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(data);
    return Array.isArray(parsed?.rules) ? parsed.rules.map(normalizeAutoBanRule) : [];
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
  const parsed = isRegex ? parseRegexInput(pattern, flags) : { pattern, flags: "i" };
  const rule = {
    id: randomUUID(),
    pattern: parsed.pattern,
    isRegex: Boolean(isRegex),
    flags: parsed.flags,
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
  rules[index] = normalizeAutoBanRule(rules[index]);
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
