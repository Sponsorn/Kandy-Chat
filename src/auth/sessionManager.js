import crypto from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * Session manager for dashboard authentication
 *
 * Sessions are kept in memory and mirrored to data/sessions.json so a bot
 * restart does not log everyone out. A session expires after SESSION_MAX_AGE
 * of inactivity (rolling): each visit extends it and re-issues the cookie.
 */

// In-memory session store, loaded from disk on first use
const sessions = new Map();
let sessionsLoaded = false;
let storePath = join(process.cwd(), "data", "sessions.json");
let saveTimer = null;

// Session cleanup interval (every 15 minutes)
const SESSION_CLEANUP_INTERVAL = 15 * 60 * 1000;
// Session idle lifetime (30 days, rolling)
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
// Persist / re-issue the cookie only when lastAccess moved at least this much
const TOUCH_GRANULARITY = 60 * 60 * 1000;
// Coalesce writes
const SAVE_DEBOUNCE_MS = 1000;

/**
 * Point the session store at another file (tests) and drop in-memory state.
 */
export function configureSessionStore({ path } = {}) {
  if (path) storePath = path;
  sessions.clear();
  sessionsLoaded = false;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

function isExpired(session, now = Date.now()) {
  const last = session.lastAccess || session.createdAt || 0;
  return now - last > SESSION_MAX_AGE;
}

function ensureLoaded() {
  if (sessionsLoaded) return;
  sessionsLoaded = true;
  if (!existsSync(storePath)) return;
  try {
    const data = JSON.parse(readFileSync(storePath, "utf8"));
    const now = Date.now();
    let restored = 0;
    for (const session of Array.isArray(data) ? data : []) {
      if (!session?.id || !session.user || isExpired(session, now)) continue;
      sessions.set(session.id, session);
      restored++;
    }
    if (restored > 0) console.log(`Restored ${restored} dashboard session(s)`);
  } catch (error) {
    console.error("Failed to load sessions, starting empty:", error.message);
  }
}

function saveNow() {
  saveTimer = null;
  try {
    mkdirSync(dirname(storePath), { recursive: true });
    const tmp = `${storePath}.tmp`;
    writeFileSync(tmp, JSON.stringify([...sessions.values()]), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, storePath);
  } catch (error) {
    console.error("Failed to save sessions:", error.message);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  if (typeof saveTimer.unref === "function") saveTimer.unref();
}

/**
 * Write pending session changes immediately (used on shutdown and in tests).
 */
export function flushSessions() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveNow();
  }
}

// Permission levels
export const Permissions = {
  VIEWER: 0, // Read-only access
  MODERATOR: 1, // Mod actions, view logs
  ADMIN: 2 // Full config, restart/stop
};

/**
 * Generate a secure session ID
 */
function generateSessionId() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Create a new session
 */
export function createSession(userData) {
  const sessionId = generateSessionId();
  const session = {
    id: sessionId,
    user: userData,
    permission: Permissions.VIEWER,
    createdAt: Date.now(),
    lastAccess: Date.now()
  };
  ensureLoaded();
  sessions.set(sessionId, session);
  scheduleSave();
  return sessionId;
}

/**
 * Get session by ID
 */
export function getSession(sessionId) {
  if (!sessionId) return null;

  ensureLoaded();
  const session = sessions.get(sessionId);
  if (!session) return null;

  const now = Date.now();
  if (isExpired(session, now)) {
    sessions.delete(sessionId);
    scheduleSave();
    return null;
  }

  // Rolling expiry: extend on activity, but only persist once per hour
  if (now - (session.lastAccess || 0) >= TOUCH_GRANULARITY) {
    session.lastAccess = now;
    session.touched = true;
    scheduleSave();
  }
  return session;
}

/**
 * Update session data
 */
export function updateSession(sessionId, updates) {
  const session = getSession(sessionId);
  if (!session) return null;

  Object.assign(session, updates);
  scheduleSave();
  return session;
}

/**
 * Set session permission level
 */
export function setSessionPermission(sessionId, permission) {
  return updateSession(sessionId, { permission });
}

/**
 * Destroy a session
 */
export function destroySession(sessionId) {
  ensureLoaded();
  const removed = sessions.delete(sessionId);
  if (removed) scheduleSave();
  return removed;
}

/**
 * Check if session has minimum permission level
 */
export function hasPermission(sessionId, minLevel) {
  const session = getSession(sessionId);
  if (!session) return false;
  return session.permission >= minLevel;
}

/**
 * Determine permission level from Discord roles
 * @param {Object} userData - User data with roles array
 * @param {string[]} adminRoleIds - Parsed array of admin role IDs
 * @param {string[]} modRoleIds - Parsed array of mod role IDs
 */
