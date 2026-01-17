import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  AttachmentBuilder
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
import { fetchWithTimeout } from "./utils/fetch.js";
import { checkRateLimit } from "./utils/rateLimit.js";
import { TwitchAPIClient } from "./api/TwitchAPIClient.js";
import { handleSlashCommand } from "./commands/commandRegistry.js";

const {
  DISCORD_TOKEN,
  DISCORD_CHANNEL_ID,
  TWITCH_USERNAME,
  TWITCH_OAUTH,
  TWITCH_CHANNEL,
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_REFRESH_TOKEN,
  TWITCH_CHANNEL_MAPPING,
  TWITCH_RELAY_CHANNELS,
  FREEZE_ALERT_ROLE_ID,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,
  SUSPICIOUS_FLAG_ENABLED,
  REACTION_DELETE_EMOJI,
  REACTION_TIMEOUT_EMOJI,
  REACTION_BAN_EMOJI,
  REACTION_WARN_EMOJI,
  REACTION_TIMEOUT_SECONDS,
  SUB_THANK_YOU_ENABLED,
  RESUB_THANK_YOU_ENABLED,
  GIFT_SUB_THANK_YOU_ENABLED
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
const BOT_START_TIME = Date.now();

// Token management - avoid mutating process.env
let currentOAuthToken = TWITCH_OAUTH;
let currentAccessToken = null;

// Parse Twitch channels (comma-separated)
const TWITCH_CHANNELS = TWITCH_CHANNEL.split(",").map((ch) => ch.trim().toLowerCase()).filter(Boolean);

// Parse channels that should be relayed to Discord (optional, defaults to all)
const relayChannels = TWITCH_RELAY_CHANNELS
  ? new Set(TWITCH_RELAY_CHANNELS.split(",").map((ch) => ch.trim().toLowerCase()).filter(Boolean))
  : null;

// Parse channel mapping (format: twitchChannel1:discordChannelId1,twitchChannel2:discordChannelId2)
// If no mapping provided, all Twitch channels relay to all Discord channels
const channelMapping = new Map();
if (TWITCH_CHANNEL_MAPPING) {
  TWITCH_CHANNEL_MAPPING.split(",").forEach((mapping) => {
    const [twitchCh, discordCh] = mapping.split(":").map((s) => s.trim());
    if (twitchCh && discordCh) {
      channelMapping.set(twitchCh.toLowerCase(), discordCh);
    }
  });
}

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
const RELAY_CACHE_TTL_MS = 1 * 60 * 60 * 1000; // 1 hour (reduced from 6 for memory efficiency)

// Initialize Twitch API client
const twitchAPIClient = new TwitchAPIClient(
  TWITCH_CLIENT_ID,
  TWITCH_USERNAME,
  async () => {
    const tokenInfo = await refreshAndApplyTwitchToken();
    return tokenInfo?.oauthToken?.replace("oauth:", "") ?? currentOAuthToken?.replace("oauth:", "");
  }
);

// Clean up expired relay mappings every 15 minutes
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;

  for (const [key, value] of relayMessageMap.entries()) {
    if (now - (value.timestamp || 0) > RELAY_CACHE_TTL_MS) {
      relayMessageMap.delete(key);
      cleaned++;
    }
  }

  for (const [key, value] of relayDiscordMap.entries()) {
    if (now - (value.timestamp || 0) > RELAY_CACHE_TTL_MS) {
      relayDiscordMap.delete(key);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`Cleaned ${cleaned} expired relay mappings`);
  }
}, 15 * 60 * 1000);

