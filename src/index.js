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
import { startEventSubServer } from "./eventsubServer.js";
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
const baseBlockedWords = [...filters.blockedWords];
const blacklistRegexMap = new Map();

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

async function deleteTwitchMessageViaAPI(channelName, messageId) {
  if (!TWITCH_CLIENT_ID || !currentRefreshToken) {
    throw new Error("Missing Twitch credentials");
  }

  // Get fresh access token
  const tokenInfo = await refreshAndApplyTwitchToken();
  const accessToken = tokenInfo?.oauthToken?.replace("oauth:", "") ?? process.env.TWITCH_OAUTH?.replace("oauth:", "");

  if (!accessToken) {
    throw new Error("No Twitch access token available");
  }

  // Get broadcaster user ID
  const broadcasterResponse = await fetch(
    `https://api.twitch.tv/helix/users?login=${channelName.replace("#", "")}`,
    {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Client-Id": TWITCH_CLIENT_ID
      }
    }
  );

  if (!broadcasterResponse.ok) {
    throw new Error(`Failed to get broadcaster ID: ${broadcasterResponse.status}`);
  }

  const broadcasterData = await broadcasterResponse.json();
  const broadcasterId = broadcasterData.data?.[0]?.id;

  if (!broadcasterId) {
    throw new Error("Broadcaster not found");
  }

  // Get moderator user ID (the bot itself)
  const modResponse = await fetch(
    `https://api.twitch.tv/helix/users?login=${TWITCH_USERNAME}`,
    {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Client-Id": TWITCH_CLIENT_ID
      }
    }
  );

  if (!modResponse.ok) {
    throw new Error(`Failed to get moderator ID: ${modResponse.status}`);
  }

  const modData = await modResponse.json();
  const moderatorId = modData.data?.[0]?.id;

  if (!moderatorId) {
    throw new Error("Moderator user not found");
  }

  // Delete the message using Helix API
  const deleteResponse = await fetch(
    `https://api.twitch.tv/helix/moderation/chat?broadcaster_id=${broadcasterId}&moderator_id=${moderatorId}&message_id=${messageId}`,
    {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Client-Id": TWITCH_CLIENT_ID
      }
    }
  );

  if (!deleteResponse.ok) {
    const errorText = await deleteResponse.text();
    throw new Error(`Failed to delete message: ${deleteResponse.status} - ${errorText}`);
  }
}

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

let discordChannels = [];
const runtimeBlacklist = new Set();

discordClient.once("clientReady", async () => {
  try {
    const channelIds = DISCORD_CHANNEL_ID.split(",").map((id) => id.trim()).filter(Boolean);
    const resolved = await Promise.all(
      channelIds.map(async (id) => {
        try {
          return await discordClient.channels.fetch(id);
        } catch (error) {
          console.error(`Failed to fetch Discord channel ${id}`, error);
          return null;
        }
      })
    );
    discordChannels = resolved.filter(Boolean);
  } catch (error) {
    console.error("Failed to fetch Discord channel on startup", error);
  }
  console.log(`Discord connected as ${discordClient.user?.tag ?? "unknown"}`);
});

