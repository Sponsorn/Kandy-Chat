import botState from "../state/BotState.js";
import { buildAutoBanV2Message } from "./messageBuilder.js";
import { formatRelayMessage, recordRelayMapping } from "./relayService.js";
import { noteBanAttribution } from "./banSyncService.js";

/**
 * Whether the IRC tags mark this as the user's first message in the channel.
 * tmi.js converts the raw "1"/"0" tag values to booleans before emitting the
 * message event, so both forms are accepted.
 * @param {Object} tags - Twitch IRC tags
 * @returns {boolean}
 */
export function isFirstMessage(tags) {
  const value = tags?.["first-msg"];
  return value === true || value === "1";
}

/**
 * Check if a message matches any enabled auto-ban rule
 * @param {string} message - Normalized message text
 * @param {Object} tags - Twitch IRC tags
 * @returns {{ matched: boolean, rule?: Object }}
 */
export function checkAutoBan(message, tags) {
  const rules = botState.autoBanRules;
  if (!rules.length) return { matched: false };

  const isFirstMsg = isFirstMessage(tags);
  const lowerMessage = message.toLowerCase();

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.firstMsgOnly && !isFirstMsg) continue;

    if (rule.isRegex) {
      const regex = botState.getAutoBanRegex(rule.id);
      if (!regex) continue;
      if (regex.global || regex.sticky) regex.lastIndex = 0;
      if (regex.test(message)) {
        return { matched: true, rule };
      }
    } else {
      if (lowerMessage.includes(rule.pattern.toLowerCase())) {
        return { matched: true, rule };
      }
    }
  }

  return { matched: false };
}

/**
 * Execute auto-ban: ban user, send Discord card, record mapping
 * @param {string} username - Twitch display name
 * @param {string} message - Normalized message
 * @param {string} channel - Twitch channel (e.g., "#channelname")
 * @param {Object} tags - Twitch IRC tags
 * @param {string} discordChannelId - Target Discord channel ID
 * @param {Object} rule - The matched auto-ban rule
 * @param {Object} twitchAPIClient - TwitchAPIClient instance
 * @returns {{ success: boolean, discordFailed?: boolean }}
 */
export async function executeAutoBan(
  username,
  message,
  channel,
  tags,
  discordChannelId,
  rule,
  twitchAPIClient
) {
  const channelName = channel.startsWith("#") ? channel : `#${channel}`;
  const twitchUsername = tags?.username ?? username;
  const isFirstMsg = isFirstMessage(tags);
  const patternDisplay = rule.isRegex ? `/${rule.pattern}/${rule.flags || "i"}` : rule.pattern;

  // Ban the user
  try {
    const reason = `Auto-ban: matched ${patternDisplay}`;
    noteBanAttribution(channelName, twitchUsername, "AutoBan");
    await twitchAPIClient.banUser(channelName, twitchUsername, reason);
  } catch (error) {
    console.error(`[AutoBan] Failed to ban ${twitchUsername} in ${channelName}:`, error.message);
    return { success: false };
  }

  console.log(`[AutoBan] Banned ${twitchUsername} in ${channelName} — matched: ${patternDisplay}`);

  botState.recordModerationAction(
    "ban",
    "AutoBan",
    twitchUsername,
    { message, channel: channelName, pattern: patternDisplay },
    "auto",
    "success"
  );

  // Send bot ban card to Discord
  const channelPrefix =
    botState.twitchChannels.length > 1 && channel ? `[${channel.replace(/^#/, "")}] ` : "";
  const formattedText = `${channelPrefix}${formatRelayMessage(username, message)}`;

  let targetChannels = botState.discordChannels;
  if (channel && botState.channelMapping.size > 0) {
    const normalizedCh = channel.toLowerCase().replace(/^#/, "");
    const mappedId = botState.channelMapping.get(normalizedCh);
    if (mappedId) {
      targetChannels = targetChannels.filter((ch) => ch.id === mappedId);
    }
  }

  let sent = null;
  try {
    if (botState.config.moderationUseButtons) {
      const payload = buildAutoBanV2Message(formattedText, patternDisplay, isFirstMsg);
      for (const ch of targetChannels) {
        if (!ch?.isTextBased()) continue;
        const result = await ch.send(payload);
        if (!sent) sent = result;
      }
    } else {
      const firstMsgLabel = isFirstMsg ? " (first-time chatter)" : "";
      const text = `${formattedText} \u{1F916} **Auto-banned**${firstMsgLabel} [${patternDisplay}]`;
      for (const ch of targetChannels) {
        if (!ch?.isTextBased()) continue;
        const result = await ch.send(text);
        if (!sent) sent = result;
      }
    }
  } catch (error) {
    console.error(
      `[AutoBan] Ban succeeded but Discord post failed for ${twitchUsername}:`,
      error.message
    );
    return { success: true, discordFailed: true };
  }

  // Record relay mapping so Unban button works + TTL expiry strips button
  if (sent && tags?.id) {
    recordRelayMapping(tags.id, sent, channel, twitchUsername, message, formattedText);
  }

  return { success: true };
}
