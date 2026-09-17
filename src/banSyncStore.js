import { promises as fs } from "node:fs";
import { join } from "node:path";

/**
 * Persists which bans the ban sync mirrored, so unbans in the source channel can be detected
 * (by polling Helix for exactly those users) and lifted in the targets, even across restarts.
 */
const storeDir = join(process.cwd(), "data");
const storePath = join(storeDir, "ban-sync-state.json");

/**
 * @returns {Promise<Array<{login: string, userId: string|null, source: string, targets: string[], mirroredAt: number}>>}
 */
export async function loadTrackedBans() {
  try {
    const data = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(data);
    return Array.isArray(parsed?.tracked) ? parsed.tracked : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    console.warn("Failed to parse ban sync state file:", error.message);
    return [];
  }
}

/**
 * @param {Array} tracked - Entries as returned by loadTrackedBans()
 */
export async function saveTrackedBans(tracked) {
  await fs.mkdir(storeDir, { recursive: true });
  const tmpPath = `${storePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify({ tracked }, null, 2), "utf8");
  await fs.rename(tmpPath, storePath);
}