discordClient.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "klb") return;

  const isAllowed = hasPrivilegedRole(interaction.member);
  if (!isAllowed) {
    await interaction.reply({
      content: "You do not have permission to use this command.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

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
      updateBlacklistFromEntries(result.words);
      await interaction.reply({
        content: `Added blacklist word: \`${word}\``,
        flags: MessageFlags.Ephemeral
      });
      relaySystemMessage(
        `${interaction.user.username} added ${word} to blacklist`
      ).catch((error) => {
        console.error("Failed to send blacklist update message", error);
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
      updateBlacklistFromEntries(result.words);
      await interaction.reply({
        content: `Removed blacklist word: \`${word}\``,
        flags: MessageFlags.Ephemeral
      });
      relaySystemMessage(
        `${interaction.user.username} removed ${word} from blacklist`
      ).catch((error) => {
        console.error("Failed to send blacklist update message", error);
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

    const plain = [];
    const regexes = [];
    for (const entry of words) {
      if (parseRegexEntry(entry)) {
        regexes.push(entry);
      } else {
        plain.push(entry);
      }
    }

    const parts = [];
    if (plain.length) {
      parts.push(`Words:\n\`\`\`\n${plain.join("\n")}\n\`\`\``);
    }
    if (regexes.length) {
      parts.push(`Regex:\n\`\`\`\n${regexes.join("\n")}\n\`\`\``);
    }
    const list = parts.join("\n");
    await interaction.reply({
      content: list,
      flags: MessageFlags.Ephemeral
    });
  } else if (subcommand === "restart") {
    await interaction.reply({
      content: "Restarting bot...",
      flags: MessageFlags.Ephemeral
    });

    setTimeout(() => {
      process.exit(0);
    }, 1000);
  }
});

function hasPrivilegedRole(member) {
  const adminRoleAllowed =
    process.env.ADMIN_ROLE_ID &&
    process.env.ADMIN_ROLE_ID.split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .some((id) => member?.roles?.cache?.has(id));
  const modRoleAllowed =
    process.env.MOD_ROLE_ID &&
    process.env.MOD_ROLE_ID.split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .some((id) => member?.roles?.cache?.has(id));
  const isAdmin = member?.permissions?.has(
    PermissionsBitField.Flags.Administrator
  );
  return Boolean(adminRoleAllowed || modRoleAllowed || isAdmin);
}

discordClient.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;
  const allowedChannelIds = DISCORD_CHANNEL_ID.split(",").map((id) => id.trim());
  if (!allowedChannelIds.includes(reaction.message.channelId)) return;

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
      process.env.ADMIN_ROLE_ID &&
      process.env.ADMIN_ROLE_ID.split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .some((id) => member.roles.cache.has(id));
    const modRoleAllowed =
      process.env.MOD_ROLE_ID &&
      process.env.MOD_ROLE_ID.split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .some((id) => member.roles.cache.has(id));
  const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);
  if (!adminRoleAllowed && !modRoleAllowed && !isAdmin) return;

  const relay = relayDiscordMap.get(reaction.message.id);
  if (!relay || !twitchClient) return;

  const channelName = relay.twitchChannel.startsWith("#")
    ? relay.twitchChannel
    : `#${relay.twitchChannel}`;

  // Extract the original message content from the Discord message
  const messageContent = reaction.message.content;
  const twitchMessageMatch = messageContent.match(/\*\*.*?\*\*: (.+?)(?:⚠️|$)/);
  const twitchMessageText = twitchMessageMatch ? twitchMessageMatch[1].trim() : "(message unavailable)";

  try {
    if (reactionAction === "delete") {
      await deleteTwitchMessageViaAPI(channelName, relay.twitchMessageId);
    } else if (reactionAction === "timeout") {
      const seconds = parseInt(REACTION_TIMEOUT_SECONDS, 10) || 60;
      await twitchClient.timeout(channelName, relay.twitchUsername, seconds);
    } else if (reactionAction === "ban") {
      await twitchClient.ban(channelName, relay.twitchUsername);
    }

    // Remove all reactions from the message
    try {
      await reaction.message.reactions.removeAll();
    } catch (removeError) {
      console.warn("Failed to remove reactions", removeError);
    }

    // Post action message to the channel
    const actionMessages = {
      delete: `**${user.username}** removed **${relay.twitchUsername}**'s message: "${twitchMessageText}"`,
      timeout: `**${user.username}** timed out **${relay.twitchUsername}**, message: "${twitchMessageText}"`,
      ban: `**${user.username}** banned **${relay.twitchUsername}**, message: "${twitchMessageText}"`
    };

    const actionMessage = actionMessages[reactionAction];
    if (actionMessage) {
      try {
        await reaction.message.channel.send(actionMessage);
      } catch (sendError) {
        console.warn("Failed to send action message", sendError);
      }
    }
  } catch (error) {
    console.warn("Failed to moderate Twitch message", error);
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
  if (!filters.blockedWords.length && !filters.blockedRegexes?.length) return false;
  const lowerMessage = message.toLowerCase();
  const wordHit = filters.blockedWords.some((word) =>
    word && lowerMessage.includes(word.toLowerCase())
  );
  const regexHit = filters.blockedRegexes?.some((regex) => {
    if (regex.global || regex.sticky) {
      regex.lastIndex = 0;
    }
    return regex.test(message);
  });
  return wordHit || regexHit;
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
  if (!discordChannels.length) {
    const channelIds = DISCORD_CHANNEL_ID.split(",").map((id) => id.trim()).filter(Boolean);
    discordChannels = await Promise.all(
      channelIds.map((id) => discordClient.channels.fetch(id).catch(() => null))
    );
    discordChannels = discordChannels.filter(Boolean);
  }

  const suspicious = isSuspiciousMessage(message);
  const suffix = suspicious ? " ⚠️ Suspicious message" : "";
  let sent = null;
  for (const channel of discordChannels) {
    if (!channel?.isTextBased()) continue;
    const result = await channel.send(`${formatRelayMessage(username, message)}${suffix}`);
    if (suspicious) {
      addModerationReactions(result).catch((error) => {
        console.warn("Failed to add moderation reactions", error);
      });
    }
    if (!sent) sent = result;
  }
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
      relayMessageMap.set(msgId, {
        discordMessageId: sent.id,
        discordChannelId: sent.channelId
      });
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

  const discordChannelResolved = discordChannels.find(
    (item) => item?.id === record.discordChannelId
  );
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

  await startEventSubServer(process.env, {
    logger: console,
    onEvent: (payload) => {
      const type = payload?.subscription?.type || "unknown";
      console.log(`EventSub notification: ${type}`);
      if (type === "stream.online") {
        relaySystemMessage("EventSub: stream online").catch((error) => {
          console.error("Failed to send EventSub online message", error);
        });
      } else if (type === "stream.offline") {
        relaySystemMessage("EventSub: stream offline").catch((error) => {
          console.error("Failed to send EventSub offline message", error);
        });
      }
    }
  });

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
  if (!discordChannels.length) {
    const channelIds = DISCORD_CHANNEL_ID.split(",").map((id) => id.trim()).filter(Boolean);
    discordChannels = await Promise.all(
      channelIds.map((id) => discordClient.channels.fetch(id).catch(() => null))
    );
    discordChannels = discordChannels.filter(Boolean);
  }

  const payload = `[SYSTEM] ${message}`;
  await Promise.all(
    discordChannels
      .filter((channel) => channel?.isTextBased())
      .map((channel) => channel.send(payload))
  );
}

async function hydrateBlacklist() {
  try {
    const words = await loadBlacklist();
    updateBlacklistFromEntries(words);
  } catch (error) {
    console.warn("Failed to load blacklist file", error);
  }
}

// Slash command registration moved to deploy-commands.js

function updateBlacklistFromEntries(entries) {
  runtimeBlacklist.clear();
  blacklistRegexMap.clear();
  filters.blockedWords = [...baseBlockedWords];
  filters.blockedRegexes = [];

  for (const entry of entries) {
    const trimmed = (entry ?? "").toString().trim();
    if (!trimmed) continue;
    runtimeBlacklist.add(trimmed);
    const regex = parseRegexEntry(trimmed);
    if (regex) {
      blacklistRegexMap.set(trimmed, regex);
      filters.blockedRegexes.push(regex);
    } else {
      filters.blockedWords.push(trimmed);
    }
  }
}

function parseRegexEntry(value) {
  if (!value.startsWith("/")) return null;
  const lastSlash = value.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  const pattern = value.slice(1, lastSlash);
  const flags = value.slice(lastSlash + 1);
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    console.warn(`Invalid blacklist regex "${value}": ${error.message}`);
    return null;
  }
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

async function addModerationReactions(message) {
  const emojis = [REACTION_DELETE_EMOJI, REACTION_TIMEOUT_EMOJI, REACTION_BAN_EMOJI]
    .map((emoji) => (emoji ?? "").trim())
    .filter(Boolean);
  if (!emojis.length) return;

  for (const emoji of emojis) {
    await message.react(emoji);
  }
}

start().catch((error) => {
  console.error("Startup failed", error);
  process.exit(1);
});
