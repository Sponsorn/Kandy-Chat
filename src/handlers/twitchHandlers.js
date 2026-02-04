import tmi from "tmi.js";
import botState from "../state/BotState.js";
import { normalizeMessage, shouldBlockMessage } from "../filters.js";
import { relayToDiscord, recordRelayMapping, relaySystemMessage } from "../services/relayService.js";

const GIFT_SUB_BATCH_MS = 1500;

/**
 * Get tier name from plan code
 */
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

/**
 * Send a message to Twitch chat
 */
export async function sendTwitchMessage(message, targetChannel = null) {
  if (!botState.twitchClient) {
    console.warn("Cannot send Twitch message: client not connected");
    return;
  }

  const channel = targetChannel || botState.twitchChannels[0];
  try {
    await botState.twitchClient.say(channel, message);
  } catch (error) {
    console.error("Failed to send Twitch message:", error);
  }
}

/**
 * Handle !klbping command
 */
function handleKlbPing(tags, channel) {
  const isMod = tags.mod || false;
  const isBroadcaster = tags.badges?.broadcaster === "1";

  if (isMod || isBroadcaster) {
    const uptimeStr = botState.getUptimeString();
    sendTwitchMessage(`pong, uptime: ${uptimeStr}`, channel);
  }
}

/**
 * Handle new subscription
 */
function handleTwitchSubscription(channel, username, method, message, userstate, env) {
  const tier = getTierName(method.plan);
  const enabled = env.SUB_THANK_YOU_ENABLED !== "false";

  if (enabled) {
    const thankYouMessage = `hype Welcome to Kandyland, ${username}! kandyKiss`;
    sendTwitchMessage(thankYouMessage, channel);
  }

  console.log(`[${channel}] New subscription: ${username} (${tier})`);
}

/**
 * Handle resub
 */
function handleTwitchResub(channel, username, streakMonths, message, userstate, methods, env) {
  const tier = getTierName(methods.plan);
  const cumulativeMonths = userstate["msg-param-cumulative-months"] || streakMonths || 0;
  const enabled = env.RESUB_THANK_YOU_ENABLED !== "false";

  if (enabled) {
    const thankYouMessage = `hype Welcome back to Kandyland, ${username}! kandyKiss`;
    sendTwitchMessage(thankYouMessage, channel);
  }

  console.log(`[${channel}] Resub: ${username} (${tier}, ${cumulativeMonths} months, current streak ${streakMonths})`);
}

/**
 * Handle gift sub with batching
 */
function handleTwitchSubGift(channel, username, streakMonths, recipient, methods, env) {
  const tier = getTierName(methods.plan);
  console.log(`[${channel}] Gift sub: ${username} -> ${recipient} (${tier})`);

  const enabled = env.GIFT_SUB_THANK_YOU_ENABLED !== "false";
  if (!enabled) return;

  const batchKey = `${channel}:${username}`;
  let batch = botState.giftSubBatches.get(batchKey);

  if (!batch) {
    batch = {
      channel,
      username,
      recipients: [],
      timer: null
    };
    botState.giftSubBatches.set(batchKey, batch);
  }

  batch.recipients.push(recipient);

  if (batch.timer) {
    clearTimeout(batch.timer);
  }

  batch.timer = setTimeout(() => {
    const recipientCount = batch.recipients.length;
    const recipientText = recipientCount === 1 ? batch.recipients[0] : `${recipientCount} users`;
    const thankYouMessage = `Thank you for gifting to ${recipientText}, ${batch.username}! kandyHype`;

    sendTwitchMessage(thankYouMessage, batch.channel);
    console.log(`[${batch.channel}] Sent combined gift sub thank you for ${recipientCount} gift(s) from ${batch.username}`);

    botState.giftSubBatches.delete(batchKey);
  }, GIFT_SUB_BATCH_MS);
}

/**
 * Handle incoming Twitch chat message
 */
