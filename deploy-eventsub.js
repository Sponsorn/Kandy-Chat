import "dotenv/config";

const {
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  EVENTSUB_PUBLIC_URL,
  EVENTSUB_CALLBACK_PATH,
  EVENTSUB_SECRET,
  EVENTSUB_BROADCASTER
} = process.env;

if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
  throw new Error("Missing TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET");
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

async function getAppAccessToken() {
  const params = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    client_secret: TWITCH_CLIENT_SECRET,
    grant_type: "client_credentials"
  });

  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    body: params
  });

  if (!response.ok) {
    throw new Error(`Failed to get app access token: ${response.status}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function main() {
  const accessToken = await getAppAccessToken();

  // Support comma-separated list of broadcasters
  const broadcasters = EVENTSUB_BROADCASTER.split(",").map(b => b.trim()).filter(Boolean);

  for (const broadcaster of broadcasters) {
    console.log(`Setting up EventSub for ${broadcaster}...`);

    const users = await helixRequest(accessToken, `users?login=${encodeURIComponent(broadcaster)}`);
    const userId = users?.data?.[0]?.id;
    if (!userId) {
      console.error(`Unable to resolve broadcaster id for ${broadcaster}, skipping`);
      continue;
    }

    await createSubscription(accessToken, "stream.online", { broadcaster_user_id: userId });
    await createSubscription(accessToken, "stream.offline", { broadcaster_user_id: userId });

    console.log(`✓ EventSub subscriptions created for ${broadcaster} (ID: ${userId})`);
  }

  console.log("\nAll EventSub subscriptions created successfully");
}

main().catch((error) => {
  console.error("EventSub deploy failed", error);
  process.exit(1);
});
