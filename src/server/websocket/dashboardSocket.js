import { WebSocketServer } from "ws";
import botState from "../../state/BotState.js";
import { getSession, Permissions } from "../../auth/sessionManager.js";
import { loadMessages } from "../../chatHistoryStore.js";

/**
 * Create WebSocket server for real-time dashboard updates
 * @param {Object} server - HTTP server to attach to
 * @returns {WebSocketServer} WebSocket server instance
 */
export function createDashboardSocket(server) {
  const wss = new WebSocketServer({
    server,
    path: "/ws"
  });

  // Track connected clients with their sessions
  const clients = new Map();

  wss.on("connection", async (ws, req) => {
    // Extract session from cookie
    const cookies = req.headers.cookie || "";
    const sessionMatch = cookies.match(/session=([^;]+)/);
    const sessionId = sessionMatch ? sessionMatch[1] : null;
    const session = getSession(sessionId);

    // Determine permission level (allow VIEWER connections with limited data)
    const permission = session?.permission ?? Permissions.VIEWER;

    // Store client info
    const clientInfo = {
      ws,
      session,
      permission,
      subscribedEvents: new Set(["stream:status", "status:update", "chat:message"]) // Default subscriptions for all users
    };
    clients.set(ws, clientInfo);

    console.log(`WebSocket client connected (permission: ${clientInfo.permission})`);

    // Load chat history from storage for each channel
    let recentChat = [];
    try {
      const channels = botState.twitchChannels || [];
      const historyPromises = channels.map((ch) =>
        loadMessages(ch.replace(/^#/, ""), 0, 250).catch(() => [])
      );
      const channelHistories = await Promise.all(historyPromises);

      // Merge all channel histories
      for (const history of channelHistories) {
        recentChat.push(...history);
      }

      // Sort by timestamp and limit
      recentChat.sort((a, b) => a.timestamp - b.timestamp);
      recentChat = recentChat.slice(-500);

      // Merge with in-memory buffer (may have newer messages not yet flushed)
      const memoryChat = botState.getRecentChat(null, 200);
      const seenIds = new Set(recentChat.map((m) => m.id));
      for (const msg of memoryChat) {
        if (!seenIds.has(msg.id)) {
          recentChat.push(msg);
        }
      }

      // Final sort
      recentChat.sort((a, b) => a.timestamp - b.timestamp);
    } catch (error) {
      console.error("Failed to load chat history for WebSocket init:", error);
      recentChat = botState.getRecentChat(null, 200);
    }

    // Send initial state
    const initData = {
      connected: true,
      permission: clientInfo.permission,
      status: botState.getSnapshot(),
      recentChat
    };

    // Include recent mod actions for moderator+ clients
    if (clientInfo.permission >= Permissions.MODERATOR) {
      initData.recentModActions = botState.modActions.slice(0, 100);
    }

    // Include recent logs for admin clients
    if (clientInfo.permission >= Permissions.ADMIN) {
      initData.recentLogs = botState.logBuffer.slice(-500);
    }

    sendToClient(ws, {
      type: "init",
      data: initData
    });

    // Handle incoming messages
    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        handleClientMessage(clientInfo, message);
      } catch (error) {
        console.warn("Invalid WebSocket message:", error.message);
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
      console.log("WebSocket client disconnected");
    });

    ws.on("error", (error) => {
      console.warn("WebSocket error:", error.message);
      clients.delete(ws);
    });
  });

  /**
   * Handle messages from clients
   */
  function handleClientMessage(clientInfo, message) {
    const { type, data } = message;

    switch (type) {
      case "subscribe":
        // Client wants to subscribe to specific events
        if (Array.isArray(data?.events)) {
          for (const event of data.events) {
            // Check permission for certain events
            if (event === "mod:action" && clientInfo.permission < Permissions.MODERATOR) {
              continue;
            }
            if (event === "bot:log" && clientInfo.permission < Permissions.ADMIN) {
              continue;
            }
            clientInfo.subscribedEvents.add(event);
          }
        }
        break;

      case "unsubscribe":
        // Client wants to unsubscribe from events
        if (Array.isArray(data?.events)) {
          for (const event of data.events) {
            clientInfo.subscribedEvents.delete(event);
          }
        }
        break;

      case "ping":
        // Respond to ping
        sendToClient(clientInfo.ws, { type: "pong", data: { timestamp: Date.now() } });
        break;

      default:
        console.log("Unknown WebSocket message type:", type);
    }
  }

  /**
   * Send message to a specific client
   */
  function sendToClient(ws, message) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Broadcast to all clients subscribed to an event
   */
  function broadcast(eventType, data, minPermission = Permissions.VIEWER) {
    const message = JSON.stringify({ type: eventType, data, timestamp: Date.now() });

    for (const [ws, clientInfo] of clients.entries()) {
      if (ws.readyState !== ws.OPEN) continue;
      if (clientInfo.permission < minPermission) continue;
      if (!clientInfo.subscribedEvents.has(eventType)) continue;

      ws.send(message);
    }
  }

  // Subscribe to BotState events and broadcast to clients

  botState.on("message:relayed", (data) => {
    broadcast("message:relay", data, Permissions.VIEWER);
  });

  botState.on("chat:message", (data) => {
    broadcast("chat:message", data, Permissions.VIEWER);
  });

  botState.on("chat:message-deleted", (data) => {
    broadcast("chat:message-deleted", data, Permissions.VIEWER);
  });

  botState.on("mod:action", (data) => {
    broadcast("mod:action", data, Permissions.MODERATOR);
  });

  botState.on("stream:status", (data) => {
    broadcast("stream:status", data, Permissions.VIEWER);
  });

  botState.on("blacklist:updated", (data) => {
    broadcast("config:update", { type: "blacklist", ...data }, Permissions.MODERATOR);
  });

  botState.on("filters:updated", () => {
    broadcast("config:update", { type: "filters" }, Permissions.MODERATOR);
  });

  botState.on("runtimeConfig:updated", (data) => {
    broadcast("config:update", { type: "runtimeConfig", ...data }, Permissions.MODERATOR);
  });

  botState.on("tokens:updated", () => {
    broadcast("config:update", { type: "tokens" }, Permissions.ADMIN);
  });

  botState.on("audit:event", (data) => {
    broadcast("audit:event", data, Permissions.ADMIN);
  });

  botState.on("bot:log", (data) => {
    broadcast("bot:log", data, Permissions.ADMIN);
  });

  botState.on("raid:incoming", (data) => {
    broadcast("raid:incoming", data, Permissions.VIEWER);
  });

  // Periodic status broadcast every 30 seconds
  setInterval(() => {
    broadcast("status:update", botState.getSnapshot(), Permissions.VIEWER);
  }, 30000);

  return wss;
}

/**
 * Parse session cookie from WebSocket upgrade request
 */
export function parseSessionFromRequest(req) {
  const cookies = req.headers.cookie || "";
  const sessionMatch = cookies.match(/session=([^;]+)/);
  return sessionMatch ? sessionMatch[1] : null;
}