export function determineDiscordPermission(userData, adminRoleIds, modRoleIds) {
  if (!userData?.roles?.length) return Permissions.VIEWER;

  const userRoles = new Set(userData.roles);

  // Check admin roles
  if (adminRoleIds?.length && adminRoleIds.some((id) => userRoles.has(id))) {
    return Permissions.ADMIN;
  }

  // Check mod roles
  if (modRoleIds?.length && modRoleIds.some((id) => userRoles.has(id))) {
    return Permissions.MODERATOR;
  }

  return Permissions.VIEWER;
}

/**
 * Determine permission level from Twitch moderator/broadcaster status
 * @param {Object} userData - User data with username
 * @param {Array} modChannels - Array of channels where user is mod
 * @param {Array} configChannels - Array of configured channels
 */
export function determineTwitchPermission(userData, modChannels, configChannels) {
  if (!configChannels?.length) return Permissions.VIEWER;

  const username = userData?.username?.toLowerCase();
  const configSet = new Set(configChannels.map((c) => c.toLowerCase()));

  // Broadcaster (channel owner) gets ADMIN
  if (username && configSet.has(username)) {
    return Permissions.ADMIN;
  }

  // Moderator in configured channel gets MODERATOR
  if (modChannels?.length) {
    const modSet = new Set(modChannels.map((c) => c.toLowerCase()));
    const isModInConfigChannel = configChannels.some((c) => modSet.has(c.toLowerCase()));
    if (isModInConfigChannel) {
      return Permissions.MODERATOR;
    }
  }

  return Permissions.VIEWER;
}

/**
 * Parse session ID from cookie header
 */
export function parseSessionCookie(cookieHeader, cookieName = "session") {
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";").reduce((acc, cookie) => {
    const [name, ...valueParts] = cookie.trim().split("=");
    acc[name] = valueParts.join("=");
    return acc;
  }, {});

  return cookies[cookieName] || null;
}

/**
 * Create session cookie string
 */
export function createSessionCookie(sessionId, options = {}) {
  const {
    cookieName = "session",
    domain = null,
    secure = true,
    httpOnly = true,
    sameSite = "Strict",
    maxAge = SESSION_MAX_AGE
  } = options;

  let cookie = `${cookieName}=${sessionId}; Path=/; Max-Age=${Math.floor(maxAge / 1000)}`;

  if (domain) cookie += `; Domain=${domain}`;
  if (secure) cookie += "; Secure";
  if (httpOnly) cookie += "; HttpOnly";
  if (sameSite) cookie += `; SameSite=${sameSite}`;

  return cookie;
}

/**
 * Create logout cookie (clears session)
 */
export function createLogoutCookie(cookieName = "session") {
  return `${cookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

/**
 * Express middleware for session handling
 */
export function sessionMiddleware(options = {}) {
  const { cookieName = "session", domain = null, secure = true } = options;

  return (req, res, next) => {
    const sessionId = parseSessionCookie(req.headers.cookie, cookieName);
    req.session = getSession(sessionId);
    req.sessionId = sessionId;

    // Re-issue the cookie when the session was just extended so the browser's
    // expiry rolls forward with the server's
    if (req.session?.touched) {
      req.session.touched = false;
      res.setHeader("Set-Cookie", createSessionCookie(sessionId, { cookieName, domain, secure }));
    }
    next();
  };
}

/**
 * Express middleware to require authentication
 */
export function requireAuth(minPermission = Permissions.VIEWER) {
  return (req, res, next) => {
    if (!req.session) {
      return res.status(401).json({ error: "Authentication required" });
    }

    if (req.session.permission < minPermission) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    next();
  };
}

/**
 * Start session cleanup interval
 */
export function startSessionCleanup() {
  ensureLoaded();
  const timer = setInterval(() => {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, session] of sessions.entries()) {
      if (isExpired(session, now)) {
        sessions.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`Cleaned ${cleaned} expired sessions`);
      scheduleSave();
    }
  }, SESSION_CLEANUP_INTERVAL);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

/**
 * Get session stats (for debugging/monitoring)
 */
export function getSessionStats() {
  ensureLoaded();
  return {
    totalSessions: sessions.size,
    byPermission: {
      viewer: [...sessions.values()].filter((s) => s.permission === Permissions.VIEWER).length,
      moderator: [...sessions.values()].filter((s) => s.permission === Permissions.MODERATOR)
        .length,
      admin: [...sessions.values()].filter((s) => s.permission === Permissions.ADMIN).length
    }
  };
}
