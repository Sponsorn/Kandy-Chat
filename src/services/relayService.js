import botState from "../state/BotState.js";

const RELAY_CACHE_TTL_MS = 1 * 60 * 60 * 1000; // 1 hour

/**
 * Format a relay message with timestamp and username
 */
export function formatRelayMessage(username, message) {
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

/**
 * Check if a message contains suspicious content
 * @returns {string|null} Matched word/pattern or null
 */
export function checkSuspiciousMessage(message) {
  if (!botState.config.suspiciousFlagEnabled) {
    return null;
  }

  const { filters } = botState;
  if (!filters?.blockedWords?.length && !filters?.blockedRegexes?.length) {
    return null;
  }

  const lowerMessage = message.toLowerCase();
  const matchedWord = filters.blockedWords.find(
    (word) => word && lowerMessage.includes(word.toLowerCase())
  );
  if (matchedWord) return matchedWord;

  const matchedRegex = filters.blockedRegexes?.find((regex) => {
    if (regex.global || regex.sticky) {
      regex.lastIndex = 0;
    }
    return regex.test(message);
  });
  if (matchedRegex) return matchedRegex.source;

  return null;
}

/**
 * Add moderation reaction emojis to a message
 */
export async function addModerationReactions(message) {
  const { reactionEmojis } = botState.config;
  const emojis = [reactionEmojis.delete, reactionEmojis.timeout, reactionEmojis.ban]
    .map((emoji) => (emoji ?? "").trim())
    .filter(Boolean);

  console.log(`Adding moderation reactions: ${emojis.join(", ")}`);
  if (!emojis.length) return;

  for (const emoji of emojis) {
    try {
      await message.react(emoji);
    } catch (error) {
      console.warn(`Failed to add reaction ${emoji}:`, error.message);
    }
  }
}

/**
 * Relay a Twitch message to Discord
 */
export async function relayToDiscord(username, message, twitchChannel, discordChannelId) {
  let targetChannels = botState.discordChannels;

  // If no channels cached, try to fetch them
  if (!targetChannels.length && discordChannelId) {
    const channelIds = discordChannelId
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    targetChannels = await Promise.all(
      channelIds.map((id) =>
        botState.discordClient?.channels.fetch(id).catch((err) => {
          console.warn(`Failed to fetch Discord channel ${id}: ${err.message}`);
          return null;
        })
      )
    );
    targetChannels = targetChannels.filter(Boolean);
    botState.discordChannels = targetChannels;
  }

  // Apply channel mapping if configured
  if (twitchChannel && botState.channelMapping.size > 0) {
    const normalizedTwitchCh = twitchChannel.toLowerCase().replace(/^#/, "");
    const mappedDiscordId = botState.channelMapping.get(normalizedTwitchCh);

    if (mappedDiscordId) {
      targetChannels = targetChannels.filter((ch) => ch.id === mappedDiscordId);
    }
  }

  const suspiciousMatch = checkSuspiciousMessage(message);
  const suffix = suspiciousMatch ? ` ⚠️ Suspicious message [${suspiciousMatch}]` : "";

  // Add channel prefix if multi-channel mode
  const channelPrefix =
    botState.twitchChannels.length > 1 && twitchChannel
      ? `[${twitchChannel.replace(/^#/, "")}] `
      : "";

  let sent = null;
  for (const channel of targetChannels) {
    if (!channel?.isTextBased()) continue;
    const result = await channel.send(
      `${channelPrefix}${formatRelayMessage(username, message)}${suffix}`
    );
    if (suspiciousMatch) {
      addModerationReactions(result).catch((error) => {
        console.warn("Failed to add moderation reactions", error);
      });
    }
    if (!sent) sent = result;
  }

  console.log(`Relayed [${twitchChannel || "unknown"}]: ${username}: ${message}`);
  return sent;
}

/**
 * Relay a system message to all Discord channels
 */
export async function relaySystemMessage(message, discordChannelId) {
  let channels = botState.discordChannels;

  if (!channels.length && discordChannelId) {
    const channelIds = discordChannelId
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    channels = await Promise.all(
      channelIds.map((id) =>
        botState.discordClient?.channels.fetch(id).catch((err) => {
          console.warn(`Failed to fetch Discord channel ${id}: ${err.message}`);
          return null;
        })
      )
    );
    channels = channels.filter(Boolean);
    botState.discordChannels = channels;
  }

  const payload = `[SYSTEM] ${message}`;
  const messages = await Promise.all(
    channels.filter((channel) => channel?.isTextBased()).map((channel) => channel.send(payload))
  );
  return messages;
}

/**
 * Start periodic cleanup of expired relay mappings
 */
export function startRelayCleanup(intervalMs = 15 * 60 * 1000) {
  const raidTtl = (parseInt(process.env.RAID_SUPPRESS_WINDOW_SECONDS, 10) || 30) * 1000;

  return setInterval(() => {
    const cleaned = botState.cleanupExpired(RELAY_CACHE_TTL_MS, raidTtl);
    if (cleaned > 0) {
      console.log(`Cleaned ${cleaned} expired relay mappings`);
    }
  }, intervalMs);
}

/**
 * Record a relay mapping with auto-expiry
 */
export function recordRelayMapping(twitchMessageId, discordMessage, twitchChannel, twitchUsername) {
  if (!twitchMessageId || !discordMessage) return;

  botState.addRelayMapping(
    twitchMessageId,
    discordMessage.id,
    discordMessage.channelId,
    twitchChannel,
    twitchUsername
  );

  // Schedule removal after TTL
  setTimeout(() => {
    botState.removeRelayMapping(twitchMessageId, discordMessage.id);
  }, RELAY_CACHE_TTL_MS);
}

export { RELAY_CACHE_TTL_MS };
