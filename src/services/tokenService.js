import { promises as fs } from "node:fs";
import { join } from "node:path";
import { refreshTwitchToken } from "../twitchAuth.js";
import botState from "../state/BotState.js";

let tokenRefreshTimeout = null;

/**
 * Persist refresh token to .env file
 */
async function persistRefreshToken(refreshToken) {
  const envPath = join(process.cwd(), ".env");
  let content;
  try {
    content = await fs.readFile(envPath, "utf8");
  } catch (error) {
    console.warn("Failed to read .env for refresh token update", error);
    return;
  }

  const line = `TWITCH_REFRESH_TOKEN=${refreshToken}`;
  if (content.includes("TWITCH_REFRESH_TOKEN=")) {
    const updated = content.replace(/^TWITCH_REFRESH_TOKEN=.*$/m, line);
    if (updated !== content) {
      await fs.writeFile(envPath, updated, "utf8");
    }
    return;
  }

  await fs.writeFile(envPath, `${content}\n${line}\n`, "utf8");
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
    persistRefreshToken(refreshed.refreshToken).catch(error => {
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
