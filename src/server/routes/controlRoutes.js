import { Router } from "express";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import botState from "../../state/BotState.js";
import { requireAuth, Permissions } from "../../auth/sessionManager.js";

const STOP_FLAG_PATH = join(process.cwd(), "data", ".stopped");

/**
 * Create control API routes
 * @param {Object} options - Options including twitchAPIClient
 */
export function createControlRoutes(options = {}) {
  const { twitchAPIClient } = options;
  const router = Router();

  /**
   * GET /api/audit - Get audit log entries (requires admin)
   */
  router.get("/api/audit", requireAuth(Permissions.ADMIN), (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;

    const entries = botState.getAuditLog(limit, offset);
    const total = botState.auditLog.length;

    res.json({
      entries,
      total,
      limit,
      offset
    });
  });

  /**
   * POST /api/control/restart - Restart the bot (requires admin)
   */
  router.post("/api/control/restart", requireAuth(Permissions.ADMIN), (req, res) => {
    const actor = req.session?.user?.username || "unknown";

    // Log the restart action
    botState.recordAuditEvent("restart", actor, {
      reason: req.body?.reason || "Manual restart from dashboard"
    }, "dashboard");

    // Remove stop flag if it exists
    try {
      if (existsSync(STOP_FLAG_PATH)) {
        unlinkSync(STOP_FLAG_PATH);
      }
    } catch (error) {
      console.warn("Failed to remove stop flag:", error.message);
    }

    res.json({
      success: true,
      message: "Restarting bot..."
    });

    // Exit after response is sent
    setTimeout(() => {
      console.log("Restart command received from dashboard, exiting process...");
      process.exit(1);
    }, 500);
  });

  /**
   * POST /api/control/stop - Stop the bot (requires admin)
   */
  router.post("/api/control/stop", requireAuth(Permissions.ADMIN), (req, res) => {
    const actor = req.session?.user?.username || "unknown";

    // Log the stop action
    botState.recordAuditEvent("stop", actor, {
      reason: req.body?.reason || "Manual stop from dashboard"
    }, "dashboard");

    // Write stop flag to prevent restart
    try {
      writeFileSync(STOP_FLAG_PATH, new Date().toISOString(), "utf8");
    } catch (error) {
      console.error("Failed to write stop flag:", error.message);
      return res.status(500).json({
        success: false,
        error: "Failed to write stop flag"
      });
    }

    res.json({
      success: true,
      message: "Stopping bot..."
    });

    // Exit after response is sent
    setTimeout(() => {
      console.log("Stop command received from dashboard, exiting process...");
      process.exit(0);
    }, 500);
  });

  /**
   * POST /api/mod/delete - Delete a Twitch message (requires moderator)
   */
  router.post("/api/mod/delete", requireAuth(Permissions.MODERATOR), async (req, res) => {
    const { channel, messageId } = req.body;

    if (!channel || !messageId) {
      return res.status(400).json({ error: "Missing channel or messageId" });
    }

    if (!twitchAPIClient) {
      return res.status(503).json({ error: "Twitch API client not available" });
    }

    try {
      await twitchAPIClient.deleteMessage(channel, messageId);

      botState.recordModerationAction("delete", req.session?.user?.username || "dashboard", "unknown", {
        channel,
        messageId
      });

      res.json({ success: true, message: "Message deleted" });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/mod/timeout - Timeout a user (requires moderator)
   */
  router.post("/api/mod/timeout", requireAuth(Permissions.MODERATOR), async (req, res) => {
    const { channel, username, duration } = req.body;

    if (!channel || !username) {
      return res.status(400).json({ error: "Missing channel or username" });
    }

    if (!twitchAPIClient) {
      return res.status(503).json({ error: "Twitch API client not available" });
    }

    const seconds = parseInt(duration, 10) || botState.config.reactionTimeoutSeconds;

    try {
      await twitchAPIClient.timeoutUser(channel, username, seconds);

      botState.recordModerationAction("timeout", req.session?.user?.username || "dashboard", username, {
        channel,
        duration: seconds
      });

      res.json({ success: true, message: `User ${username} timed out for ${seconds} seconds` });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/mod/ban - Ban a user (requires moderator)
   */
  router.post("/api/mod/ban", requireAuth(Permissions.MODERATOR), async (req, res) => {
    const { channel, username } = req.body;

    if (!channel || !username) {
      return res.status(400).json({ error: "Missing channel or username" });
    }

    if (!twitchAPIClient) {
      return res.status(503).json({ error: "Twitch API client not available" });
    }

    try {
      await twitchAPIClient.banUser(channel, username);

      botState.recordModerationAction("ban", req.session?.user?.username || "dashboard", username, {
        channel
      });

      res.json({ success: true, message: `User ${username} banned` });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/mod/warn - Warn a user (requires moderator)
   */
  router.post("/api/mod/warn", requireAuth(Permissions.MODERATOR), async (req, res) => {
    const { channel, username, reason } = req.body;

    if (!channel || !username) {
      return res.status(400).json({ error: "Missing channel or username" });
    }

    if (!twitchAPIClient) {
      return res.status(503).json({ error: "Twitch API client not available" });
    }

    const warnReason = reason || "Violating community guidelines";

    try {
      await twitchAPIClient.warnUser(channel, username, warnReason);

      botState.recordModerationAction("warn", req.session?.user?.username || "dashboard", username, {
        channel,
        reason: warnReason
      });

      res.json({ success: true, message: `User ${username} warned` });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
