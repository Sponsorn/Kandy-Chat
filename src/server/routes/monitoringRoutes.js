import { Router } from "express";
import botState from "../../state/BotState.js";
import { requireAuth, Permissions } from "../../auth/sessionManager.js";

/**
 * Create monitoring API routes
 */
export function createMonitoringRoutes() {
  const router = Router();

  /**
   * GET /api/status - Bot status and connection info
   */
  router.get("/api/status", (req, res) => {
    const snapshot = botState.getSnapshot();
    res.json({
      status: "online",
      uptime: snapshot.uptime,
      uptimeString: snapshot.uptimeString,
      connections: snapshot.connections,
      channels: {
        twitch: snapshot.channels.twitch,
        discordCount: botState.discordChannels.length
      }
    });
  });

  /**
   * GET /api/metrics - Chat activity statistics
   */
  router.get("/api/metrics", (req, res) => {
    const snapshot = botState.getSnapshot();
    res.json({
      messagesRelayed: snapshot.metrics.messagesRelayed,
      messagesFiltered: snapshot.metrics.messagesFiltered,
      moderationActions: snapshot.metrics.moderationActions,
      lastMessageTime: snapshot.metrics.lastMessageTime,
      relayMapSize: snapshot.relayMapSize,
      blacklistCount: snapshot.blacklistCount
    });
  });

  /**
   * GET /api/stream - Stream and freeze status
   */
  router.get("/api/stream", (req, res) => {
    const snapshot = botState.getSnapshot();
    res.json({
      status: snapshot.metrics.streamStatus,
      freezeDetectedAt: snapshot.metrics.freezeDetectedAt
    });
  });

  /**
   * GET /api/modactions - Recent moderation actions (requires auth)
   */
  router.get("/api/modactions", requireAuth(Permissions.MODERATOR), (req, res) => {
    // Moderation actions are stored in memory for the current session
    // In a production system, these would be persisted to a database
    // For now, return empty array since we track metrics but not individual actions
    res.json({
      actions: [],
      total: botState.metrics.moderationActions,
      message: "Detailed action history requires database integration"
    });
  });

  /**
   * GET /api/messages - Recent relayed messages (requires auth)
   */
  router.get("/api/messages", requireAuth(Permissions.VIEWER), (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

    // Get recent relay entries from the map
    const entries = [];
    for (const [discordId, relay] of botState.relayDiscordMap.entries()) {
      entries.push({
        discordMessageId: discordId,
        twitchMessageId: relay.twitchMessageId,
        twitchChannel: relay.twitchChannel,
        twitchUsername: relay.twitchUsername,
        timestamp: relay.timestamp
      });
    }

    // Sort by timestamp descending and limit
    entries.sort((a, b) => b.timestamp - a.timestamp);
    const limited = entries.slice(0, limit);

    res.json({
      messages: limited,
      total: entries.length
    });
  });

  /**
   * GET /api/health - Simple health check
   */
  router.get("/api/health", (req, res) => {
    res.json({ ok: true, timestamp: Date.now() });
  });

  return router;
}
