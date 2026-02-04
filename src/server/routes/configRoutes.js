import { Router } from "express";
import botState from "../../state/BotState.js";
import { requireAuth, Permissions } from "../../auth/sessionManager.js";
import { loadBlacklist, addBlacklistWord, removeBlacklistWord } from "../../blacklistStore.js";

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
   * Note: Filter changes require restart
   */
  router.put("/api/filters", requireAuth(Permissions.ADMIN), (req, res) => {
    res.json({
      success: false,
      message: "Runtime filter changes not supported. Edit FILTER_* in .env and restart."
    });
  });

  return router;
}