function createTwitchClient(oauthToken) {
  return new tmi.Client({
    options: { debug: false },
    identity: {
      username: TWITCH_USERNAME,
      password: oauthToken
    },
    channels: TWITCH_CHANNELS
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

  // Use new modular command handler
  await handleSlashCommand(interaction, {
    twitchAPIClient,
    updateBlacklistFromEntries,
    relaySystemMessage,
    parseRegexEntry,
    TWITCH_CHANNEL
  });
});

discordClient.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;

  // Fetch partial reactions
  try {
    if (reaction.partial) await reaction.fetch();
  } catch {
    return;
  }

  // Determine which action to take based on emoji
  const actionConfig = {
    delete: REACTION_DELETE_EMOJI,
    timeout: REACTION_TIMEOUT_EMOJI,
    ban: REACTION_BAN_EMOJI,
    warn: REACTION_WARN_EMOJI
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
      await twitchAPIClient.deleteMessage(channelName, relay.twitchMessageId);
    } else if (reactionAction === "timeout") {
      const seconds = parseInt(REACTION_TIMEOUT_SECONDS, 10) || 60;
      await twitchAPIClient.timeoutUser(channelName, relay.twitchUsername, seconds);
    } else if (reactionAction === "ban") {
      await twitchAPIClient.banUser(channelName, relay.twitchUsername);
    } else if (reactionAction === "warn") {
      await twitchAPIClient.warnUser(channelName, relay.twitchUsername, "Violating community guidelines");
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
      ban: `**${user.username}** banned **${relay.twitchUsername}**, message: "${twitchMessageText}"`,
      warn: `**${user.username}** warned **${relay.twitchUsername}**, message: "${twitchMessageText}"`
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

// Subscription thank you helper
function getTierName(tier) {
  switch (tier) {
    case "1000":
      return "Tier 1";
    case "2000":
      return "Tier 2";
    case "3000":
      return "Tier 3";
    case "Prime":
    case "prime":
      return "Prime";
    default:
      return tier;
  }
}

async function sendTwitchMessage(message, targetChannel = null) {
  if (!twitchClient) {
    console.warn("Cannot send Twitch message: client not connected");
    return;
  }

  // Use provided channel or default to first channel (or single channel for backwards compat)
  const channel = targetChannel || TWITCH_CHANNELS[0] || TWITCH_CHANNEL;

  try {
    await twitchClient.say(channel, message);
  } catch (error) {
    console.error("Failed to send Twitch message:", error);
  }
}

// Subscription event handlers
function handleTwitchSubscription(channel, username, method, message, userstate) {
  const tier = getTierName(method.plan);

  // Check if sub thank you messages are enabled (default: true)
  const enabled = SUB_THANK_YOU_ENABLED !== "false";
  if (enabled) {
    const thankYouMessage = `hype Welcome to Kandyland, ${username}! kandyKiss`;
    sendTwitchMessage(thankYouMessage, channel);
  }

  console.log(`[${channel}] New subscription: ${username} (${tier})`);
}

function handleTwitchResub(channel, username, months, message, userstate, methods) {
  const tier = getTierName(methods.plan);

  // Check if resub thank you messages are enabled (default: true)
  const enabled = RESUB_THANK_YOU_ENABLED !== "false";
  if (enabled) {
    const thankYouMessage = `hype Welcome back to Kandyland, ${username}! kandyKiss`;
    sendTwitchMessage(thankYouMessage, channel);
  }

  console.log(`[${channel}] Resub: ${username} (${tier}, ${months} months)`);
}

// Gift sub batching to combine multiple gift events into a single message
const giftSubBatches = new Map();

function handleTwitchSubGift(channel, username, streakMonths, recipient, methods) {
  const tier = getTierName(methods.plan);

  console.log(`[${channel}] Gift sub: ${username} -> ${recipient} (${tier})`);

  // Check if gift sub thank you messages are enabled (default: true)
  const enabled = GIFT_SUB_THANK_YOU_ENABLED !== "false";
  if (!enabled) return;

  // Create a unique key for this gift batch
  const batchKey = `${channel}:${username}`;

  // Get or create batch entry
  let batch = giftSubBatches.get(batchKey);
  if (!batch) {
    batch = {
      channel,
      username,
      recipients: [],
      timer: null
    };
    giftSubBatches.set(batchKey, batch);
  }

  // Add recipient to batch
  batch.recipients.push(recipient);

  // Clear existing timer if any
  if (batch.timer) {
    clearTimeout(batch.timer);
  }

  // Set new timer to send combined message after 1.5 seconds
  batch.timer = setTimeout(() => {
    const recipientCount = batch.recipients.length;
    const recipientText = recipientCount === 1 ? batch.recipients[0] : `${recipientCount} users`;
    const thankYouMessage = `Thank you for gifting to ${recipientText}, ${batch.username}! kandyHype`;

    sendTwitchMessage(thankYouMessage, batch.channel);
    console.log(`[${batch.channel}] Sent combined gift sub thank you for ${recipientCount} gift(s) from ${batch.username}`);

    // Clean up batch
    giftSubBatches.delete(batchKey);
  }, 1500);
}

function attachTwitchHandlers(client) {
  client.on("message", handleTwitchMessage);
  client.on("messagedeleted", handleTwitchMessageDeleted);
  client.on("subscription", handleTwitchSubscription);
  client.on("resub", handleTwitchResub);
  client.on("subgift", handleTwitchSubGift);
  client.on("connected", (address, port) => {
    console.log(`Twitch connected to ${address}:${port}`);
  });
  client.on("join", (channel, _username, self) => {
    if (self) {
      console.log(`Successfully joined Twitch channel: ${channel}`);
    }
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
  if (matches(actionConfig.warn)) return "warn";
  if (matches(actionConfig.delete)) return "delete";

  return requireMatch ? null : "delete";
}

async function relayToDiscord(username, message, twitchChannel = null) {
  if (!discordChannels.length) {
    const channelIds = DISCORD_CHANNEL_ID.split(",").map((id) => id.trim()).filter(Boolean);
    discordChannels = await Promise.all(
      channelIds.map((id) => discordClient.channels.fetch(id).catch(() => null))
    );
    discordChannels = discordChannels.filter(Boolean);
  }

  // Determine which Discord channels to relay to
  let targetChannels = discordChannels;
  if (twitchChannel && channelMapping.size > 0) {
    const normalizedTwitchCh = twitchChannel.toLowerCase().replace(/^#/, "");
    const mappedDiscordId = channelMapping.get(normalizedTwitchCh);

    if (mappedDiscordId) {
      // Only relay to the mapped channel
      targetChannels = discordChannels.filter((ch) => ch.id === mappedDiscordId);
    }
    // If no mapping found, fall back to all channels
  }

  const suspicious = isSuspiciousMessage(message);
  const suffix = suspicious ? " ⚠️ Suspicious message" : "";

  // Add channel prefix if multi-channel mode
  const channelPrefix = TWITCH_CHANNELS.length > 1 && twitchChannel ? `[${twitchChannel.replace(/^#/, "")}] ` : "";

  let sent = null;
  for (const channel of targetChannels) {
    if (!channel?.isTextBased()) continue;
    const result = await channel.send(`${channelPrefix}${formatRelayMessage(username, message)}${suffix}`);
    if (suspicious) {
      addModerationReactions(result).catch((error) => {
        console.warn("Failed to add moderation reactions", error);
      });
    }
    if (!sent) sent = result;
  }
  console.log(`Relayed [${twitchChannel || "unknown"}]: ${username}: ${message}`);
  return sent;
}

function handleTwitchMessage(channel, tags, message, self) {
  if (self) return;

  const username = tags["display-name"] || tags.username || "unknown";

  // Check if this channel should be relayed to Discord
  if (relayChannels) {
    const normalizedChannel = channel.toLowerCase().replace(/^#/, "");
    if (!relayChannels.has(normalizedChannel)) {
      // Don't relay messages from this channel, but still process commands
      if (message.trim() === "!klbping") {
        const isMod = tags.mod || false;
        const isBroadcaster = tags.badges?.broadcaster === "1";

        if (isMod || isBroadcaster) {
          const uptimeMs = Date.now() - BOT_START_TIME;
          const uptimeSeconds = Math.floor(uptimeMs / 1000);
          const hours = Math.floor(uptimeSeconds / 3600);
          const minutes = Math.floor((uptimeSeconds % 3600) / 60);
          const seconds = uptimeSeconds % 60;

          let uptimeStr = "";
          if (hours > 0) uptimeStr += `${hours}h `;
          if (minutes > 0 || hours > 0) uptimeStr += `${minutes}m `;
          uptimeStr += `${seconds}s`;

          sendTwitchMessage(`pong, uptime: ${uptimeStr.trim()}`, channel);
        }
      }
      return;
    }
  }

  // Handle !klbping command (mods/broadcaster only)
  if (message.trim() === "!klbping") {
    const isMod = tags.mod || false;
    const isBroadcaster = tags.badges?.broadcaster === "1";

    if (isMod || isBroadcaster) {
      const uptimeMs = Date.now() - BOT_START_TIME;
      const uptimeSeconds = Math.floor(uptimeMs / 1000);
      const hours = Math.floor(uptimeSeconds / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const seconds = uptimeSeconds % 60;

      let uptimeStr = "";
      if (hours > 0) uptimeStr += `${hours}h `;
      if (minutes > 0 || hours > 0) uptimeStr += `${minutes}m `;
      uptimeStr += `${seconds}s`;

      sendTwitchMessage(`pong, uptime: ${uptimeStr.trim()}`, channel);
    }
    return;
  }

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

  relayToDiscord(username, normalized, channel)
    .then((sent) => {
      const msgId = tags?.id;
      if (!msgId || !sent) return;
      relayMessageMap.set(msgId, {
        discordMessageId: sent.id,
        discordChannelId: sent.channelId,
        timestamp: Date.now()
      });
      relayDiscordMap.set(sent.id, {
        twitchMessageId: msgId,
        twitchChannel: channel,
        twitchUsername: tags?.username ?? username,
        timestamp: Date.now()
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
  const oauthToken = tokenInfo?.oauthToken ?? currentOAuthToken;
  if (!oauthToken) {
    throw new Error("Missing TWITCH_OAUTH or refresh credentials");
  }

  console.log(`Attempting to join Twitch channels: ${TWITCH_CHANNELS.join(", ")}`);
  if (relayChannels) {
    console.log(`Relay filter active - only relaying: ${Array.from(relayChannels).join(", ")}`);
  }

  await connectTwitch(oauthToken);

  console.log("Relay online: Twitch chat -> Discord channel");

  // Track last stream status messages per channel for editing (within 30 min window)
  const lastStreamStatusMessages = new Map();
  const STREAM_STATUS_EDIT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

  // Track recent raids between monitored channels to suppress offline/online spam
  const recentRaids = new Map(); // broadcaster -> { timestamp, raidedTo }
  const RAID_SUPPRESS_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

  // Get list of monitored broadcasters for raid detection
  const monitoredBroadcasters = new Set(
    (process.env.EVENTSUB_BROADCASTER || "").split(",").map(b => b.trim().toLowerCase()).filter(Boolean)
  );

  await startEventSubServer(process.env, {
    logger: console,
    onEvent: (payload) => {
      const type = payload?.subscription?.type || "unknown";
      const broadcasterName = payload?.event?.broadcaster_user_name || payload?.event?.broadcaster_user_login || "unknown";
      console.log(`EventSub notification: ${type} for ${broadcasterName}`);

      if (type === "stream.online") {
        // Check if this online event is due to a recent raid from another monitored channel
        const now = Date.now();
        let shouldSuppress = false;

        for (const [raidedFrom, raidInfo] of recentRaids.entries()) {
          if (raidInfo.raidedTo === broadcasterName.toLowerCase() &&
              (now - raidInfo.timestamp) <= RAID_SUPPRESS_WINDOW_MS) {
            console.log(`Suppressing online message for ${broadcasterName} (recent raid from ${raidedFrom})`);
            shouldSuppress = true;
            break;
          }
        }

        if (!shouldSuppress) {
          relayStreamStatusMessage(broadcasterName, `${broadcasterName} went live on Twitch`, lastStreamStatusMessages, STREAM_STATUS_EDIT_WINDOW_MS).catch((error) => {
            console.error("Failed to send EventSub online message", error);
          });
        }
      } else if (type === "stream.offline") {
        // Check if there's a recent raid from this channel
        const raidInfo = recentRaids.get(broadcasterName.toLowerCase());
        const now = Date.now();

        if (raidInfo && (now - raidInfo.timestamp) <= RAID_SUPPRESS_WINDOW_MS) {
          console.log(`Suppressing offline message for ${broadcasterName} (raided to ${raidInfo.raidedTo})`);
        } else {
          relayStreamStatusMessage(broadcasterName, `${broadcasterName} went offline on Twitch`, lastStreamStatusMessages, STREAM_STATUS_EDIT_WINDOW_MS).catch((error) => {
            console.error("Failed to send EventSub offline message", error);
          });
        }
      } else if (type === "channel.raid") {
        const fromBroadcaster = payload?.event?.from_broadcaster_user_name || payload?.event?.from_broadcaster_user_login;
        const toBroadcaster = payload?.event?.to_broadcaster_user_name || payload?.event?.to_broadcaster_user_login;
        const viewers = payload?.event?.viewers || 0;
        console.log(`Raid: ${fromBroadcaster} raided ${toBroadcaster} with ${viewers} viewers`);

        // Track raid if it's between monitored channels
        if (monitoredBroadcasters.has(fromBroadcaster?.toLowerCase()) &&
            monitoredBroadcasters.has(toBroadcaster?.toLowerCase())) {
          recentRaids.set(fromBroadcaster.toLowerCase(), {
            timestamp: Date.now(),
            raidedTo: toBroadcaster.toLowerCase()
          });
          console.log(`Tracking raid between monitored channels: ${fromBroadcaster} -> ${toBroadcaster}`);
        }
      }
    }
  });

  // Pass the access token to freeze monitor, using module variable instead of env
  const freezeEnv = { ...process.env };
  if (!freezeEnv.FREEZE_OAUTH_BEARER && currentAccessToken) {
    freezeEnv.FREEZE_OAUTH_BEARER = currentAccessToken;
  } else if (!freezeEnv.FREEZE_OAUTH_BEARER && oauthToken) {
    freezeEnv.FREEZE_OAUTH_BEARER = oauthToken.replace(/^oauth:/, "");
  }

  startFreezeMonitor(freezeEnv, {
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

async function relayStreamStatusMessage(broadcasterName, message, statusCache, editWindowMs) {
  if (!discordChannels.length) {
    const channelIds = DISCORD_CHANNEL_ID.split(",").map((id) => id.trim()).filter(Boolean);
    discordChannels = await Promise.all(
      channelIds.map((id) => discordClient.channels.fetch(id).catch(() => null))
    );
    discordChannels = discordChannels.filter(Boolean);
  }

  const payload = `[SYSTEM] ${message}`;
  const now = Date.now();

  // Check if we have a recent message to edit
  const cachedEntry = statusCache.get(broadcasterName);
  if (cachedEntry && (now - cachedEntry.timestamp) <= editWindowMs) {
    // Edit the existing messages
    await Promise.all(
      cachedEntry.messages.map(async (msg) => {
        try {
          await msg.edit(payload);
        } catch (error) {
          console.error("Failed to edit stream status message", error);
        }
      })
    );
  } else {
    // Send new messages
    const sentMessages = await Promise.all(
      discordChannels
        .filter((channel) => channel?.isTextBased())
        .map((channel) => channel.send(payload).catch(() => null))
    );

    // Cache the new messages
    statusCache.set(broadcasterName, {
      messages: sentMessages.filter(Boolean),
      timestamp: now
    });
  }
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

  // Store tokens in module variables instead of mutating process.env
  currentOAuthToken = oauthToken;
  currentAccessToken = refreshed.accessToken;
  if (!currentAccessToken || freezeAuthManaged) {
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
  const emojis = [REACTION_DELETE_EMOJI, REACTION_TIMEOUT_EMOJI, REACTION_BAN_EMOJI, REACTION_WARN_EMOJI]
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
