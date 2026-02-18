import "dotenv/config";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Check for stop flag before doing anything else
const STOP_FLAG_PATH = join(process.cwd(), "data", ".stopped");
if (existsSync(STOP_FLAG_PATH)) {
  console.log("Stop flag detected, exiting. Remove data/.stopped to start the bot.");
  process.exit(0);
}

import { Client, GatewayIntentBits, Partials } from "discord.js";
import { validateConfigOrThrow } from "./config/configValidator.js";
import { buildFilters, normalizeMessage } from "./filters.js";
import { loadBlacklist } from "./blacklistStore.js";
import { loadConfig } from "./configStore.js";
import { saveMessage, scheduleCleanup, markMessageRelayed } from "./chatHistoryStore.js";
import { startFreezeMonitor } from "./freezeMonitor.js";
import { startWebServer } from "./server/webServer.js";
import { TwitchAPIClient } from "./api/TwitchAPIClient.js";
import botState from "./state/BotState.js";
import { setupDiscordHandlers } from "./handlers/discordHandlers.js";
import { connectTwitch } from "./handlers/twitchHandlers.js";
import { relaySystemMessage, startRelayCleanup } from "./services/relayService.js";
import {
  refreshAndApplyTwitchToken,
  scheduleTokenRefresh,
  createTokenProvider,
  loadPersistedRefreshToken
} from "./services/tokenService.js";

// Add timestamps to all console output and stream to dashboard
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const getTimestamp = () => new Date().toISOString();
console.log = (...args) => {
  originalConsoleLog(`[${getTimestamp()}]`, ...args);
  botState.addLogEntry("info", args);
};
console.error = (...args) => {
  originalConsoleError(`[${getTimestamp()}]`, ...args);
  botState.addLogEntry("error", args);
};
console.warn = (...args) => {
  originalConsoleWarn(`[${getTimestamp()}]`, ...args);
  botState.addLogEntry("warn", args);
};

// Validate configuration
validateConfigOrThrow(process.env);

const {
  DISCORD_TOKEN,
  DISCORD_CHANNEL_ID,
  TWITCH_USERNAME,
  TWITCH_CHANNEL,
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  FREEZE_ALERT_ROLE_ID,
  STREAM_ALERT_ROLE_ID
} = process.env;

// Initialize state from environment
botState.initFromEnv(process.env);

// Override refresh token from persisted storage if available
const persistedToken = await loadPersistedRefreshToken();
if (persistedToken) {
  botState.currentRefreshToken = persistedToken;
  console.log("Loaded refresh token from data/tokens.json");
}

// Build filters and store in state
const filters = buildFilters(process.env);
const baseBlockedWords = [...filters.blockedWords];
botState.setFilters(filters, baseBlockedWords);

// Credentials for token refresh
const credentials = {
  clientId: TWITCH_CLIENT_ID,
  clientSecret: TWITCH_CLIENT_SECRET
};

// Initialize Discord client
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User]
});

// Initialize Twitch API client
const twitchAPIClient = new TwitchAPIClient(
  TWITCH_CLIENT_ID,
  TWITCH_USERNAME,
  createTokenProvider(credentials)
);

// Parse regex entries for blacklist
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

// Update blacklist entries
function updateBlacklistFromEntries(entries) {
  botState.updateBlacklist(entries, parseRegexEntry);
}

// Hydrate blacklist from storage
async function hydrateBlacklist() {
  try {
    const words = await loadBlacklist();
    updateBlacklistFromEntries(words);
  } catch (error) {
    console.warn("Failed to load blacklist file", error);
  }
}

// Hydrate runtime config from storage
async function hydrateRuntimeConfig() {
  try {
    const config = await loadConfig();
    botState.setRuntimeConfig(config);

    // Apply filter settings from runtime config
    if (config.filters) {
      if (config.filters.blockCommands !== null && botState.filters) {
        botState.filters.blockCommands = config.filters.blockCommands;
      }
      if (config.filters.blockEmotes !== null && botState.filters) {
        botState.filters.blockEmotes = config.filters.blockEmotes;
      }
      if (config.filters.suspiciousFlagEnabled !== null) {
        botState.config.suspiciousFlagEnabled = config.filters.suspiciousFlagEnabled;
      }
    }

    // Load ignored users for chat feed
    if (config.chatFeed?.ignoredUsers) {
      botState.setIgnoredUsers(config.chatFeed.ignoredUsers);
      console.log(`Loaded ${config.chatFeed.ignoredUsers.length} ignored users for chat feed`);
    }

    // Load chat feed debug flag
    if (config.chatFeed?.debug) {
      botState.chatFeedDebug = config.chatFeed.debug;
      console.log("Chat feed debug logging enabled");
    }

    console.log("Runtime config loaded from storage");
  } catch (error) {
    console.warn("Failed to load runtime config file", error);
  }
}

