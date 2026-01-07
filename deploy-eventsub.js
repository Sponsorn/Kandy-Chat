import "dotenv/config";
import { refreshTwitchToken } from "./src/twitchAuth.js";

const {
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_REFRESH_TOKEN,
  EVENTSUB_PUBLIC_URL,
  EVENTSUB_CALLBACK_PATH,
  EVENTSUB_SECRET,
  EVENTSUB_BROADCASTER
} = process.env;

if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET || !TWITCH_REFRESH_TOKEN) {
  throw new Error("Missing TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, or TWITCH_REFRESH_TOKEN");
}

if (!EVENTSUB_PUBLIC_URL || !EVENTSUB_SECRET) {
  throw new Error("Missing EVENTSUB_PUBLIC_URL or EVENTSUB_SECRET");
}

if (!EVENTSUB_BROADCASTER) {
  throw new Error("Missing EVENTSUB_BROADCASTER (channel name)");
}

const callbackPath = EVENTSUB_CALLBACK_PATH || "/eventsub";
const callbackUrl = `${EVENTSUB_PUBLIC_URL.replace(/\/$/, "")}${callbackPath}`;

async function helixRequest(accessToken, path) {
  const response = await fetch(`https://api.twitch.tv/helix/${path}`, {
    headers: {
      "Client-ID": TWITCH_CLIENT_ID,
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!response.ok) {
    throw new Error(`Helix request failed: ${response.status}`);
  }
  return response.json();
}

async function createSubscription(accessToken, type, condition) {
  const body = {
    type,
    version: "1",
    condition,
    transport: {
      method: "webhook",
      callback: callbackUrl,
      secret: EVENTSUB_SECRET
    }
  };

  const response = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
    method: "POST",
    headers: {
      "Client-ID": TWITCH_CLIENT_ID,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`EventSub create failed: ${response.status} ${text}`);
  }
}

async function main() {
  const refreshed = await refreshTwitchToken({
    clientId: TWITCH_CLIENT_ID,
    clientSecret: TWITCH_CLIENT_SECRET,
    refreshToken: TWITCH_REFRESH_TOKEN
  });

  const accessToken = refreshed.accessToken;
  const users = await helixRequest(accessToken, `users?login=${encodeURIComponent(EVENTSUB_BROADCASTER)}`);
  const userId = users?.data?.[0]?.id;
  if (!userId) {
    throw new Error("Unable to resolve broadcaster id");
  }

  await createSubscription(accessToken, "stream.online", { broadcaster_user_id: userId });
  await createSubscription(accessToken, "stream.offline", { broadcaster_user_id: userId });

  console.log("EventSub subscriptions created");
}

main().catch((error) => {
  console.error("EventSub deploy failed", error);
  process.exit(1);
});
