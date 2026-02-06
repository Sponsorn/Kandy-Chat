import crypto from "node:crypto";
import {
  createSession,
  setSessionPermission,
  destroySession,
  determineDiscordPermission,
  createSessionCookie,
  Permissions
} from "./sessionManager.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_OAUTH_AUTHORIZE = "https://discord.com/oauth2/authorize";
const DISCORD_OAUTH_TOKEN = `${DISCORD_API_BASE}/oauth2/token`;

/**
 * Build Discord CDN avatar URL from user data
 * @param {string} userId - Discord user ID
 * @param {string|null} avatarHash - Avatar hash from Discord API
 * @returns {string} Complete CDN URL for the avatar
 */
function buildAvatarUrl(userId, avatarHash) {
  if (!avatarHash) {
    // Default avatar based on user ID (Discord's new default avatar system)
    const defaultIndex = (BigInt(userId) >> 22n) % 6n;
    return `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
  }

  const format = avatarHash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${format}`;
}

// State store for CSRF protection
const pendingStates = new Map();
const STATE_TIMEOUT = 10 * 60 * 1000; // 10 minutes

/**
 * Generate OAuth state for CSRF protection
 */
function generateState() {
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.set(state, Date.now());

  // Cleanup old states
  const now = Date.now();
  for (const [s, time] of pendingStates.entries()) {
    if (now - time > STATE_TIMEOUT) {
      pendingStates.delete(s);
    }
  }

  return state;
}

/**
 * Validate and consume OAuth state
 */
function validateState(state) {
  if (!pendingStates.has(state)) return false;
  pendingStates.delete(state);
  return true;
}

/**
 * Build Discord OAuth authorization URL
 */
export function buildAuthUrl(config) {
  const { clientId, redirectUri, guildId } = config;

  const state = generateState();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "identify guilds.members.read",
    state
  });

  // Add guild_id to pre-select guild in consent screen
  if (guildId) {
    params.append("guild_id", guildId);
  }

  return `${DISCORD_OAUTH_AUTHORIZE}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens
 */
async function exchangeCode(code, config) {
  const { clientId, clientSecret, redirectUri } = config;

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri
  });

  const response = await fetch(DISCORD_OAUTH_TOKEN, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Discord token exchange failed: ${response.status} ${error}`);
  }

  return response.json();
}

/**
 * Get user info from Discord
 */
async function getUser(accessToken) {
  const response = await fetch(`${DISCORD_API_BASE}/users/@me`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to get Discord user: ${response.status}`);
  }

  return response.json();
}

/**
 * Get user's roles in a specific guild
 */
async function getGuildMember(accessToken, guildId) {
  const response = await fetch(`${DISCORD_API_BASE}/users/@me/guilds/${guildId}/member`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    // User might not be in guild
    if (response.status === 404) {
      return null;
    }
    throw new Error(`Failed to get guild member: ${response.status}`);
  }

  return response.json();
}

/**
 * Create Discord OAuth routes
 */
export function createDiscordAuthRoutes(router, config) {
  const {
    clientId,
    clientSecret,
    redirectUri,
    guildId,
    adminRoleIds,
    modRoleIds,
    dashboardDomain,
    cookieSecure = true
  } = config;

  // Initiate Discord OAuth
  router.get("/auth/discord", (req, res) => {
    const authUrl = buildAuthUrl({
      clientId,
      redirectUri,
      guildId
    });
    res.redirect(authUrl);
  });

  // OAuth callback
  router.get("/auth/discord/callback", async (req, res) => {
    const { code, state, error } = req.query;

    // Handle OAuth errors
    if (error) {
      console.warn("Discord OAuth error:", error);
      return res.redirect("/?error=discord_denied");
    }

    // Validate state
    if (!validateState(state)) {
      return res.redirect("/?error=invalid_state");
    }

    if (!code) {
      return res.redirect("/?error=no_code");
    }

    try {
      // Exchange code for tokens
      const tokens = await exchangeCode(code, {
        clientId,
        clientSecret,
        redirectUri
      });

      // Get user info
      const user = await getUser(tokens.access_token);

      // Get guild member info for roles
      let roles = [];
      if (guildId) {
        const member = await getGuildMember(tokens.access_token, guildId);
        if (member) {
          roles = member.roles || [];
        }
      }

      // Create session
      const userData = {
        provider: "discord",
        id: user.id,
        username: user.username,
        discriminator: user.discriminator,
        avatar: buildAvatarUrl(user.id, user.avatar),
        roles,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000
      };

      const sessionId = createSession(userData);

      // Determine permission level
      const permission = determineDiscordPermission(userData, adminRoleIds, modRoleIds);

      // Reject users without at least MODERATOR permission
      if (permission < Permissions.MODERATOR) {
        destroySession(sessionId);
        return res.redirect("/?error=access_denied");
      }

      setSessionPermission(sessionId, permission);

      // Set session cookie
      const cookie = createSessionCookie(sessionId, {
        domain: dashboardDomain,
        secure: cookieSecure
      });
      res.setHeader("Set-Cookie", cookie);

      // Redirect to dashboard
      res.redirect("/");
    } catch (err) {
      console.error("Discord OAuth callback error:", err);
      res.redirect("/?error=auth_failed");
    }
  });

  return router;
}

export { getUser, getGuildMember };
