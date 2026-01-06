import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags,
  PermissionsBitField
} from "discord.js";
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
import {
  addBlacklistWord,
  loadBlacklist,
  removeBlacklistWord
} from "./blacklistStore.js";

const {
  DISCORD_TOKEN,
  DISCORD_CHANNEL_ID,
  TWITCH_USERNAME,
  TWITCH_OAUTH,
  TWITCH_CHANNEL,
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_REFRESH_TOKEN,
  FREEZE_ALERT_ROLE_ID,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,
  SUSPICIOUS_FLAG_ENABLED,
  REACTION_DELETE_EMOJI,
  REACTION_TIMEOUT_EMOJI,
  REACTION_BAN_EMOJI,
  REACTION_TIMEOUT_SECONDS
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
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User]
});

let twitchClient = null;
let currentRefreshToken = TWITCH_REFRESH_TOKEN;
let freezeAuthManaged = false;
const relayMessageMap = new Map();
const relayDiscordMap = new Map();
const RELAY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

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
const runtimeBlacklist = new Set();

discordClient.once("clientReady", async () => {
  try {
    discordChannel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID);
  } catch (error) {
    console.error("Failed to fetch Discord channel on startup", error);
  }
  console.log(`Discord connected as ${discordClient.user?.tag ?? "unknown"}`);
});

