import { wsConnected, wsConnecting, updateFromWs } from "./state.js";

let ws = null;
let reconnectTimeout = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY = 1000;

/**
 * Connect to WebSocket server
 */
export function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  wsConnecting.value = true;
  wsConnected.value = false;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/ws`;

  try {
    ws = new WebSocket(url);

    ws.onopen = () => {
      console.log("WebSocket connected");
      wsConnected.value = true;
      wsConnecting.value = false;
      reconnectAttempts = 0;

      // Subscribe to events
      ws.send(
        JSON.stringify({
          type: "subscribe",
          data: {
            events: [
              "message:relay",
              "mod:action",
              "stream:status",
              "config:update",
              "status:update"
            ]
          }
        })
      );
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        updateFromWs(data);
      } catch (error) {
        console.error("Failed to parse WebSocket message:", error);
      }
    };

    ws.onclose = (event) => {
      console.log("WebSocket closed:", event.code, event.reason);
      wsConnected.value = false;
      wsConnecting.value = false;
      ws = null;

      // Attempt reconnection
      scheduleReconnect();
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      wsConnecting.value = false;
    };
  } catch (error) {
    console.error("Failed to create WebSocket:", error);
    wsConnecting.value = false;
    scheduleReconnect();
  }
}

/**
 * Schedule a reconnection attempt
 */
function scheduleReconnect() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }

  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.log("Max reconnection attempts reached");
    return;
  }

  const delay = RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts);
  reconnectAttempts++;

  console.log(`Scheduling reconnect in ${delay}ms (attempt ${reconnectAttempts})`);

  reconnectTimeout = setTimeout(() => {
    connect();
  }, delay);
}

/**
 * Disconnect from WebSocket
 */
export function disconnect() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  if (ws) {
    ws.close();
    ws = null;
  }

  wsConnected.value = false;
  wsConnecting.value = false;
}

/**
 * Send a message through WebSocket
 */
export function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

/**
 * Check if connected
 */
export function isConnected() {
  return ws && ws.readyState === WebSocket.OPEN;
}
