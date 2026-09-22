import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

/**
 * Persists the dashboard logs kept in BotState (bot console log, audit log, mod log)
 * so they survive a bot restart.
 *
 * Each log is mirrored to its own file under data/ with debounced atomic writes. BotState
 * stays the source of truth: this module hydrates it at startup and listens to the events
 * it already emits, so no call site has to change.
 */

const FILE_NAMES = {
  logBuffer: "bot-log.json",
  auditLog: "audit-log.json",
  modActions: "mod-log.json"
};

const EVENT_TO_LOG = {
  "bot:log": "logBuffer",
  "audit:event": "auditLog",
  "mod:action": "modActions"
};

// Bot log entries arrive on every console call, so coalesce them a bit longer
const SAVE_DEBOUNCE_MS = {
  logBuffer: 2000,
  auditLog: 500,
  modActions: 500
};

let storeDir = join(process.cwd(), "data");
const saveTimers = new Map(); // log key -> timeout
let attached = null; // { botState, listeners, exitHandler, signalHandler }

function filePath(key) {
  return join(storeDir, FILE_NAMES[key]);
}

function isEntry(entry) {
  return Boolean(entry) && typeof entry === "object" && typeof entry.timestamp === "number";
}

/**
 * Point the store at another directory (tests) and drop timers/listeners.
 */
export function configureLogStore({ dir } = {}) {
  detachLogPersistence();
  if (dir) storeDir = dir;
}

function readLog(key) {
  const path = filePath(key);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch (error) {
    console.error(`Failed to load ${FILE_NAMES[key]}, starting empty:`, error.message);
    return [];
  }
}

/**
 * Read every persisted log from disk.
 * @returns {{ logBuffer: Array, auditLog: Array, modActions: Array }}
 */
export function loadPersistedLogs() {
  return {
    logBuffer: readLog("logBuffer"),
    auditLog: readLog("auditLog"),
    modActions: readLog("modActions")
  };
}

function saveNow(key) {
  saveTimers.delete(key);
  if (!attached) return;
  try {
    mkdirSync(storeDir, { recursive: true });
    const path = filePath(key);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(attached.botState[key]), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    console.error(`Failed to save ${FILE_NAMES[key]}:`, error.message);
  }
}

function scheduleSave(key) {
  if (saveTimers.has(key)) return;
  const timer = setTimeout(() => saveNow(key), SAVE_DEBOUNCE_MS[key]);
  if (typeof timer.unref === "function") timer.unref();
  saveTimers.set(key, timer);
}

/**
 * Write every pending log immediately (used on shutdown and in tests).
 */
export function flushLogs() {
  for (const key of [...saveTimers.keys()]) {
    clearTimeout(saveTimers.get(key));
    saveNow(key);
  }
}

/**
 * Hydrate BotState from disk and keep the files in sync from now on.
 *
 * @param {import("./state/BotState.js").BotState} botState
 * @param {object} [options]
 * @param {boolean} [options.installShutdownHooks=true] - Flush on process exit and turn
 *   SIGTERM/SIGINT into a clean exit so the last entries (e.g. the restart itself) are kept
 * @returns {{ restored: { logBuffer: number, auditLog: number, modActions: number } }}
 */
export function attachLogPersistence(botState, { installShutdownHooks = true } = {}) {
  detachLogPersistence();

  const persisted = loadPersistedLogs();
  botState.hydrateLogs(persisted);

  const listeners = new Map();
  for (const [event, key] of Object.entries(EVENT_TO_LOG)) {
    const listener = () => scheduleSave(key);
    botState.on(event, listener);
    listeners.set(event, listener);
  }

  attached = { botState, listeners, exitHandler: null, signalHandler: null };

  if (installShutdownHooks) {
    attached.exitHandler = () => flushLogs();
    process.once("exit", attached.exitHandler);

    // Node's default SIGTERM/SIGINT handling terminates without running "exit" listeners
    attached.signalHandler = (signal) => {
      console.log(`Received ${signal}, shutting down`);
      process.exit(0);
    };
    process.on("SIGTERM", attached.signalHandler);
    process.on("SIGINT", attached.signalHandler);
  }

  return {
    restored: {
      logBuffer: persisted.logBuffer.length,
      auditLog: persisted.auditLog.length,
      modActions: persisted.modActions.length
    }
  };
}

/**
 * Stop mirroring (tests). Pending writes are dropped, call flushLogs() first to keep them.
 */
export function detachLogPersistence() {
  for (const timer of saveTimers.values()) clearTimeout(timer);
  saveTimers.clear();
  if (!attached) return;
  for (const [event, listener] of attached.listeners) {
    attached.botState.off(event, listener);
  }
  if (attached.exitHandler) process.off("exit", attached.exitHandler);
  if (attached.signalHandler) {
    process.off("SIGTERM", attached.signalHandler);
    process.off("SIGINT", attached.signalHandler);
  }
  attached = null;
}