// Create relay system message wrapper
function createRelaySystemMessage(channelId) {
  return (message) => relaySystemMessage(message, channelId);
}

// Discord ready handler
discordClient.once("clientReady", async () => {
  try {
    const channelIds = DISCORD_CHANNEL_ID.split(",")
      .map((id) => id.trim())
      .filter(Boolean);
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
    botState.discordChannels = resolved.filter(Boolean);
  } catch (error) {
    console.error("Failed to fetch Discord channel on startup", error);
  }
  botState.setDiscordClient(discordClient);
  console.log(`Discord connected as ${discordClient.user?.tag ?? "unknown"}`);
});

// Setup Discord handlers
setupDiscordHandlers(discordClient, twitchAPIClient, {
  twitchAPIClient,
  updateBlacklistFromEntries,
  relaySystemMessage: createRelaySystemMessage(DISCORD_CHANNEL_ID),
  parseRegexEntry,
  TWITCH_CHANNEL
});

// Main startup
async function start() {
  await discordClient.login(DISCORD_TOKEN);
  await hydrateBlacklist();
  await hydrateRuntimeConfig();

  // Wire chat messages to persistent storage
  botState.on("chat:message", (messageData) => {
    saveMessage(messageData.channel, messageData);
  });

  // Schedule chat history cleanup (get retention days from config)
  const config = await loadConfig();
  const retentionDays = config.chatFeed?.retentionDays ?? 3;
  scheduleCleanup(retentionDays);

  const tokenInfo = await refreshAndApplyTwitchToken(credentials);
  const oauthToken = tokenInfo?.oauthToken ?? botState.currentOAuthToken;
  if (!oauthToken) {
    throw new Error("Missing TWITCH_OAUTH or refresh credentials");
  }

  console.log(`Attempting to join Twitch channels: ${botState.twitchChannels.join(", ")}`);
  if (botState.relayChannels) {
    console.log(
      `Relay filter active - only relaying: ${Array.from(botState.relayChannels).join(", ")}`
    );
  }

  await connectTwitch(oauthToken, TWITCH_USERNAME, process.env, DISCORD_CHANNEL_ID);
  console.log("Relay online: Twitch chat -> Discord channel");

  // Record bot start in audit log
  botState.recordAuditEvent(
    "start",
    "system",
    {
      channels: botState.twitchChannels.join(", "),
      reason: "Bot started"
    },
    "system"
  );

  // Start relay cleanup interval
  startRelayCleanup();

  // Setup EventSub with freeze monitor integration
  const lastOnlineTimestamp = new Map(); // channel -> Date.now() of last stream.online
  const pendingOfflineTimers = new Map(); // channel -> setTimeout id (for offline→online order)
  let freezeOnlineResolve = null;
  const freezeOnlineSignal = () => {
    if (freezeOnlineResolve) {
      freezeOnlineResolve();
      freezeOnlineResolve = null;
    }
  };
  const freezeWaitForOnline = () =>
    new Promise((resolve) => {
      freezeOnlineResolve = resolve;
    });

  const webServer = await startWebServer(process.env, {
    logger: console,
    twitchAPIClient,
    updateBlacklistFromEntries,
    onEvent: async (payload) => {
      const type = payload?.subscription?.type || "unknown";
      const broadcasterName =
        payload?.event?.broadcaster_user_name ||
        payload?.event?.broadcaster_user_login ||
        "unknown";
      console.log(`EventSub notification: ${type} for ${broadcasterName}`);

      if (type === "stream.online") {
        console.log(`${broadcasterName} went live on Twitch`);
        botState.setStreamStatus(broadcasterName.toLowerCase(), "online");
        lastOnlineTimestamp.set(broadcasterName.toLowerCase(), Date.now());

        // Cancel any pending offline alert (handles offline→online restart order)
        const pendingTimer = pendingOfflineTimers.get(broadcasterName.toLowerCase());
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingOfflineTimers.delete(broadcasterName.toLowerCase());
          console.log(`Cancelled pending offline alert for ${broadcasterName} (stream restart)`);
        }

        // Edit the offline message if it exists
        const offlineMsg = botState.getOfflineMessage(broadcasterName.toLowerCase());
        if (offlineMsg) {
          try {
            const channel = await discordClient.channels.fetch(offlineMsg.channelId);
            const message = await channel.messages.fetch(offlineMsg.messageId);
            // Strikethrough original content (after [SYSTEM] prefix) and add "online again"
            const originalText = offlineMsg.originalContent.replace("[SYSTEM] ", "");
            await message.edit(`[SYSTEM] ~~${originalText}~~ online again`);
            botState.clearOfflineMessage(broadcasterName.toLowerCase());
          } catch (error) {
            console.error("Failed to edit offline message:", error);
          }
        }

        const freezeChannel = process.env.FREEZE_CHANNEL?.toLowerCase();
        if (freezeChannel && broadcasterName.toLowerCase() === freezeChannel) {
          freezeOnlineSignal();
        }
      } else if (type === "stream.offline") {
        console.log(`${broadcasterName} went offline on Twitch`);
        botState.setStreamStatus(broadcasterName.toLowerCase(), "offline");

        const offlineAlertChannels = process.env.OFFLINE_ALERT_CHANNELS?.split(",")
          .map((c) => c.trim().toLowerCase())
          .filter(Boolean);

        if (
          offlineAlertChannels?.length &&
          !offlineAlertChannels.includes(broadcasterName.toLowerCase())
        ) {
          console.log(`Skipping offline alert - ${broadcasterName} not in OFFLINE_ALERT_CHANNELS`);
          return;
        }

        const raidSuppressMs =
          (parseInt(process.env.RAID_SUPPRESS_WINDOW_SECONDS, 10) || 30) * 1000;
        if (botState.hasRecentRaid(broadcasterName, raidSuppressMs)) {
          console.log(`Skipping offline alert - ${broadcasterName} raided recently`);
          return;
        }

        // Suppress offline alert if a stream.online was received very recently
        // This handles Twitch 48h automatic stream restarts where online+offline
        // events arrive within milliseconds of each other
        const restartSuppressMs =
          (parseInt(process.env.RESTART_SUPPRESS_WINDOW_SECONDS, 10) || 60) * 1000;
        const lastOnline = lastOnlineTimestamp.get(broadcasterName.toLowerCase());
        if (lastOnline && Date.now() - lastOnline < restartSuppressMs) {
          console.log(
            `Skipping offline alert - ${broadcasterName} had a stream.online ${Date.now() - lastOnline}ms ago (stream restart)`
          );
          botState.setStreamStatus(broadcasterName.toLowerCase(), "online");
          return;
        }

        // Delay offline alert to handle offline→online restart order
        // If a stream.online arrives during the delay, the timer is cancelled
        const offlineDelayMs =
          (parseInt(process.env.RESTART_SUPPRESS_WINDOW_SECONDS, 10) || 60) * 1000;
        console.log(`Delaying offline alert for ${broadcasterName} by ${offlineDelayMs / 1000}s`);

        const existing = pendingOfflineTimers.get(broadcasterName.toLowerCase());
        if (existing) clearTimeout(existing);

        const timerId = setTimeout(async () => {
          pendingOfflineTimers.delete(broadcasterName.toLowerCase());

          // Re-check — stream may have come back online during the delay
          if (
            botState.metrics.streamStatusByChannel[broadcasterName.toLowerCase()] === "online"
          ) {
            console.log(
              `Skipping offline alert - ${broadcasterName} came back online during delay`
            );
            return;
          }

          const mention = STREAM_ALERT_ROLE_ID ? `<@&${STREAM_ALERT_ROLE_ID}> ` : "";
          const content = `${mention}${broadcasterName} has gone offline`;

          try {
            const messages = await relaySystemMessage(content, DISCORD_CHANNEL_ID);
            // Store first message ID for later editing when stream comes back online
            if (messages?.length > 0) {
              botState.setOfflineMessage(
                broadcasterName.toLowerCase(),
                messages[0].id,
                messages[0].channel.id,
                messages[0].content
              );
            }
          } catch (error) {
            console.error("Failed to send offline stream alert", error);
          }
        }, offlineDelayMs);

        pendingOfflineTimers.set(broadcasterName.toLowerCase(), timerId);
      } else if (type === "channel.raid") {
        const fromBroadcaster =
          payload?.event?.from_broadcaster_user_name || payload?.event?.from_broadcaster_user_login;
        const toBroadcaster =
          payload?.event?.to_broadcaster_user_name || payload?.event?.to_broadcaster_user_login;
        const viewers = payload?.event?.viewers || 0;
        console.log(`Raid: ${fromBroadcaster} raided ${toBroadcaster} with ${viewers} viewers`);

        if (fromBroadcaster) {
          botState.recordRaid(fromBroadcaster);
          // Emit raid:incoming event for dashboard with full data
          botState.emit("raid:incoming", {
            from: fromBroadcaster,
            to: toBroadcaster,
            viewers: viewers,
            timestamp: Date.now()
          });
        }
      }
    }
  });

  // Start freeze monitor
  const freezeEnv = { ...process.env };
  const accessToken = botState.getAccessToken();
  if (!freezeEnv.FREEZE_OAUTH_BEARER && accessToken) {
    freezeEnv.FREEZE_OAUTH_BEARER = accessToken;
  }

  const freezeChannelName = process.env.FREEZE_CHANNEL?.toLowerCase() || null;
  startFreezeMonitor(freezeEnv, {
    logger: console,
    waitForOnline: webServer ? freezeWaitForOnline : undefined,
    onFreeze: async () => {
      console.warn(`${freezeChannelName || "Stream"} appears frozen (freeze monitor)`);
      botState.setStreamStatus(freezeChannelName, "frozen");
      const mention = FREEZE_ALERT_ROLE_ID ? `<@&${FREEZE_ALERT_ROLE_ID}> ` : "";
      const channel = process.env.FREEZE_CHANNEL || "Stream";
      const content = `${mention}${channel} appears frozen`;
      try {
        const messages = await relaySystemMessage(content, DISCORD_CHANNEL_ID);
        if (messages?.length > 0) {
          botState.setFreezeMessage(
            freezeChannelName || "default",
            messages[0].id,
            messages[0].channel.id,
            messages[0].content
          );
        }
      } catch (error) {
        console.error("Failed to send freeze alert", error);
      }
    },
    onRecover: async () => {
      console.log(`${freezeChannelName || "Stream"} recovered from freeze (freeze monitor)`);
      botState.setStreamStatus(freezeChannelName, "online");
      const channel = process.env.FREEZE_CHANNEL || "Stream";

      // Edit the freeze message if it exists
      const freezeMsg = botState.getFreezeMessage(freezeChannelName || "default");
      if (freezeMsg) {
        try {
          const discordChannel = await discordClient.channels.fetch(freezeMsg.channelId);
          const message = await discordChannel.messages.fetch(freezeMsg.messageId);
          const originalText = freezeMsg.originalContent.replace("[SYSTEM] ", "");
          await message.edit(`[SYSTEM] ~~${originalText}~~ motion detected again`);
          botState.clearFreezeMessage(freezeChannelName || "default");
        } catch (error) {
          console.error("Failed to edit freeze message:", error);
          // Fall back to sending new message
          relaySystemMessage(`${channel} motion detected again`, DISCORD_CHANNEL_ID).catch(
            (err) => {
              console.error("Failed to send recovery alert", err);
            }
          );
        }
      } else {
        relaySystemMessage(`${channel} motion detected again`, DISCORD_CHANNEL_ID).catch(
          (error) => {
            console.error("Failed to send recovery alert", error);
          }
        );
      }
    },
    onOffline: () => {
      botState.setStreamStatus(freezeChannelName, "offline");
      console.log(`${freezeChannelName || "Stream"} appears offline (freeze monitor)`);
      // No Discord message - EventSub handles offline alerts
    },
    onOnline: () => {
      botState.setStreamStatus(freezeChannelName, "online");
      console.log(`${freezeChannelName || "Stream"} appears online (freeze monitor)`);
      // No Discord message - EventSub handles online by editing offline message
    }
  });

  // Initialize stream status for all channels
  try {
    const streamStatuses = await twitchAPIClient.getStreamStatus(botState.twitchChannels);
    for (const [channel, status] of streamStatuses) {
      botState.setStreamStatus(channel, status.live ? "online" : "offline");
      console.log(`Initial stream status for ${channel}: ${status.live ? "online" : "offline"}`);
    }
  } catch (error) {
    console.error("Failed to initialize stream status:", error.message);
  }

  // Schedule token refresh
  if (tokenInfo?.expiresIn) {
    scheduleTokenRefresh(tokenInfo.expiresIn, credentials, async (newTokenInfo) => {
      if (newTokenInfo?.oauthToken) {
        await connectTwitch(
          newTokenInfo.oauthToken,
          TWITCH_USERNAME,
          process.env,
          DISCORD_CHANNEL_ID
        );
      }
    });
  }
}

start().catch((error) => {
  console.error("Startup failed", error);
  process.exit(1);
});
