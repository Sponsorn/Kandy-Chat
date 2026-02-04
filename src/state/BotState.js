import { EventEmitter } from "node:events";

/**
 * Centralized bot state singleton
 * Holds all runtime state and provides event-driven updates for dashboard integration
 */
class BotState extends EventEmitter {
  constructor() {
    super();

    // Clients
    this.discordClient = null;
    this.twitchClient = null;

    // Discord channels
    this.discordChannels = [];

    // Twitch channel configuration
    this.twitchChannels = [];
    this.relayChannels = null; // Set of channels to relay, or null for all
    this.channelMapping = new Map(); // Twitch channel -> Discord channel ID

    // Message relay maps
    this.relayMessageMap = new Map(); // Twitch message ID -> Discord info
    this.relayDiscordMap = new Map(); // Discord message ID -> Twitch info
    this.recentRaids = new Map(); // channel (lowercase) -> timestamp

    // Token management
    this.currentOAuthToken = null;
    this.currentAccessToken = null;
    this.currentRefreshToken = null;

    // Filters and blacklist
    this.filters = null;
    this.baseBlockedWords = [];
    this.runtimeBlacklist = new Set();
    this.blacklistRegexMap = new Map();

    // Bot metadata
    this.startTime = Date.now();

    // Subscription batching
    this.giftSubBatches = new Map();

    // Metrics for dashboard
    this.metrics = {
      messagesRelayed: 0,
      messagesFiltered: 0,
      moderationActions: 0,
      lastMessageTime: null,
      streamStatus: "unknown", // "online", "offline", "frozen", "unknown"
      freezeDetectedAt: null
    };

    // Configuration cache
    this.config = {
      freezeAlertRoleId: null,
      streamAlertRoleId: null,
      suspiciousFlagEnabled: true,
      reactionEmojis: {
        delete: null,
        timeout: null,
        ban: null,
        warn: null
      },
      reactionTimeoutSeconds: 60
    };
  }

  /**
   * Initialize state from environment variables
   */
  initFromEnv(env) {
    this.config.freezeAlertRoleId = env.FREEZE_ALERT_ROLE_ID || null;
    this.config.streamAlertRoleId = env.STREAM_ALERT_ROLE_ID || null;
    this.config.suspiciousFlagEnabled = env.SUSPICIOUS_FLAG_ENABLED?.toLowerCase() !== "false";
    this.config.reactionEmojis = {
      delete: env.REACTION_DELETE_EMOJI || null,
      timeout: env.REACTION_TIMEOUT_EMOJI || null,
      ban: env.REACTION_BAN_EMOJI || null,
      warn: env.REACTION_WARN_EMOJI || null
    };
    this.config.reactionTimeoutSeconds = parseInt(env.REACTION_TIMEOUT_SECONDS, 10) || 60;

    // Parse Twitch channels
    if (env.TWITCH_CHANNEL) {
      this.twitchChannels = env.TWITCH_CHANNEL.split(",").map(ch => ch.trim().toLowerCase()).filter(Boolean);
    }

    // Parse relay channels filter
    if (env.TWITCH_RELAY_CHANNELS) {
      this.relayChannels = new Set(
        env.TWITCH_RELAY_CHANNELS.split(",").map(ch => ch.trim().toLowerCase()).filter(Boolean)
      );
    }

    // Parse channel mapping
    if (env.TWITCH_CHANNEL_MAPPING) {
      env.TWITCH_CHANNEL_MAPPING.split(",").forEach(mapping => {
        const [twitchCh, discordCh] = mapping.split(":").map(s => s.trim());
        if (twitchCh && discordCh) {
          this.channelMapping.set(twitchCh.toLowerCase(), discordCh);
        }
      });
    }

    // Initialize tokens
    this.currentOAuthToken = env.TWITCH_OAUTH || null;
    this.currentRefreshToken = env.TWITCH_REFRESH_TOKEN || null;
  }

  /**
   * Set Discord client
   */
  setDiscordClient(client) {
    this.discordClient = client;
    this.emit("discord:connected", client);
  }

  /**
   * Set Twitch client
   */
  setTwitchClient(client) {
    this.twitchClient = client;
    this.emit("twitch:connected", client);
  }

  /**
   * Update tokens after refresh
   */
  updateTokens({ oauthToken, accessToken, refreshToken }) {
    if (oauthToken) this.currentOAuthToken = oauthToken;
    if (accessToken) this.currentAccessToken = accessToken;
    if (refreshToken) this.currentRefreshToken = refreshToken;
    this.emit("tokens:updated");
  }

  /**
   * Get current access token (without oauth: prefix)
   */
  getAccessToken() {
    if (this.currentAccessToken) return this.currentAccessToken;
    return this.currentOAuthToken?.replace(/^oauth:/, "") || null;
  }

  /**
   * Record a relayed message mapping
   */
  addRelayMapping(twitchMessageId, discordMessageId, discordChannelId, twitchChannel, twitchUsername) {
    const now = Date.now();
    this.relayMessageMap.set(twitchMessageId, {
      discordMessageId,
      discordChannelId,
      timestamp: now
    });
    this.relayDiscordMap.set(discordMessageId, {
      twitchMessageId,
      twitchChannel,
      twitchUsername,
      timestamp: now
    });
    this.metrics.messagesRelayed++;
    this.metrics.lastMessageTime = now;
    this.emit("message:relayed", { twitchMessageId, discordMessageId, twitchChannel, twitchUsername });
  }

