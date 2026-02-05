import { Router } from "express";
import botState from "../../state/BotState.js";
import { requireAuth, Permissions } from "../../auth/sessionManager.js";
import { loadMessages } from "../../chatHistoryStore.js";
import { loadConfig, updateConfigSection } from "../../configStore.js";

/**
 * Create chat feed API routes
 */
export function createChatRoutes() {
  const router = Router();

  /**
   * GET /api/chat/history - Get chat history for a channel (requires moderator)
   * Query params:
   *   channel - Channel name (required)
   *   limit - Max messages to return (default: 500, max: 1000)
   *   since - Timestamp to load messages since (optional)
   */
  router.get("/api/chat/history", requireAuth(Permissions.MODERATOR), async (req, res) => {
    const { channel, limit = "500", since = "0" } = req.query;

    if (!channel) {
      return res.status(400).json({ error: "Missing required 'channel' parameter" });
    }

    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 1000);
    const sinceNum = parseInt(since, 10) || 0;

    try {
      const messages = await loadMessages(channel, sinceNum, limitNum);
      res.json({
        channel,
        messages,
        count: messages.length
      });
    } catch (error) {
      console.error("Failed to load chat history:", error);
      res.status(500).json({ error: "Failed to load chat history" });
    }
  });

  /**
   * GET /api/chat/recent - Get recent chat from memory buffer (requires moderator)
   * Query params:
   *   channel - Channel name (optional, all if not specified)
   *   limit - Max messages to return (default: 200)
   */
  router.get("/api/chat/recent", requireAuth(Permissions.MODERATOR), (req, res) => {
    const { channel, limit = "200" } = req.query;
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);

    const messages = botState.getRecentChat(channel, limitNum);
    res.json({
      channel: channel || "all",
      messages,
      count: messages.length
    });
  });

  /**
   * GET /api/chat/ignored-users - Get ignored users list (requires moderator)
   */
  router.get("/api/chat/ignored-users", requireAuth(Permissions.MODERATOR), async (req, res) => {
    try {
      const config = await loadConfig();
      const ignoredUsers = config.chatFeed?.ignoredUsers || [];
      res.json({
        ignoredUsers,
        count: ignoredUsers.length
      });
    } catch (error) {
      console.error("Failed to load ignored users:", error);
      res.status(500).json({ error: "Failed to load ignored users" });
    }
  });

  /**
   * POST /api/chat/ignored-users - Add user to ignored list (requires moderator)
   * Body: { username: "username" }
   */
  router.post("/api/chat/ignored-users", requireAuth(Permissions.MODERATOR), async (req, res) => {
    const { username } = req.body;

    if (!username || typeof username !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'username' field" });
    }

    const trimmed = username.trim().toLowerCase();
    if (!trimmed) {
      return res.status(400).json({ error: "Username cannot be empty" });
    }

    try {
      const config = await loadConfig();
      const ignoredUsers = config.chatFeed?.ignoredUsers || [];

      // Check if already in list
      if (ignoredUsers.includes(trimmed)) {
        return res.json({
          success: false,
          message: `"${trimmed}" is already in the ignored users list`
        });
      }

      // Add to list
      ignoredUsers.push(trimmed);
      await updateConfigSection("chatFeed", { ignoredUsers });

      // Update runtime state
      botState.addIgnoredUser(trimmed);

      // Audit log
      const actor = req.session?.user?.username || "unknown";
      botState.recordAuditEvent("ignored_user_add", actor, {
        username: trimmed,
        total: ignoredUsers.length
      }, "dashboard");

      res.json({
        success: true,
        message: `Added "${trimmed}" to ignored users`,
        ignoredUsers,
        count: ignoredUsers.length
      });
    } catch (error) {
      console.error("Failed to add ignored user:", error);
      res.status(500).json({ error: "Failed to add ignored user" });
    }
  });

  /**
   * GET /api/chat/settings - Get chat feed settings (requires moderator)
   */
  router.get("/api/chat/settings", requireAuth(Permissions.MODERATOR), async (req, res) => {
    try {
      const config = await loadConfig();
      res.json({
        debug: config.chatFeed?.debug || false,
        retentionDays: config.chatFeed?.retentionDays || 3
      });
    } catch (error) {
      console.error("Failed to load chat settings:", error);
      res.status(500).json({ error: "Failed to load chat settings" });
    }
  });

  /**
   * PUT /api/chat/settings - Update chat feed settings (requires moderator)
   * Body: { debug?: boolean, retentionDays?: number }
   */
  router.put("/api/chat/settings", requireAuth(Permissions.MODERATOR), async (req, res) => {
    const { debug, retentionDays } = req.body;
    const updates = {};
    const changes = [];

    if (typeof debug === "boolean") {
      updates.debug = debug;
      changes.push(`debug: ${debug}`);
    }

    if (typeof retentionDays === "number" && retentionDays >= 1 && retentionDays <= 30) {
      updates.retentionDays = retentionDays;
      changes.push(`retentionDays: ${retentionDays}`);
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid settings provided" });
    }

    try {
      await updateConfigSection("chatFeed", updates);

      // Apply to runtime
      if (updates.debug !== undefined) {
        botState.chatFeedDebug = updates.debug;
      }

      // Audit log
      const actor = req.session?.user?.username || "unknown";
      botState.recordAuditEvent("config_update", actor, {
        section: "chatFeed",
        changes: updates
      }, "dashboard");

      res.json({
        success: true,
        message: `Updated chat settings: ${changes.join(", ")}`,
        settings: {
          debug: botState.chatFeedDebug,
          retentionDays: updates.retentionDays || 3
        }
      });
    } catch (error) {
      console.error("Failed to update chat settings:", error);
      res.status(500).json({ error: "Failed to update chat settings" });
    }
  });

  /**
   * DELETE /api/chat/ignored-users - Remove user from ignored list (requires moderator)
   * Body: { username: "username" }
   */
  router.delete("/api/chat/ignored-users", requireAuth(Permissions.MODERATOR), async (req, res) => {
    const { username } = req.body;

    if (!username || typeof username !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'username' field" });
    }

    const trimmed = username.trim().toLowerCase();
    if (!trimmed) {
      return res.status(400).json({ error: "Username cannot be empty" });
    }

    try {
      const config = await loadConfig();
      const ignoredUsers = config.chatFeed?.ignoredUsers || [];

      // Check if in list
      const index = ignoredUsers.indexOf(trimmed);
      if (index === -1) {
        return res.json({
          success: false,
          message: `"${trimmed}" is not in the ignored users list`
        });
      }

      // Remove from list
      ignoredUsers.splice(index, 1);
      await updateConfigSection("chatFeed", { ignoredUsers });

      // Update runtime state
      botState.removeIgnoredUser(trimmed);

      // Audit log
      const actor = req.session?.user?.username || "unknown";
      botState.recordAuditEvent("ignored_user_remove", actor, {
        username: trimmed,
        total: ignoredUsers.length
      }, "dashboard");

      res.json({
        success: true,
        message: `Removed "${trimmed}" from ignored users`,
        ignoredUsers,
        count: ignoredUsers.length
      });
    } catch (error) {
      console.error("Failed to remove ignored user:", error);
      res.status(500).json({ error: "Failed to remove ignored user" });
    }
  });

  return router;
}
