import crypto from "node:crypto";
import {
  createSession,
  setSessionPermission,
  destroySession,
  determineTwitchPermission,
  createSessionCookie,
  Permissions
} from "./sessionManager.js";

const TWITCH_OAUTH_AUTHORIZE = "https://id.twitch.tv/oauth2/authorize";
const TWITCH_OAUTH_TOKEN = "https://id.twitch.tv/oauth2/token";
const TWITCH_API_BASE = "https://api.twitch.tv/helix";

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
 * Build Twitch OAuth authorization URL
 */
export function buildAuthUrl(config) {
  const { clientId, redirectUri } = config;

  const state = generateState();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "user:read:email moderation:read",
    state
  });

  return `${TWITCH_OAUTH_AUTHORIZE}?${params.toString()}`;
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

  const response = await fetch(TWITCH_OAUTH_TOKEN, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Twitch token exchange failed: ${response.status} ${error}`);
  }

  return response.json();
}

/**
 * Get user info from Twitch
 */
async function getUser(accessToken, clientId) {
  const response = await fetch(`${TWITCH_API_BASE}/users`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Client-Id": clientId
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to get Twitch user: ${response.status}`);
  }

  const data = await response.json();
  return data.data?.[0] || null;
}

/**
 * Get channels where user is a moderator
 */
async function getModeratedChannels(accessToken, clientId, userId) {
  const channels = [];
  let cursor = null;

  do {
    const url = new URL(`${TWITCH_API_BASE}/moderation/channels`);
    url.searchParams.append("user_id", userId);
    url.searchParams.append("first", "100");
    if (cursor) {
      url.searchParams.append("after", cursor);
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Client-Id": clientId
      }
    });

    if (!response.ok) {
      // User might not have permission to check moderator status
      if (response.status === 401 || response.status === 403) {
        return channels;
      }
      throw new Error(`Failed to get moderated channels: ${response.status}`);
    }

    const data = await response.json();
    channels.push(...(data.data || []).map((c) => c.broadcaster_login));
    cursor = data.pagination?.cursor || null;
  } while (cursor);

  return channels;
}

/**
 * Create Twitch OAuth routes
 */
export function createTwitchAuthRoutes(router, config) {
  const {
    clientId,
    clientSecret,
    redirectUri,
    configuredChannels,
    dashboardDomain,
    cookieSecure = true
  } = config;

  // Initiate Twitch OAuth
  router.get("/auth/twitch", (req, res) => {
    const authUrl = buildAuthUrl({
      clientId,
      redirectUri
    });
    res.redirect(authUrl);
  });

  // OAuth callback
  router.get("/auth/twitch/callback", async (req, res) => {
    const { code, state, error, error_description } = req.query;

    // Handle OAuth errors
    if (error) {
      console.warn("Twitch OAuth error:", error, error_description);
      return res.redirect("/?error=twitch_denied");
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
      const user = await getUser(tokens.access_token, clientId);
      if (!user) {
        throw new Error("Failed to get user info");
      }

      // Get moderated channels
      let modChannels = [];
      try {
        modChannels = await getModeratedChannels(tokens.access_token, clientId, user.id);
      } catch (err) {
        console.warn("Could not fetch moderated channels:", err.message);
      }

      // Create session
      const userData = {
        provider: "twitch",
        id: user.id,
        username: user.login,
        displayName: user.display_name,
        avatar: user.profile_image_url,
        modChannels,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000
      };

      const sessionId = createSession(userData);

      // Determine permission level based on moderator status
      const permission = determineTwitchPermission(userData, modChannels, configuredChannels || []);

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
      console.error("Twitch OAuth callback error:", err);
      res.redirect("/?error=auth_failed");
    }
  });

  return router;
}

export { getUser, getModeratedChannels };
