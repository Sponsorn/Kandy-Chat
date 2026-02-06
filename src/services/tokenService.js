import { promises as fs } from "node:fs";
import { join } from "node:path";
import { refreshTwitchToken } from "../twitchAuth.js";
import botState from "../state/BotState.js";

let tokenRefreshTimeout = null;

const TOKENS_PATH = join(process.cwd(), "data", "tokens.json");

/**
 * Persist refresh token to data/tokens.json
 */
async function persistRefreshToken(refreshToken) {
  const data = {
    refreshToken,
    updatedAt: new Date().toISOString()
  };
  await fs.mkdir(join(process.cwd(), "data"), { recursive: true });
  await fs.writeFile(TOKENS_PATH, JSON.stringify(data, null, 2), "utf8");
}

/**
 * Load persisted refresh token from data/tokens.json
 * @returns {Promise<string|null>} The persisted refresh token, or null if not found
 */
export async function loadPersistedRefreshToken() {
  try {
    const content = await fs.readFile(TOKENS_PATH, "utf8");
    const data = JSON.parse(content);
    return data.refreshToken || null;
  } catch {
    return null;
  }
}

/**
 * Refresh Twitch token and update state
 * @param {Object} credentials - Client credentials
 * @returns {Promise<{oauthToken: string, expiresIn: number}|null>}
 */
export async function refreshAndApplyTwitchToken(credentials) {
  const { clientId, clientSecret } = credentials;
  const refreshToken = botState.currentRefreshToken;

  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }

  const previousRefreshToken = refreshToken;
  const refreshed = await refreshTwitchToken({
    clientId,
    clientSecret,
    refreshToken
  });

  const oauthToken = `oauth:${refreshed.accessToken}`;

  botState.updateTokens({
    oauthToken,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken
  });

  if (refreshed.refreshToken !== previousRefreshToken) {
    persistRefreshToken(refreshed.refreshToken).catch((error) => {
      console.warn("Failed to persist Twitch refresh token", error);
    });
  }

  return {
    oauthToken,
    expiresIn: refreshed.expiresIn
  };
}

/**
 * Schedule automatic token refresh
 * @param {number} expiresInSeconds - Token expiration time
 * @param {Object} credentials - Client credentials
 * @param {Function} onRefresh - Callback when token is refreshed
 */
export function scheduleTokenRefresh(expiresInSeconds, credentials, onRefresh) {
  if (!expiresInSeconds) return;

  // Clear any existing timeout to prevent stacking
  if (tokenRefreshTimeout) {
    clearTimeout(tokenRefreshTimeout);
  }

  const refreshIn = Math.max(60, Math.floor(expiresInSeconds * 0.8));
  tokenRefreshTimeout = setTimeout(async () => {
    try {
      const tokenInfo = await refreshAndApplyTwitchToken(credentials);
      if (tokenInfo) {
        onRefresh?.(tokenInfo);
      }
      if (tokenInfo?.expiresIn) {
        scheduleTokenRefresh(tokenInfo.expiresIn, credentials, onRefresh);
      }
    } catch (error) {
      console.error("Failed to refresh Twitch token", error);
      scheduleTokenRefresh(Math.max(60, expiresInSeconds), credentials, onRefresh);
    }
  }, refreshIn * 1000);
}

/**
 * Cancel scheduled token refresh
 */
export function cancelTokenRefresh() {
  if (tokenRefreshTimeout) {
    clearTimeout(tokenRefreshTimeout);
    tokenRefreshTimeout = null;
  }
}

/**
 * Create a token provider function for API clients
 * @param {Object} credentials - Client credentials
 * @returns {Function} Async function that returns current access token
 */
export function createTokenProvider(credentials) {
  return async () => {
    // Try to use current access token first
    const currentToken = botState.getAccessToken();
    if (currentToken) return currentToken;

    // If no token, try to refresh
    const tokenInfo = await refreshAndApplyTwitchToken(credentials);
    return tokenInfo?.oauthToken?.replace("oauth:", "") ?? null;
  };
}
