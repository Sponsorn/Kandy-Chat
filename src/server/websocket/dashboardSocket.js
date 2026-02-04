import { WebSocketServer } from "ws";
import botState from "../../state/BotState.js";
import { getSession, Permissions } from "../../auth/sessionManager.js";

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

  wss.on("connection", (ws, req) => {
    // Extract session from cookie
    const cookies = req.headers.cookie || "";
    const sessionMatch = cookies.match(/session=([^;]+)/);
    const sessionId = sessionMatch ? sessionMatch[1] : null;
    const session = getSession(sessionId);

    // Store client info
    const clientInfo = {
      ws,
      session,
      permission: session?.permission ?? Permissions.VIEWER,
      subscribedEvents: new Set(["stream:status"]) // Default subscriptions
    };
    clients.set(ws, clientInfo);

    console.log(`WebSocket client connected (permission: ${clientInfo.permission})`);

    // Send initial state
    sendToClient(ws, {
      type: "init",
      data: {
        connected: true,
        permission: clientInfo.permission,
        status: botState.getSnapshot()
      }
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

  botState.on("tokens:updated", () => {
    broadcast("config:update", { type: "tokens" }, Permissions.ADMIN);
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
