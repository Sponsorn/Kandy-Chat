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

    // Chat feed
    this.chatBuffer = []; // Recent messages in memory (last 500)
    this.chatIgnoredUsers = new Set(); // Usernames to ignore (lowercase)
    this.maxChatBuffer = 500;
    this.chatFeedDebug = false;

    // Runtime configuration (overrides env defaults when set)
    this.runtimeConfig = {
      filters: {},
      subscriptionMessages: {}
    };

    // Metrics for dashboard
    this.metrics = {
      messagesRelayed: 0,
      messagesFiltered: 0,
      moderationActions: 0,
      lastMessageTime: null,
      streamStatus: "unknown", // Legacy: "online", "offline", "frozen", "unknown"
      freezeDetectedAt: null,
      streamStatusByChannel: {}, // { "kandyland": "online", "kandylandvods": "offline" }
      freezeDetectedByChannel: {} // { "kandyland": null, "kandylandvods": 1234567890 }
    };

    // Audit log for admin actions
    this.auditLog = [];
    this.maxAuditLogEntries = 500;

    // Offline message tracking for edit-on-recovery
    this.offlineMessageIds = new Map(); // channel -> { messageId, channelId, originalContent }

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
   * Record an audit log entry for admin/system actions
   * @param {string} action - Action type (restart, stop, config_change, etc.)
   * @param {string} actor - Username or "system" who performed the action
   * @param {object} details - Additional details about the action
   * @param {string} source - Source of the action (discord, dashboard, system)
   */
  recordAuditEvent(action, actor, details = {}, source = "system") {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      action,
      actor,
      details,
      source,
      timestamp: Date.now()
    };

    this.auditLog.unshift(entry);

    // Trim to max entries
    if (this.auditLog.length > this.maxAuditLogEntries) {
      this.auditLog = this.auditLog.slice(0, this.maxAuditLogEntries);
    }

    this.emit("audit:event", entry);
    return entry;
  }

  /**
   * Get audit log entries
   * @param {number} limit - Max entries to return
   * @param {number} offset - Offset for pagination
   */
  getAuditLog(limit = 50, offset = 0) {
    return this.auditLog.slice(offset, offset + limit);
  }

  /**
   * Record a filtered message
   */
  recordFilteredMessage() {
    this.metrics.messagesFiltered++;
  }

  /**
   * Update stream status for a specific channel
   * @param {string} channel - Twitch channel name (lowercase)
   * @param {string} status - Status: "online", "offline", "frozen", "unknown"
   */
  setStreamStatus(channel, status) {
    if (!channel) {
      // Legacy fallback: update global status
      const prevStatus = this.metrics.streamStatus;
      this.metrics.streamStatus = status;
      if (status === "frozen") {
        this.metrics.freezeDetectedAt = Date.now();
      } else if (prevStatus === "frozen") {
        this.metrics.freezeDetectedAt = null;
      }
      this.emit("stream:status", { status, prevStatus });
      return;
    }

    const channelLower = channel.toLowerCase();
    const prevStatus = this.metrics.streamStatusByChannel[channelLower];
    this.metrics.streamStatusByChannel[channelLower] = status;

    if (status === "frozen") {
      this.metrics.freezeDetectedByChannel[channelLower] = Date.now();
    } else if (prevStatus === "frozen") {
      this.metrics.freezeDetectedByChannel[channelLower] = null;
    }

    // Also update legacy global status for backwards compatibility
    this.metrics.streamStatus = status;
    if (status === "frozen") {
      this.metrics.freezeDetectedAt = Date.now();
    } else if (prevStatus === "frozen") {
      this.metrics.freezeDetectedAt = null;
    }

    this.emit("stream:status", { channel: channelLower, status, prevStatus });
  }

  /**
   * Store offline message info for later editing when stream comes back online
   */
  setOfflineMessage(channel, messageId, channelId, originalContent) {
    this.offlineMessageIds.set(channel.toLowerCase(), { messageId, channelId, originalContent });
  }

  /**
   * Get stored offline message info for a channel
   */
  getOfflineMessage(channel) {
    return this.offlineMessageIds.get(channel.toLowerCase());
  }

  /**
   * Clear stored offline message after editing
   */
  clearOfflineMessage(channel) {
    this.offlineMessageIds.delete(channel.toLowerCase());
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
   * Set runtime configuration from loaded data
   * @param {Object} config - Configuration object from configStore
   */
  setRuntimeConfig(config) {
    if (config.filters) {
      this.runtimeConfig.filters = { ...config.filters };
    }
    if (config.subscriptionMessages) {
      this.runtimeConfig.subscriptionMessages = { ...config.subscriptionMessages };
    }
    this.emit("runtimeConfig:updated", { config: this.runtimeConfig });
  }

  /**
   * Update a specific runtime config section
   * @param {string} section - Section name (filters, subscriptionMessages)
   * @param {string} key - Key within the section
   * @param {*} value - Value to set
   */
  updateRuntimeConfig(section, key, value) {
    if (!this.runtimeConfig[section]) {
      this.runtimeConfig[section] = {};
    }
    this.runtimeConfig[section][key] = value;

    // Apply filter changes immediately if applicable
    if (section === "filters" && this.filters) {
      if (key === "blockCommands" && value !== null) {
        this.filters.blockCommands = value;
      } else if (key === "blockEmotes" && value !== null) {
        this.filters.blockEmotes = value;
      } else if (key === "suspiciousFlagEnabled" && value !== null) {
        this.filters.suspiciousFlagEnabled = value;
      }
    }

    // Apply suspicious flag change to config
    if (section === "filters" && key === "suspiciousFlagEnabled" && value !== null) {
      this.config.suspiciousFlagEnabled = value;
    }

    this.emit("runtimeConfig:updated", { section, key, value });
  }

  /**
   * Get effective config value, preferring runtime over env default
   * @param {string} section - Section name
   * @param {string} key - Key within the section
   * @param {*} envDefault - Default value from environment
   * @returns {*} Effective value
   */
  getEffectiveConfig(section, key, envDefault) {
    const runtimeValue = this.runtimeConfig[section]?.[key];
    // Only use runtime value if it's explicitly set (not null/undefined)
    if (runtimeValue !== null && runtimeValue !== undefined) {
      return runtimeValue;
    }
    return envDefault;
  }

  /**
   * Get full subscription message config for a type
   * @param {string} type - sub, resub, or giftSub
   * @returns {Object} Message configuration
   */
  getSubscriptionMessageConfig(type) {
    return this.runtimeConfig.subscriptionMessages?.[type] || {};
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
   * Add a chat message to the buffer
   * @param {Object} messageData - Message data with id, timestamp, channel, username, displayName, message, badges, relayed
   * @returns {boolean} True if message was added, false if user is ignored
   */
  addChatMessage(messageData) {
    // Check if user is ignored
    const username = messageData.username?.toLowerCase();
    if (username && this.chatIgnoredUsers.has(username)) {
      return false;
    }

    this.chatBuffer.push(messageData);
    if (this.chatBuffer.length > this.maxChatBuffer) {
      this.chatBuffer.shift();
    }

    this.emit("chat:message", messageData);
    return true;
  }

  /**
   * Mark a message as relayed in the chat buffer
   * @param {string} messageId - The message ID to mark as relayed
   * @returns {boolean} True if message was found and updated
   */
  markMessageRelayed(messageId) {
    for (const msg of this.chatBuffer) {
      if (msg.id === messageId) {
        msg.relayed = true;
        return true;
      }
    }
    return false;
  }

  /**
   * Get recent chat messages
   * @param {string} channel - Optional channel filter
   * @param {number} limit - Maximum messages to return
   * @returns {Array} Recent messages
   */
  getRecentChat(channel = null, limit = 200) {
    let msgs = this.chatBuffer;
    if (channel) {
      const normalizedChannel = channel.toLowerCase().replace(/^#/, "");
      msgs = msgs.filter(m => m.channel === normalizedChannel);
    }
    return msgs.slice(-limit);
  }

  /**
   * Set the list of ignored users
   * @param {Array<string>} users - Array of usernames to ignore
   */
  setIgnoredUsers(users) {
    this.chatIgnoredUsers = new Set(users.map(u => u.toLowerCase()));
  }

  /**
   * Add a user to the ignored list
   * @param {string} username - Username to ignore
   */
  addIgnoredUser(username) {
    this.chatIgnoredUsers.add(username.toLowerCase());
  }

  /**
   * Remove a user from the ignored list
   * @param {string} username - Username to unignore
   */
  removeIgnoredUser(username) {
    this.chatIgnoredUsers.delete(username.toLowerCase());
  }

  /**
   * Get the list of ignored users
   * @returns {Array<string>} Array of ignored usernames
   */
  getIgnoredUsers() {
    return Array.from(this.chatIgnoredUsers);
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
        // Strip # prefix that tmi.js adds to channel names
        twitch: this.twitchChannels.map(ch => ch.replace(/^#/, "")),
        relayFilter: this.relayChannels ? [...this.relayChannels] : null,
        mapping: Object.fromEntries(this.channelMapping)
      },
      connections: {
        discord: !!this.discordClient?.isReady(),
        twitch: this.twitchClient?.readyState() === "OPEN"
      },
      blacklistCount: this.runtimeBlacklist.size,
      relayMapSize: this.relayMessageMap.size,
      runtimeConfig: { ...this.runtimeConfig }
    };
  }
}

// Singleton instance
const botState = new BotState();

export default botState;
export { BotState };
