import { Router } from "express";
import botState from "../../state/BotState.js";
import { requireAuth, Permissions } from "../../auth/sessionManager.js";
import { loadBlacklist, addBlacklistWord, removeBlacklistWord } from "../../blacklistStore.js";
import { loadConfig, updateConfigSection } from "../../configStore.js";

/**
 * Create configuration API routes
 * @param {Object} options - Options including updateBlacklistFromEntries callback
 */
export function createConfigRoutes(options = {}) {
  const { updateBlacklistFromEntries } = options;
  const router = Router();

  /**
   * GET /api/config - Get current configuration (requires moderator)
   */
  router.get("/api/config", requireAuth(Permissions.MODERATOR), (req, res) => {
    const snapshot = botState.getSnapshot();
    res.json({
      channels: snapshot.channels,
      filters: {
        suspiciousFlagEnabled: snapshot.config.suspiciousFlagEnabled,
        reactionTimeoutSeconds: snapshot.config.reactionTimeoutSeconds
      },
      alerts: {
        freezeAlertRoleId: snapshot.config.freezeAlertRoleId,
        streamAlertRoleId: snapshot.config.streamAlertRoleId
      }
    });
  });

  /**
   * PUT /api/config - Update configuration (requires admin)
   * Note: Most config changes require a restart to take effect
   */
  router.put("/api/config", requireAuth(Permissions.ADMIN), (req, res) => {
    // For now, runtime config changes are limited
    // Most settings are loaded from env at startup
    res.json({
      success: false,
      message: "Runtime configuration changes not yet implemented. Edit .env and restart."
    });
  });

  /**
   * GET /api/blacklist - Get blacklist entries (requires moderator)
   */
  router.get("/api/blacklist", requireAuth(Permissions.MODERATOR), async (req, res) => {
    try {
      const words = await loadBlacklist();

      // Separate into plain words and regex patterns
      const plain = [];
      const regex = [];
      for (const entry of words) {
        if (entry.startsWith("/")) {
          regex.push(entry);
        } else {
          plain.push(entry);
        }
      }

      res.json({
        words: plain,
        regex,
        total: words.length
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to load blacklist" });
    }
  });

  /**
   * POST /api/blacklist - Add blacklist entry (requires moderator)
   */
  router.post("/api/blacklist", requireAuth(Permissions.MODERATOR), async (req, res) => {
    const { word } = req.body;

    if (!word || typeof word !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'word' field" });
    }

    const trimmed = word.trim();
    if (!trimmed) {
      return res.status(400).json({ error: "Word cannot be empty" });
    }

    try {
      const result = await addBlacklistWord(trimmed);

      if (result.added) {
        // Update runtime filters
        if (updateBlacklistFromEntries) {
          updateBlacklistFromEntries(result.words);
        }

        // Emit event for WebSocket subscribers
        botState.emit("blacklist:updated", { action: "add", word: trimmed });

        // Audit log
        const actor = req.session?.user?.username || "unknown";
        botState.recordAuditEvent("blacklist_add", actor, {
          word: trimmed,
          total: result.words.length
        }, "dashboard");

        res.json({
          success: true,
          message: `Added "${trimmed}" to blacklist`,
          total: result.words.length
        });
      } else {
        res.json({
          success: false,
          message: `"${trimmed}" already in blacklist`
        });
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to add blacklist entry" });
    }
  });

  /**
   * DELETE /api/blacklist - Remove blacklist entry (requires moderator)
   */
  router.delete("/api/blacklist", requireAuth(Permissions.MODERATOR), async (req, res) => {
    const { word } = req.body;

    if (!word || typeof word !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'word' field" });
    }

    const trimmed = word.trim();
    if (!trimmed) {
      return res.status(400).json({ error: "Word cannot be empty" });
    }

    try {
      const result = await removeBlacklistWord(trimmed);

      if (result.removed) {
        // Update runtime filters
        if (updateBlacklistFromEntries) {
          updateBlacklistFromEntries(result.words);
        }

        // Emit event for WebSocket subscribers
        botState.emit("blacklist:updated", { action: "remove", word: trimmed });

        // Audit log
        const actor = req.session?.user?.username || "unknown";
        botState.recordAuditEvent("blacklist_remove", actor, {
          word: trimmed,
          total: result.words.length
        }, "dashboard");

        res.json({
          success: true,
          message: `Removed "${trimmed}" from blacklist`,
          total: result.words.length
        });
      } else {
        res.json({
          success: false,
          message: `"${trimmed}" not found in blacklist`
        });
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to remove blacklist entry" });
    }
  });

  /**
   * GET /api/channels - Get channel configuration (requires moderator)
   */
  router.get("/api/channels", requireAuth(Permissions.MODERATOR), (req, res) => {
    const snapshot = botState.getSnapshot();
    res.json(snapshot.channels);
  });

  /**
   * PUT /api/channels - Update channel configuration (requires admin)
   * Note: Channel changes require restart
   */
  router.put("/api/channels", requireAuth(Permissions.ADMIN), (req, res) => {
    res.json({
      success: false,
      message: "Runtime channel changes not supported. Edit TWITCH_CHANNEL in .env and restart."
    });
  });

  /**
   * GET /api/filters - Get filter settings (requires moderator)
   */
  router.get("/api/filters", requireAuth(Permissions.MODERATOR), (req, res) => {
    const { filters } = botState;
    res.json({
      blockCommands: filters?.blockCommands ?? true,
      blockEmotes: filters?.blockEmotes ?? false,
      onlyBlockedWords: filters?.onlyBlockedWords ?? false,
      blockedWordsCount: filters?.blockedWords?.length ?? 0,
      blockedRegexCount: filters?.blockedRegexes?.length ?? 0,
      allowedUsersCount: filters?.allowedUsers?.length ?? 0,
      blockedUsersCount: filters?.blockedUsers?.length ?? 0
    });
  });

  /**
   * PUT /api/filters - Update filter settings (requires admin)
   * Supports runtime changes for: blockCommands, blockEmotes, suspiciousFlagEnabled
   */
  router.put("/api/filters", requireAuth(Permissions.ADMIN), async (req, res) => {
    const { blockCommands, blockEmotes, suspiciousFlagEnabled } = req.body;
    const updates = {};
    const changes = [];

    // Validate and collect updates
    if (typeof blockCommands === "boolean") {
      updates.blockCommands = blockCommands;
      changes.push(`blockCommands: ${blockCommands}`);
    }
    if (typeof blockEmotes === "boolean") {
      updates.blockEmotes = blockEmotes;
      changes.push(`blockEmotes: ${blockEmotes}`);
    }
    if (typeof suspiciousFlagEnabled === "boolean") {
      updates.suspiciousFlagEnabled = suspiciousFlagEnabled;
      changes.push(`suspiciousFlagEnabled: ${suspiciousFlagEnabled}`);
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        error: "No valid filter settings provided. Expected: blockCommands, blockEmotes, or suspiciousFlagEnabled (boolean)"
      });
    }

    try {
      // Persist to config file
      await updateConfigSection("filters", updates);

      // Apply to runtime state
      for (const [key, value] of Object.entries(updates)) {
        botState.updateRuntimeConfig("filters", key, value);
      }

      // Audit log
      const actor = req.session?.user?.username || "unknown";
      botState.recordAuditEvent("config_update", actor, {
        section: "filters",
        changes: updates
      }, "dashboard");

      // Emit event for WebSocket subscribers
      botState.emit("runtimeConfig:updated", { section: "filters", updates });

      res.json({
        success: true,
        message: `Updated filter settings: ${changes.join(", ")}`,
        filters: {
          blockCommands: botState.filters?.blockCommands ?? true,
          blockEmotes: botState.filters?.blockEmotes ?? false,
          suspiciousFlagEnabled: botState.config.suspiciousFlagEnabled
        }
      });
    } catch (error) {
      console.error("Failed to update filters:", error);
      res.status(500).json({ error: "Failed to update filter settings" });
    }
  });

  /**
   * GET /api/subscription-messages - Get subscription message templates (requires moderator)
   */
  router.get("/api/subscription-messages", requireAuth(Permissions.MODERATOR), async (req, res) => {
    try {
      const config = await loadConfig();
      res.json({
        sub: config.subscriptionMessages?.sub || {
          enabled: null,
          message: "hype Welcome to Kandyland, {user}! kandyKiss"
        },
        resub: config.subscriptionMessages?.resub || {
          enabled: null,
          message: "hype Welcome back to Kandyland, {user}! kandyKiss"
        },
        giftSub: config.subscriptionMessages?.giftSub || {
          enabled: null,
          messageSingle: "Thank you for gifting to {recipient}, {user}! kandyHype",
          messageMultiple: "Thank you for gifting to {recipient_count} users, {user}! kandyHype"
        },
        availableTags: {
          all: ["user", "tier", "channel"],
          resub: ["months", "streak_months", "message"],
          giftSub: {
            single: ["recipient"],
            multiple: ["recipient_count"]
          }
        }
      });
    } catch (error) {
      console.error("Failed to load subscription messages:", error);
      res.status(500).json({ error: "Failed to load subscription message templates" });
    }
  });

  /**
   * PUT /api/subscription-messages - Update subscription message templates (requires admin)
   */
  router.put("/api/subscription-messages", requireAuth(Permissions.ADMIN), async (req, res) => {
    const { sub, resub, giftSub } = req.body;
    const updates = {};
    const changes = [];

    // Validate sub config
    if (sub !== undefined) {
      if (typeof sub !== "object") {
        return res.status(400).json({ error: "sub must be an object" });
      }
      updates.sub = {};
      if (typeof sub.enabled === "boolean") {
        updates.sub.enabled = sub.enabled;
        changes.push(`sub.enabled: ${sub.enabled}`);
      }
      if (typeof sub.message === "string") {
        updates.sub.message = sub.message;
        changes.push("sub.message updated");
      }
    }

    // Validate resub config
    if (resub !== undefined) {
      if (typeof resub !== "object") {
        return res.status(400).json({ error: "resub must be an object" });
      }
      updates.resub = {};
      if (typeof resub.enabled === "boolean") {
        updates.resub.enabled = resub.enabled;
        changes.push(`resub.enabled: ${resub.enabled}`);
      }
      if (typeof resub.message === "string") {
        updates.resub.message = resub.message;
        changes.push("resub.message updated");
      }
    }

    // Validate giftSub config
    if (giftSub !== undefined) {
      if (typeof giftSub !== "object") {
        return res.status(400).json({ error: "giftSub must be an object" });
      }
      updates.giftSub = {};
      if (typeof giftSub.enabled === "boolean") {
        updates.giftSub.enabled = giftSub.enabled;
        changes.push(`giftSub.enabled: ${giftSub.enabled}`);
      }
      if (typeof giftSub.messageSingle === "string") {
        updates.giftSub.messageSingle = giftSub.messageSingle;
        changes.push("giftSub.messageSingle updated");
      }
      if (typeof giftSub.messageMultiple === "string") {
        updates.giftSub.messageMultiple = giftSub.messageMultiple;
        changes.push("giftSub.messageMultiple updated");
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        error: "No valid subscription message settings provided"
      });
    }

    try {
      // Persist to config file
      const newConfig = await updateConfigSection("subscriptionMessages", updates);

      // Apply to runtime state
      botState.setRuntimeConfig({ subscriptionMessages: newConfig.subscriptionMessages });

      // Audit log
      const actor = req.session?.user?.username || "unknown";
      botState.recordAuditEvent("config_update", actor, {
        section: "subscriptionMessages",
        changes: changes
      }, "dashboard");

      // Emit event for WebSocket subscribers
      botState.emit("runtimeConfig:updated", { section: "subscriptionMessages", updates });

      res.json({
        success: true,
        message: `Updated subscription messages: ${changes.join(", ")}`,
        subscriptionMessages: newConfig.subscriptionMessages
      });
    } catch (error) {
      console.error("Failed to update subscription messages:", error);
      res.status(500).json({ error: "Failed to update subscription message templates" });
    }
  });

  return router;
}