function handleTwitchMessage(channel, tags, message, self, env, discordChannelId) {
  if (self) return;

  const username = tags["display-name"] || tags.username || "unknown";

  // Check if this channel should be relayed
  if (botState.relayChannels) {
    const normalizedChannel = channel.toLowerCase().replace(/^#/, "");
    if (!botState.relayChannels.has(normalizedChannel)) {
      if (message.trim() === "!klbping") {
        handleKlbPing(tags, channel);
      }
      return;
    }
  }

  // Handle !klbping command
  if (message.trim() === "!klbping") {
    handleKlbPing(tags, channel);
    return;
  }

  const normalized = normalizeMessage(message);

  if (shouldBlockMessage({
    username,
    message: normalized,
    rawMessage: message,
    tags,
    filters: botState.filters
  })) {
    botState.recordFilteredMessage();
    return;
  }

  relayToDiscord(username, normalized, channel, discordChannelId)
    .then(sent => {
      const msgId = tags?.id;
      if (!msgId || !sent) return;
      recordRelayMapping(msgId, sent, channel, tags?.username ?? username);
    })
    .catch(error => {
      console.error("Failed to relay message", error);
    });
}

/**
 * Handle Twitch message deletion
 */
async function handleTwitchMessageDeleted(channel, username, deletedMessage, userstate) {
  const targetId = userstate?.["target-msg-id"];
  console.log(`[${channel}] Message deleted: targetId=${targetId}, by=${username}`);

  if (!targetId) return;

  const record = botState.getRelayByTwitchId(targetId);
  if (!record) {
    console.log(`[${channel}] No relay mapping found for deleted message ${targetId}`);
    return;
  }

  const discordChannel = botState.discordChannels.find(
    ch => ch?.id === record.discordChannelId
  );
  if (!discordChannel || !discordChannel.isTextBased()) {
    return;
  }

  try {
    const message = await discordChannel.messages.fetch(record.discordMessageId);
    if (!message) return;
    if (message.content.includes("(deleted")) return;
    await message.edit(`~~${message.content}~~ (deleted)`);
    await message.reactions.removeAll();
    console.log(`[${channel}] Updated Discord message as deleted`);
  } catch (error) {
    console.warn("Failed to update deleted message", error);
  }
}

/**
 * Create a Twitch IRC client
 */
export function createTwitchClient(oauthToken, username) {
  return new tmi.Client({
    options: { debug: false },
    identity: {
      username,
      password: oauthToken
    },
    channels: botState.twitchChannels
  });
}

/**
 * Attach event handlers to Twitch client
 */
export function attachTwitchHandlers(client, env, discordChannelId) {
  client.on("message", (channel, tags, message, self) => {
    handleTwitchMessage(channel, tags, message, self, env, discordChannelId);
  });

  client.on("messagedeleted", handleTwitchMessageDeleted);

  client.on("subscription", (channel, username, method, message, userstate) => {
    handleTwitchSubscription(channel, username, method, message, userstate, env);
  });

  client.on("resub", (channel, username, streakMonths, message, userstate, methods) => {
    handleTwitchResub(channel, username, streakMonths, message, userstate, methods, env);
  });

  client.on("subgift", (channel, username, streakMonths, recipient, methods) => {
    handleTwitchSubGift(channel, username, streakMonths, recipient, methods, env);
  });

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

/**
 * Connect to Twitch IRC
 */
export async function connectTwitch(oauthToken, username, env, discordChannelId) {
  if (botState.twitchClient) {
    try {
      botState.twitchClient.removeAllListeners();
      await botState.twitchClient.disconnect();
    } catch {
      // ignore disconnect errors
    }
  }

  const client = createTwitchClient(oauthToken, username);
  attachTwitchHandlers(client, env, discordChannelId);
  await client.connect();

  botState.setTwitchClient(client);
  return client;
}

export { sendTwitchMessage as sendMessage, handleKlbPing };