  /**
   * Get relay info by Discord message ID
   */
  getRelayByDiscordId(discordMessageId) {
    return this.relayDiscordMap.get(discordMessageId) || null;
  }

  /**
   * Get relay info by Twitch message ID
   */
  getRelayByTwitchId(twitchMessageId) {
    return this.relayMessageMap.get(twitchMessageId) || null;
  }

  /**
   * Remove relay mappings
   */
  removeRelayMapping(twitchMessageId, discordMessageId) {
    this.relayMessageMap.delete(twitchMessageId);
    this.relayDiscordMap.delete(discordMessageId);
  }

  /**
   * Record a moderation action
   */
  recordModerationAction(action, moderator, target, details = {}) {
    this.metrics.moderationActions++;
    this.emit("mod:action", { action, moderator, target, details, timestamp: Date.now() });
  }

  /**
   * Record a filtered message
   */
  recordFilteredMessage() {
    this.metrics.messagesFiltered++;
  }

  /**
   * Update stream status
   */
  setStreamStatus(status) {
    const prevStatus = this.metrics.streamStatus;
    this.metrics.streamStatus = status;
    if (status === "frozen") {
      this.metrics.freezeDetectedAt = Date.now();
    } else if (prevStatus === "frozen") {
      this.metrics.freezeDetectedAt = null;
    }
    this.emit("stream:status", { status, prevStatus });
  }

  /**
   * Record a raid for offline suppression
   */
  recordRaid(channel) {
    this.recentRaids.set(channel.toLowerCase(), Date.now());
    this.emit("raid:detected", { channel });
  }

  /**
   * Check if a channel raided recently
   */
  hasRecentRaid(channel, windowMs) {
    const raidTime = this.recentRaids.get(channel.toLowerCase());
    if (!raidTime) return false;
    return Date.now() - raidTime < windowMs;
  }

  /**
   * Clean up expired entries
   */
  cleanupExpired(relayCacheTtlMs, raidTtlMs) {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, value] of this.relayMessageMap.entries()) {
      if (now - (value.timestamp || 0) > relayCacheTtlMs) {
        this.relayMessageMap.delete(key);
        cleaned++;
      }
    }

    for (const [key, value] of this.relayDiscordMap.entries()) {
      if (now - (value.timestamp || 0) > relayCacheTtlMs) {
        this.relayDiscordMap.delete(key);
        cleaned++;
      }
    }

    for (const [channel, timestamp] of this.recentRaids.entries()) {
      if (now - timestamp > raidTtlMs) {
        this.recentRaids.delete(channel);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Update filters
   */
  setFilters(filters, baseBlockedWords = []) {
    this.filters = filters;
    this.baseBlockedWords = [...baseBlockedWords];
    this.emit("filters:updated");
  }

  /**
   * Update blacklist
   */
  updateBlacklist(entries, parseRegexFn) {
    this.runtimeBlacklist.clear();
    this.blacklistRegexMap.clear();

    if (this.filters) {
      this.filters.blockedWords = [...this.baseBlockedWords];
      this.filters.blockedRegexes = [];
    }

    for (const entry of entries) {
      const trimmed = (entry ?? "").toString().trim();
      if (!trimmed) continue;
      this.runtimeBlacklist.add(trimmed);

      if (parseRegexFn) {
        const regex = parseRegexFn(trimmed);
        if (regex) {
          this.blacklistRegexMap.set(trimmed, regex);
          if (this.filters) this.filters.blockedRegexes.push(regex);
        } else if (this.filters) {
          this.filters.blockedWords.push(trimmed);
        }
      }
    }

    this.emit("blacklist:updated", { count: entries.length });
  }

  /**
   * Get bot uptime in milliseconds
   */
  getUptime() {
    return Date.now() - this.startTime;
  }

  /**
   * Get formatted uptime string
   */
  getUptimeString() {
    const uptimeMs = this.getUptime();
    const uptimeSeconds = Math.floor(uptimeMs / 1000);
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = uptimeSeconds % 60;

    let str = "";
    if (hours > 0) str += `${hours}h `;
    if (minutes > 0 || hours > 0) str += `${minutes}m `;
    str += `${seconds}s`;
    return str.trim();
  }

  /**
   * Get snapshot for dashboard
   */
  getSnapshot() {
    return {
      uptime: this.getUptime(),
      uptimeString: this.getUptimeString(),
      metrics: { ...this.metrics },
      config: { ...this.config },
      channels: {
        twitch: [...this.twitchChannels],
        relayFilter: this.relayChannels ? [...this.relayChannels] : null,
        mapping: Object.fromEntries(this.channelMapping)
      },
      connections: {
        discord: !!this.discordClient?.isReady(),
        twitch: !!this.twitchClient?.readyState() === "OPEN"
      },
      blacklistCount: this.runtimeBlacklist.size,
      relayMapSize: this.relayMessageMap.size
    };
  }
}

// Singleton instance
const botState = new BotState();

export default botState;
export { BotState };
