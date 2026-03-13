import botState from "../state/BotState.js";
import {
  buildNormalV2Message,
  buildSuspiciousV2Message,
  buildExpiredV2Message,
  buildExpiredAutoBanV2Message
} from "./messageBuilder.js";

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

  // Add channel prefix if multi-channel mode
  const channelPrefix =
    botState.twitchChannels.length > 1 && twitchChannel
      ? `[${twitchChannel.replace(/^#/, "")}] `
      : "";

  const formattedText = `${channelPrefix}${formatRelayMessage(username, message)}`;

  let sent = null;
  if (botState.config.moderationUseButtons) {
    // V2 Components path
    const payload = suspiciousMatch
      ? buildSuspiciousV2Message(formattedText, suspiciousMatch)
      : buildNormalV2Message(formattedText);

    for (const channel of targetChannels) {
      if (!channel?.isTextBased()) continue;
      const result = await channel.send(payload);
      if (!sent) sent = result;
    }
  } else {
    // Legacy path (emoji reactions)
    const suffix = suspiciousMatch ? ` ⚠️ Suspicious message [${suspiciousMatch}]` : "";
    for (const channel of targetChannels) {
      if (!channel?.isTextBased()) continue;
      const result = await channel.send(`${formattedText}${suffix}`);
      if (suspiciousMatch) {
        addModerationReactions(result).catch((error) => {
          console.warn("Failed to add moderation reactions", error);
        });
      }
      if (!sent) sent = result;
    }
  }

  console.log(`Relayed [${twitchChannel || "unknown"}]: ${username}: ${message}`);
  return { sent, formattedText };
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
 * On startup, scan recent messages in relay channels and strip buttons from expired ones.
 * This covers messages sent before a restart whose setTimeout was lost.
 */
export async function stripExpiredButtons() {
  if (!botState.config.moderationUseButtons) return;

  const channels = botState.discordChannels;
  if (!channels.length) return;

  let stripped = 0;
  for (const channel of channels) {
    if (!channel?.isTextBased()) continue;
    try {
      const messages = await channel.messages.fetch({ limit: 100 });
      const now = Date.now();
      for (const msg of messages.values()) {
        if (msg.author.id !== botState.discordClient?.user?.id) continue;
        if (now - msg.createdTimestamp < RELAY_CACHE_TTL_MS) continue;

        const container = msg.components?.[0];
        const hasUnbanButton = (container?.components || []).some(
          (c) =>
            c.type === 1 &&
            c.components?.some((btn) => btn.type === 2 && btn.custom_id === "mod-unban")
        );
        const hasButtons = (container?.components || []).some(
          (c) => c.type === 1 && c.components?.some((btn) => btn.type === 2)
        );
        if (!hasUnbanButton && !hasButtons) continue;

        if (hasUnbanButton) {
          const textComponents = (container?.components || []).filter((c) => c.type === 10);
          let matchedPattern = "unknown";
          let isFirstMsg = false;
          for (const td of textComponents) {
            const patternMatch = td.content?.match(/Matched: (.+)/);
            if (patternMatch) matchedPattern = patternMatch[1];
            if (td.content?.includes("First-time chatter")) isFirstMsg = true;
          }
          const expiredText =
            textComponents[0]?.data?.content ||
            textComponents[0]?.content ||
            "(message unavailable)";
          await msg.edit(buildExpiredAutoBanV2Message(expiredText, matchedPattern, isFirstMsg));
        } else {
          const textComponents = (container?.components || []).filter((c) => c.type === 10);
          const expiredText =
            textComponents[0]?.data?.content ||
            textComponents[0]?.content ||
            "(message unavailable)";
          await msg.edit(buildExpiredV2Message(expiredText));
        }
        stripped++;
      }
    } catch (err) {
      console.warn(`Failed to scan channel ${channel.id} for expired buttons:`, err.message);
    }
  }

  if (stripped > 0) {
    console.log(`Stripped buttons from ${stripped} expired message(s) on startup`);
  }
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
export function recordRelayMapping(
  twitchMessageId,
  discordMessage,
  twitchChannel,
  twitchUsername,
  twitchMessage,
  formattedText
) {
  if (!twitchMessageId || !discordMessage) return;

  botState.addRelayMapping(
    twitchMessageId,
    discordMessage.id,
    discordMessage.channelId,
    twitchChannel,
    twitchUsername,
    twitchMessage,
    formattedText
  );

  // Schedule removal after TTL — also strip moderation buttons if present
  setTimeout(async () => {
    botState.removeRelayMapping(twitchMessageId, discordMessage.id);

    if (!botState.config.moderationUseButtons) return;
    try {
      const channel = await botState.discordClient?.channels.fetch(discordMessage.channelId);
      if (!channel) return;
      const msg = await channel.messages.fetch(discordMessage.id);
      // Use instance .components (not .data.components — ContainerComponent destructures it out)
      const container = msg.components?.[0];
      // Check for unban button (auto-ban card) vs regular mod buttons
      const hasUnbanButton = (container?.components || []).some(
        (c) =>
          c.type === 1 &&
          c.components?.some((btn) => btn.type === 2 && btn.custom_id === "mod-unban")
      );
      const hasButtons = (container?.components || []).some(
        (c) => c.type === 1 && c.components?.some((btn) => btn.type === 2)
      );

      if (hasUnbanButton) {
        const textComponents = (container?.components || []).filter((c) => c.type === 10);
        let matchedPattern = "unknown";
        let isFirstMsg = false;
        for (const td of textComponents) {
          const patternMatch = td.content?.match(/Matched: (.+)/);
          if (patternMatch) matchedPattern = patternMatch[1];
          if (td.content?.includes("First-time chatter")) isFirstMsg = true;
        }
        await msg.edit(buildExpiredAutoBanV2Message(formattedText, matchedPattern, isFirstMsg));
      } else if (hasButtons) {
        await msg.edit(buildExpiredV2Message(formattedText));
      }
    } catch {
      // Message may have been deleted — ignore
    }
  }, RELAY_CACHE_TTL_MS);
}

export { RELAY_CACHE_TTL_MS };
