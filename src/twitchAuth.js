const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";

async function refreshTwitchToken({ clientId, clientSecret, refreshToken }) {
  if (typeof fetch !== "function") {
    throw new Error("global fetch is not available (requires Node 18+)");
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret
  });

  const response = await fetch(TWITCH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  if (!response.ok) {
    throw new Error(`Twitch token refresh failed: ${response.status}`);
  }

  const data = await response.json();
  if (!data?.access_token) {
    throw new Error("Twitch token refresh response missing access_token");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresIn: data.expires_in ?? 0
  };
}

export { refreshTwitchToken };
