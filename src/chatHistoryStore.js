import { promises as fs } from "node:fs";
import { join } from "node:path";

const baseDir = join(process.cwd(), "data", "chatHistory");

// In-memory buffer for batched writes
const writeBuffers = new Map(); // channel -> messages[]
const BATCH_INTERVAL_MS = 5000;
let batchTimer = null;

/**
 * Get the file path for a channel on a specific date
 * @param {string} channel - Channel name (lowercase, no # prefix)
 * @param {Date} date - Date for the file
 * @returns {string} Full path to the JSON file
 */
function getFilePath(channel, date = new Date()) {
  const dateStr = date.toISOString().split("T")[0]; // YYYY-MM-DD
  return join(baseDir, channel.toLowerCase(), `${dateStr}.json`);
}

/**
 * Ensure the directory exists for a channel
 * @param {string} channel - Channel name
 */
async function ensureChannelDir(channel) {
  const dir = join(baseDir, channel.toLowerCase());
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Flush buffered messages to disk for a specific channel
 * @param {string} channel - Channel name
 */
async function flushChannel(channel) {
  const buffer = writeBuffers.get(channel);
  if (!buffer || buffer.length === 0) return;

  // Group messages by date
  const byDate = new Map();
  for (const msg of buffer) {
    const date = new Date(msg.timestamp);
    const dateStr = date.toISOString().split("T")[0];
    if (!byDate.has(dateStr)) {
      byDate.set(dateStr, []);
    }
    byDate.get(dateStr).push(msg);
  }

  // Clear buffer before async operations
  writeBuffers.set(channel, []);

  await ensureChannelDir(channel);

  // Write to each date file
  for (const [dateStr, messages] of byDate) {
    const filePath = join(baseDir, channel.toLowerCase(), `${dateStr}.json`);

    // Read existing data
    let existing = [];
    try {
      const data = await fs.readFile(filePath, "utf8");
      existing = JSON.parse(data);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`Failed to read chat history file ${filePath}:`, error.message);
      }
    }

    // Append new messages
    const combined = [...existing, ...messages];
    await fs.writeFile(filePath, JSON.stringify(combined, null, 2), "utf8");
  }
}

/**
 * Flush all channels to disk
 */
async function flushAll() {
  const channels = Array.from(writeBuffers.keys());
  await Promise.all(channels.map(flushChannel));
}

/**
 * Start the batch write timer
 */
function startBatchTimer() {
  if (batchTimer) return;
  batchTimer = setInterval(async () => {
    try {
      await flushAll();
    } catch (error) {
      console.error("Failed to flush chat history:", error);
    }
  }, BATCH_INTERVAL_MS);
}

/**
 * Save a message to the chat history
 * @param {string} channel - Channel name (lowercase, no # prefix)
 * @param {Object} messageData - Message data object
 */
function saveMessage(channel, messageData) {
  const normalizedChannel = channel.toLowerCase().replace(/^#/, "");

  if (!writeBuffers.has(normalizedChannel)) {
    writeBuffers.set(normalizedChannel, []);
  }

  writeBuffers.get(normalizedChannel).push(messageData);
  startBatchTimer();
}

/**
 * Load messages from chat history
 * @param {string} channel - Channel name
 * @param {number} sinceTimestamp - Load messages since this timestamp (optional)
 * @param {number} limit - Maximum messages to return
 * @returns {Promise<Array>} Array of message objects
 */
async function loadMessages(channel, sinceTimestamp = 0, limit = 500) {
  const normalizedChannel = channel.toLowerCase().replace(/^#/, "");
  const channelDir = join(baseDir, normalizedChannel);

  // Get list of files
  let files;
  try {
    files = await fs.readdir(channelDir);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  // Filter to JSON files and sort by date (newest first for recent messages)
  const jsonFiles = files
    .filter(f => f.endsWith(".json"))
    .sort()
    .reverse();

  const messages = [];

  // Read files until we have enough messages
  for (const file of jsonFiles) {
    if (messages.length >= limit) break;

    const filePath = join(channelDir, file);
    try {
      const data = await fs.readFile(filePath, "utf8");
      const fileMessages = JSON.parse(data);

      // Filter by timestamp and add to results
      for (const msg of fileMessages) {
        if (msg.timestamp >= sinceTimestamp) {
          messages.push(msg);
        }
      }
    } catch (error) {
      console.warn(`Failed to read chat history file ${filePath}:`, error.message);
    }
  }

  // Sort by timestamp descending and limit
  messages.sort((a, b) => b.timestamp - a.timestamp);
  return messages.slice(0, limit);
}

/**
 * Clean up old chat history files
 * @param {number} retentionDays - Number of days to keep (default: 3)
 */
async function cleanupOldFiles(retentionDays = 3) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffStr = cutoffDate.toISOString().split("T")[0];

  let totalDeleted = 0;

  try {
    const channels = await fs.readdir(baseDir);

    for (const channel of channels) {
      const channelDir = join(baseDir, channel);
      const stat = await fs.stat(channelDir);
      if (!stat.isDirectory()) continue;

      const files = await fs.readdir(channelDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;

        // Extract date from filename (YYYY-MM-DD.json)
        const dateStr = file.replace(".json", "");
        if (dateStr < cutoffStr) {
          const filePath = join(channelDir, file);
          await fs.unlink(filePath);
          totalDeleted++;
          console.log(`Deleted old chat history file: ${filePath}`);
        }
      }

      // Remove empty channel directories
      const remaining = await fs.readdir(channelDir);
      if (remaining.length === 0) {
        await fs.rmdir(channelDir);
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Failed to cleanup chat history:", error);
    }
  }

  if (totalDeleted > 0) {
    console.log(`Chat history cleanup: deleted ${totalDeleted} files older than ${retentionDays} days`);
  }
}

/**
 * Schedule daily cleanup at 3 AM
 * @param {number} retentionDays - Number of days to keep
 */
function scheduleCleanup(retentionDays = 3) {
  // Run cleanup immediately on start
  cleanupOldFiles(retentionDays).catch(err => {
    console.error("Initial chat history cleanup failed:", err);
  });

  // Calculate ms until 3 AM
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(3, 0, 0, 0);
  if (nextRun <= now) {
    nextRun.setDate(nextRun.getDate() + 1);
  }

  const msUntilNextRun = nextRun.getTime() - now.getTime();

  // Schedule first run, then repeat daily
  setTimeout(() => {
    cleanupOldFiles(retentionDays).catch(err => {
      console.error("Chat history cleanup failed:", err);
    });

    // Run daily at 3 AM
    setInterval(() => {
      cleanupOldFiles(retentionDays).catch(err => {
        console.error("Chat history cleanup failed:", err);
      });
    }, 24 * 60 * 60 * 1000);
  }, msUntilNextRun);

  console.log(`Chat history cleanup scheduled for 3 AM daily (next run in ${Math.round(msUntilNextRun / 1000 / 60)} minutes)`);
}

/**
 * Mark a message as relayed in the buffer (before it's flushed to disk)
 * @param {string} messageId - Message ID to mark
 */
function markMessageRelayed(messageId) {
  for (const buffer of writeBuffers.values()) {
    for (const msg of buffer) {
      if (msg.id === messageId) {
        msg.relayed = true;
        return true;
      }
    }
  }
  return false;
}

export {
  saveMessage,
  loadMessages,
  cleanupOldFiles,
  scheduleCleanup,
  flushAll,
  markMessageRelayed
};
