import "dotenv/config";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import tmi from "tmi.js";
import {
  buildFilters,
  normalizeMessage,
  shouldBlockMessage
} from "./filters.js";
import { startFreezeMonitor } from "./freezeMonitor.js";

const {
  DISCORD_TOKEN,
  DISCORD_CHANNEL_ID,
  TWITCH_USERNAME,
  TWITCH_OAUTH,
  TWITCH_CHANNEL
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_CHANNEL_ID) {
  throw new Error("Missing DISCORD_TOKEN or DISCORD_CHANNEL_ID in environment");
}

if (!TWITCH_USERNAME || !TWITCH_OAUTH || !TWITCH_CHANNEL) {
  throw new Error("Missing TWITCH_USERNAME, TWITCH_OAUTH, or TWITCH_CHANNEL in environment");
}

const filters = buildFilters(process.env);

const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

const twitchClient = new tmi.Client({
  options: { debug: false },
  identity: {
    username: TWITCH_USERNAME,
    password: TWITCH_OAUTH
  },
  channels: [TWITCH_CHANNEL]
});

let discordChannel = null;

discordClient.once("clientReady", async () => {
  try {
    discordChannel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID);
  } catch (error) {
    console.error("Failed to fetch Discord channel on startup", error);
  }
  console.log(`Discord connected as ${discordClient.user?.tag ?? "unknown"}`);
});

twitchClient.on("connected", (address, port) => {
  console.log(`Twitch connected to ${address}:${port}`);
});

twitchClient.on("disconnected", (reason) => {
  console.warn(`Twitch disconnected: ${reason}`);
});

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
  await twitchClient.connect();
  twitchClient.on("message", handleTwitchMessage);

  console.log("Relay online: Twitch chat -> Discord channel");

  startFreezeMonitor(process.env, {
    logger: console,
    onFreeze: () => {
      relaySystemMessage("Stream appears frozen").catch((error) => {
        console.error("Failed to send freeze alert", error);
      });
    },
    onRecover: () => {
      relaySystemMessage("Stream motion detected again").catch((error) => {
        console.error("Failed to send recovery alert", error);
      });
    }
  });
}

async function relaySystemMessage(message) {
  const channel =
    discordChannel ?? (await discordClient.channels.fetch(DISCORD_CHANNEL_ID));
  if (!channel || !channel.isTextBased()) {
    throw new Error("Discord channel not found or not text-based");
  }

  await channel.send(`[SYSTEM] ${message}`);
}

start().catch((error) => {
  console.error("Startup failed", error);
  process.exit(1);
});
