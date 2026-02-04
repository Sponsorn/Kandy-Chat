import crypto from "node:crypto";

/**
 * Session manager for dashboard authentication
 * Uses in-memory sessions with secure cookie handling
 */

// In-memory session store
const sessions = new Map();

// Session cleanup interval (every 15 minutes)
const SESSION_CLEANUP_INTERVAL = 15 * 60 * 1000;
// Session max age (24 hours)
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000;

// Permission levels
export const Permissions = {
  VIEWER: 0,      // Read-only access
  MODERATOR: 1,   // Mod actions, view logs
  ADMIN: 2        // Full config, restart/stop
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
  sessions.set(sessionId, session);
  return sessionId;
}

/**
 * Get session by ID
 */
export function getSession(sessionId) {
  if (!sessionId) return null;

  const session = sessions.get(sessionId);
  if (!session) return null;

  // Check if session expired
  if (Date.now() - session.createdAt > SESSION_MAX_AGE) {
    sessions.delete(sessionId);
    return null;
  }

  // Update last access time
  session.lastAccess = Date.now();
  return session;
}

/**
 * Update session data
 */
export function updateSession(sessionId, updates) {
  const session = getSession(sessionId);
  if (!session) return null;

  Object.assign(session, updates);
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
  return sessions.delete(sessionId);
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
 * @param {string} adminRoleIds - Comma-separated admin role IDs
 * @param {string} modRoleIds - Comma-separated mod role IDs
 */
export function determineDiscordPermission(userData, adminRoleIds, modRoleIds) {
  if (!userData?.roles?.length) return Permissions.VIEWER;

  const userRoles = new Set(userData.roles);

  // Check admin roles
  if (adminRoleIds) {
    const adminIds = adminRoleIds.split(",").map(id => id.trim()).filter(Boolean);
    if (adminIds.some(id => userRoles.has(id))) {
      return Permissions.ADMIN;
    }
  }

  // Check mod roles
  if (modRoleIds) {
    const modIds = modRoleIds.split(",").map(id => id.trim()).filter(Boolean);
    if (modIds.some(id => userRoles.has(id))) {
      return Permissions.MODERATOR;
    }
  }

  return Permissions.VIEWER;
}

/**
 * Determine permission level from Twitch moderator status
 * @param {Object} userData - User data
 * @param {Array} modChannels - Array of channels where user is mod
 * @param {Array} configChannels - Array of configured channels
 */
export function determineTwitchPermission(userData, modChannels, configChannels) {
  if (!modChannels?.length || !configChannels?.length) return Permissions.VIEWER;

  const modSet = new Set(modChannels.map(c => c.toLowerCase()));
  const isModInConfigChannel = configChannels.some(c => modSet.has(c.toLowerCase()));

  if (isModInConfigChannel) {
    return Permissions.MODERATOR;
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
  const { cookieName = "session" } = options;

  return (req, res, next) => {
    const sessionId = parseSessionCookie(req.headers.cookie, cookieName);
    req.session = getSession(sessionId);
    req.sessionId = sessionId;
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
  setInterval(() => {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, session] of sessions.entries()) {
      if (now - session.createdAt > SESSION_MAX_AGE) {
        sessions.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`Cleaned ${cleaned} expired sessions`);
    }
  }, SESSION_CLEANUP_INTERVAL);
}

/**
 * Get session stats (for debugging/monitoring)
 */
export function getSessionStats() {
  return {
    totalSessions: sessions.size,
    byPermission: {
      viewer: [...sessions.values()].filter(s => s.permission === Permissions.VIEWER).length,
      moderator: [...sessions.values()].filter(s => s.permission === Permissions.MODERATOR).length,
      admin: [...sessions.values()].filter(s => s.permission === Permissions.ADMIN).length
    }
  };
}