discordClient.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "klb") return;

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "addblacklist") {
    const word = interaction.options.getString("word", true).trim();
    if (!word) {
      await interaction.reply({
        content: "Word cannot be empty.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const result = await addBlacklistWord(word);
    if (result.added) {
      runtimeBlacklist.add(word);
      filters.blockedWords.push(word);
      await interaction.reply({
        content: `Added blacklist word: \`${word}\``,
        flags: MessageFlags.Ephemeral
      });
    } else {
      await interaction.reply({
        content: `Word already in blacklist: \`${word}\``,
        flags: MessageFlags.Ephemeral
      });
    }
  } else if (subcommand === "removeblacklist") {
    const word = interaction.options.getString("word", true).trim();
    if (!word) {
      await interaction.reply({
        content: "Word cannot be empty.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const result = await removeBlacklistWord(word);
    if (result.removed) {
      runtimeBlacklist.delete(word);
      filters.blockedWords = filters.blockedWords.filter((item) => item !== word);
      await interaction.reply({
        content: `Removed blacklist word: \`${word}\``,
        flags: MessageFlags.Ephemeral
      });
    } else {
      await interaction.reply({
        content: `Word not found: \`${word}\``,
        flags: MessageFlags.Ephemeral
      });
    }
  } else if (subcommand === "listblacklist") {
    const words = await loadBlacklist();
    if (!words.length) {
      await interaction.reply({
        content: "Blacklist is empty.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const list = words.join("\n");
    await interaction.reply({
      content: `Blacklist words:\n\`\`\`\n${list}\n\`\`\``,
      flags: MessageFlags.Ephemeral
    });
  } else if (subcommand === "restart") {
    const adminRoleAllowed =
      process.env.ADMIN_ROLE_ID &&
      interaction.member?.roles?.cache?.has(process.env.ADMIN_ROLE_ID);
    const modRoleAllowed =
      process.env.MOD_ROLE_ID &&
      interaction.member?.roles?.cache?.has(process.env.MOD_ROLE_ID);
    const isAdmin = interaction.memberPermissions?.has(
      PermissionsBitField.Flags.Administrator
    );
    if (!adminRoleAllowed && !modRoleAllowed && !isAdmin) {
      await interaction.reply({
        content: "You need Administrator permission to restart the bot.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.reply({
      content: "Restarting bot...",
      flags: MessageFlags.Ephemeral
    });

    setTimeout(() => {
      process.exit(0);
    }, 1000);
  }
});

discordClient.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;
  if (reaction.message.channelId !== DISCORD_CHANNEL_ID) return;

  try {
    if (reaction.partial) {
      await reaction.fetch();
    }
    if (reaction.message.partial) {
      await reaction.message.fetch();
    }
  } catch {
    return;
  }

  const actionConfig = {
    delete: REACTION_DELETE_EMOJI,
    timeout: REACTION_TIMEOUT_EMOJI,
    ban: REACTION_BAN_EMOJI
  };
  const hasAnyAction = Object.values(actionConfig).some(Boolean);
  const reactionAction = resolveReactionAction(reaction, actionConfig, hasAnyAction);
  if (!reactionAction) return;

  const guild = reaction.message.guild;
  if (!guild) return;

  let member;
  try {
    member = await guild.members.fetch(user.id);
  } catch {
    return;
  }

  const adminRoleAllowed =
    process.env.ADMIN_ROLE_ID && member.roles.cache.has(process.env.ADMIN_ROLE_ID);
  const modRoleAllowed =
    process.env.MOD_ROLE_ID && member.roles.cache.has(process.env.MOD_ROLE_ID);
  const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);
  if (!adminRoleAllowed && !modRoleAllowed && !isAdmin) return;

  const relay = relayDiscordMap.get(reaction.message.id);
  if (!relay || !twitchClient) return;

  try {
    const channelName = relay.twitchChannel.startsWith("#")
      ? relay.twitchChannel
      : `#${relay.twitchChannel}`;
    if (reactionAction === "delete") {
      await twitchClient.deletemessage(channelName, relay.twitchMessageId);
    } else if (reactionAction === "timeout") {
      const seconds = parseInt(REACTION_TIMEOUT_SECONDS, 10) || 60;
      await twitchClient.timeout(channelName, relay.twitchUsername, seconds);
    } else if (reactionAction === "ban") {
      await twitchClient.ban(channelName, relay.twitchUsername);
    }
  } catch (error) {
    console.warn("Failed to delete Twitch message", error);
  }
});

function attachTwitchHandlers(client) {
  client.on("message", handleTwitchMessage);
  client.on("messagedeleted", handleTwitchMessageDeleted);
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

function isSuspiciousMessage(message) {
  if (SUSPICIOUS_FLAG_ENABLED?.toLowerCase() === "false") {
    return false;
  }
  if (!filters.blockedWords.length) return false;
  const lowerMessage = message.toLowerCase();
  return filters.blockedWords.some((word) =>
    word && lowerMessage.includes(word.toLowerCase())
  );
}

function resolveReactionAction(reaction, actionConfig, requireMatch) {
  const name = reaction.emoji?.name ?? "";
  const id = reaction.emoji?.id ?? "";
  const matches = (config) => config && (config === name || config === id);

  if (matches(actionConfig.timeout)) return "timeout";
  if (matches(actionConfig.ban)) return "ban";
  if (matches(actionConfig.delete)) return "delete";

  return requireMatch ? null : "delete";
}

async function relayToDiscord(username, message) {
  const channel =
    discordChannel ?? (await discordClient.channels.fetch(DISCORD_CHANNEL_ID));
  if (!channel || !channel.isTextBased()) {
    throw new Error("Discord channel not found or not text-based");
  }

  const suspicious = isSuspiciousMessage(message);
  const suffix = suspicious ? " ⚠️ Suspicious message" : "";
  const sent = await channel.send(`${formatRelayMessage(username, message)}${suffix}`);
  console.log(`Relayed: ${username}: ${message}`);
  return sent;
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

  relayToDiscord(username, normalized)
    .then((sent) => {
      const msgId = tags?.id;
      if (!msgId || !sent) return;
      relayMessageMap.set(msgId, { discordMessageId: sent.id });
      relayDiscordMap.set(sent.id, {
        twitchMessageId: msgId,
        twitchChannel: channel,
        twitchUsername: tags?.username ?? username
      });
      setTimeout(() => {
        relayMessageMap.delete(msgId);
        relayDiscordMap.delete(sent.id);
      }, RELAY_CACHE_TTL_MS);
    })
    .catch((error) => {
      console.error("Failed to relay message", error);
    });
}

async function handleTwitchMessageDeleted(channel, username, deletedMessage, userstate) {
  const targetId = userstate?.["target-msg-id"];
  if (!targetId) return;
  const record = relayMessageMap.get(targetId);
  if (!record) return;

  const discordChannelResolved =
    discordChannel ?? (await discordClient.channels.fetch(DISCORD_CHANNEL_ID));
  if (!discordChannelResolved || !discordChannelResolved.isTextBased()) {
    return;
  }

  try {
    const message = await discordChannelResolved.messages.fetch(record.discordMessageId);
    if (!message) return;
    if (message.content.includes("(deleted")) return;
    await message.edit(`${message.content} (deleted)`);
  } catch (error) {
    console.warn("Failed to update deleted message", error);
  }
}

async function start() {
  await discordClient.login(DISCORD_TOKEN);
  await hydrateBlacklist();
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

async function hydrateBlacklist() {
  try {
    const words = await loadBlacklist();
    for (const word of words) {
      if (!runtimeBlacklist.has(word)) {
        runtimeBlacklist.add(word);
        filters.blockedWords.push(word);
      }
    }
  } catch (error) {
    console.warn("Failed to load blacklist file", error);
  }
}

// Slash command registration moved to deploy-commands.js

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

  const previousRefreshToken = currentRefreshToken;
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
