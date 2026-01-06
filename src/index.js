import "dotenv/config";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import tmi from "tmi.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  buildFilters,
  normalizeMessage,
  shouldBlockMessage
} from "./filters.js";
import { startFreezeMonitor } from "./freezeMonitor.js";
import { refreshTwitchToken } from "./twitchAuth.js";

const {
  DISCORD_TOKEN,
  DISCORD_CHANNEL_ID,
  TWITCH_USERNAME,
  TWITCH_OAUTH,
  TWITCH_CHANNEL,
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_REFRESH_TOKEN,
  FREEZE_ALERT_ROLE_ID
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_CHANNEL_ID) {
  throw new Error("Missing DISCORD_TOKEN or DISCORD_CHANNEL_ID in environment");
}

if (!TWITCH_USERNAME || !TWITCH_CHANNEL) {
  throw new Error("Missing TWITCH_USERNAME or TWITCH_CHANNEL in environment");
}

if (!TWITCH_OAUTH && !(TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET && TWITCH_REFRESH_TOKEN)) {
  throw new Error("Missing TWITCH_OAUTH or refresh credentials in environment");
}

const filters = buildFilters(process.env);

const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

let twitchClient = null;
let currentRefreshToken = TWITCH_REFRESH_TOKEN;
let freezeAuthManaged = false;

function createTwitchClient(oauthToken) {
  return new tmi.Client({
    options: { debug: false },
    identity: {
      username: TWITCH_USERNAME,
      password: oauthToken
    },
    channels: [TWITCH_CHANNEL]
  });
}

let discordChannel = null;

discordClient.once("clientReady", async () => {
  try {
    discordChannel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID);
  } catch (error) {
    console.error("Failed to fetch Discord channel on startup", error);
  }
  console.log(`Discord connected as ${discordClient.user?.tag ?? "unknown"}`);
});

function attachTwitchHandlers(client) {
  client.on("message", handleTwitchMessage);
  client.on("connected", (address, port) => {
    console.log(`Twitch connected to ${address}:${port}`);
  });
  client.on("disconnected", (reason) => {
    console.warn(`Twitch disconnected: ${reason}`);
  });
}

async function connectTwitch(oauthToken) {
  if (twitchClient) {
    try {
      await twitchClient.disconnect();
    } catch {
      // ignore disconnect errors
    }
  }
  twitchClient = createTwitchClient(oauthToken);
  attachTwitchHandlers(twitchClient);
  await twitchClient.connect();
}

function formatRelayMessage(username, message) {
  const timestamp = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date());
  return `[${timestamp}] **${username}**: ${message}`;
}

async function relayToDiscord(username, message) {
  const channel =
    discordChannel ?? (await discordClient.channels.fetch(DISCORD_CHANNEL_ID));
  if (!channel || !channel.isTextBased()) {
    throw new Error("Discord channel not found or not text-based");
  }

  await channel.send(formatRelayMessage(username, message));
  console.log(`Relayed: ${username}: ${message}`);
}

function handleTwitchMessage(channel, tags, message, self) {
  if (self) return;

  const username = tags["display-name"] || tags.username || "unknown";
  const normalized = normalizeMessage(message);

  if (shouldBlockMessage({
    username,
    message: normalized,
    rawMessage: message,
    tags,
    filters
  })) {
    return;
  }

  relayToDiscord(username, normalized).catch((error) => {
    console.error("Failed to relay message", error);
  });
}

async function start() {
  await discordClient.login(DISCORD_TOKEN);
  const tokenInfo = await refreshAndApplyTwitchToken();
  const oauthToken = tokenInfo?.oauthToken ?? TWITCH_OAUTH;
  if (!oauthToken) {
    throw new Error("Missing TWITCH_OAUTH or refresh credentials");
  }
  await connectTwitch(oauthToken);

  console.log("Relay online: Twitch chat -> Discord channel");

  startFreezeMonitor(process.env, {
    logger: console,
    onFreeze: () => {
      const mention = FREEZE_ALERT_ROLE_ID ? `<@&${FREEZE_ALERT_ROLE_ID}> ` : "";
      relaySystemMessage(`${mention}Stream appears frozen`).catch((error) => {
        console.error("Failed to send freeze alert", error);
      });
    },
    onRecover: () => {
      relaySystemMessage("Stream motion detected again").catch((error) => {
        console.error("Failed to send recovery alert", error);
      });
    },
    onOffline: () => {
      relaySystemMessage("Stream appears offline").catch((error) => {
        console.error("Failed to send offline alert", error);
      });
    },
    onOnline: () => {
      relaySystemMessage("Stream appears online").catch((error) => {
        console.error("Failed to send online alert", error);
      });
    }
  });

  if (tokenInfo?.expiresIn) {
    scheduleTokenRefresh(tokenInfo.expiresIn);
  }
}

async function relaySystemMessage(message) {
  const channel =
    discordChannel ?? (await discordClient.channels.fetch(DISCORD_CHANNEL_ID));
  if (!channel || !channel.isTextBased()) {
    throw new Error("Discord channel not found or not text-based");
  }

  await channel.send(`[SYSTEM] ${message}`);
}

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
    const updated = content.replace(
      /^TWITCH_REFRESH_TOKEN=.*$/m,
      line
    );
    if (updated !== content) {
      await fs.writeFile(envPath, updated, "utf8");
    }
    return;
  }

  await fs.writeFile(envPath, `${content}\n${line}\n`, "utf8");
}

async function refreshAndApplyTwitchToken() {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET || !currentRefreshToken) {
    return null;
  }

  const refreshed = await refreshTwitchToken({
    clientId: TWITCH_CLIENT_ID,
    clientSecret: TWITCH_CLIENT_SECRET,
    refreshToken: currentRefreshToken
  });

  const oauthToken = `oauth:${refreshed.accessToken}`;
  currentRefreshToken = refreshed.refreshToken;
  process.env.TWITCH_OAUTH = oauthToken;
  if (!process.env.FREEZE_OAUTH_BEARER || freezeAuthManaged) {
    process.env.FREEZE_OAUTH_BEARER = refreshed.accessToken;
    freezeAuthManaged = true;
  }

  if (refreshed.refreshToken !== currentRefreshToken) {
    persistRefreshToken(refreshed.refreshToken).catch((error) => {
      console.warn("Failed to persist Twitch refresh token", error);
    });
  }

  return {
    oauthToken,
    expiresIn: refreshed.expiresIn
  };
}

function scheduleTokenRefresh(expiresInSeconds) {
  if (!expiresInSeconds) return;
  const refreshIn = Math.max(60, Math.floor(expiresInSeconds * 0.8));
  setTimeout(async () => {
    try {
      const tokenInfo = await refreshAndApplyTwitchToken();
      if (tokenInfo?.oauthToken) {
        await connectTwitch(tokenInfo.oauthToken);
      }
      if (tokenInfo?.expiresIn) {
        scheduleTokenRefresh(tokenInfo.expiresIn);
      }
    } catch (error) {
      console.error("Failed to refresh Twitch token", error);
      scheduleTokenRefresh(Math.max(60, expiresInSeconds));
    }
  }, refreshIn * 1000);
}

start().catch((error) => {
  console.error("Startup failed", error);
  process.exit(1);
});
