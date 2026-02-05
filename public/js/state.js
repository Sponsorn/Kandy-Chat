import { signal, computed } from "@preact/signals";

// Authentication state
export const user = signal(null);
export const isAuthenticated = computed(() => user.value !== null);
export const permission = computed(() => user.value?.permission ?? 0);
export const canModerate = computed(() => permission.value >= 1); // MODERATOR
export const canAdmin = computed(() => permission.value >= 2); // ADMIN

// Connection state
export const wsConnected = signal(false);
export const wsConnecting = signal(false);

// Bot status
export const botStatus = signal({
  status: "unknown",
  uptime: 0,
  uptimeString: "0s",
  connections: { discord: false, twitch: false }
});

// Stream status (per-channel)
export const streamStatus = signal({});  // { "kandyland": "online", "kandylandvods": "offline" }
export const freezeDetectedAt = signal({});  // { "kandyland": null, "kandylandvods": 1234567890 }

// Twitch channels list
export const twitchChannels = signal([]);

// Metrics
export const metrics = signal({
  messagesRelayed: 0,
  messagesFiltered: 0,
  moderationActions: 0,
  lastMessageTime: null
});

// Chat messages (real-time feed) - legacy, only relayed messages
export const messages = signal([]);
const MAX_MESSAGES = 200;

export function addMessage(msg) {
  const current = messages.value;
  const newMessages = [{ ...msg, id: Date.now() + Math.random() }, ...current];
  messages.value = newMessages.slice(0, MAX_MESSAGES);
}

// Chat feed messages (ALL messages, including filtered ones)
export const chatMessages = signal([]);
const MAX_CHAT_MESSAGES = 500;

export function addChatMessage(msg) {
  const current = chatMessages.value;
  // Add to end (newest last) for chronological display
  const newMessages = [...current, msg].slice(-MAX_CHAT_MESSAGES);
  chatMessages.value = newMessages;
}

export function setChatMessages(msgs) {
  chatMessages.value = msgs.slice(-MAX_CHAT_MESSAGES);
}

export function markChatMessageDeleted(messageId) {
  chatMessages.value = chatMessages.value.map(msg =>
    msg.id === messageId ? { ...msg, deleted: true } : msg
  );
}

// Mod actions
export const modActions = signal([]);
const MAX_MOD_ACTIONS = 100;

export function addModAction(action) {
  const current = modActions.value;
  const newActions = [{ ...action, id: Date.now() + Math.random() }, ...current];
  modActions.value = newActions.slice(0, MAX_MOD_ACTIONS);
}

// Audit log (admin only)
export const auditLog = signal([]);
const MAX_AUDIT_ENTRIES = 100;

export function addAuditEntry(entry) {
  const current = auditLog.value;
  const newEntries = [entry, ...current.filter(e => e.id !== entry.id)];
  auditLog.value = newEntries.slice(0, MAX_AUDIT_ENTRIES);
}

// Blacklist
export const blacklistWords = signal([]);
export const blacklistRegex = signal([]);

// Current route
export const currentRoute = signal(window.location.pathname);

// Navigation helper
export function navigate(path) {
  window.history.pushState({}, "", path);
  currentRoute.value = path;
  // Dispatch event for App component to handle
  window.dispatchEvent(new CustomEvent("app:navigate", { detail: path }));
}

// Initialize route handling
window.addEventListener("popstate", () => {
  currentRoute.value = window.location.pathname;
});

// Dispatch status update event for components
function dispatchStatusUpdate() {
  window.dispatchEvent(new CustomEvent("app:status-update"));
}

// Update status from WebSocket
export function updateFromWs(data) {
  if (data.type === "init" || data.type === "status:update") {
    const status = data.data.status || data.data;
    botStatus.value = {
      status: "online",
      uptime: status.uptime,
      uptimeString: status.uptimeString,
      connections: status.connections
    };
    if (status.metrics) {
      metrics.value = status.metrics;
    }
    // Handle per-channel stream status
    if (status.metrics?.streamStatusByChannel) {
      streamStatus.value = { ...status.metrics.streamStatusByChannel };
      freezeDetectedAt.value = { ...status.metrics.freezeDetectedByChannel };
    } else if (status.metrics?.streamStatus) {
      // Backwards compatibility: single status maps to all channels
      const channels = status.channels?.twitch || [];
      const statusObj = {};
      const freezeObj = {};
      for (const ch of channels) {
        statusObj[ch] = status.metrics.streamStatus;
        freezeObj[ch] = status.metrics.freezeDetectedAt;
      }
      streamStatus.value = statusObj;
      freezeDetectedAt.value = freezeObj;
    }
    // Store twitch channels list
    if (status.channels?.twitch) {
      twitchChannels.value = status.channels.twitch;
    }
    // Handle initial chat messages from init
    if (data.type === "init" && data.data.recentChat) {
      handleInitChatMessages(data.data.recentChat);
    }
    dispatchStatusUpdate();
  } else if (data.type === "message:relay") {
    addMessage(data.data);
  } else if (data.type === "mod:action") {
    addModAction(data.data);
  } else if (data.type === "stream:status") {
    const { channel, status } = data.data;
    if (channel) {
      // Per-channel status update
      streamStatus.value = { ...streamStatus.value, [channel]: status };
      if (status === "frozen") {
        freezeDetectedAt.value = { ...freezeDetectedAt.value, [channel]: Date.now() };
      } else {
        freezeDetectedAt.value = { ...freezeDetectedAt.value, [channel]: null };
      }
    } else {
      // Legacy: update all channels with same status
      const channels = twitchChannels.value || [];
      const statusObj = { ...streamStatus.value };
      const freezeObj = { ...freezeDetectedAt.value };
      for (const ch of channels) {
        statusObj[ch] = status;
        freezeObj[ch] = status === "frozen" ? Date.now() : null;
      }
      streamStatus.value = statusObj;
      freezeDetectedAt.value = freezeObj;
    }
    dispatchStatusUpdate();
  } else if (data.type === "config:update") {
    if (data.data.type === "blacklist") {
      // Refresh blacklist on update
      fetchBlacklist();
    } else if (data.data.type === "runtimeConfig" || data.data.type === "filters") {
      // Notify config panel to refresh
      window.dispatchEvent(new CustomEvent("app:config-update"));
    }
  } else if (data.type === "audit:event") {
    addAuditEntry(data.data);
  } else if (data.type === "chat:message") {
    addChatMessage(data.data);
  } else if (data.type === "chat:message-deleted") {
    markChatMessageDeleted(data.data.id);
  }
}

// Handle initial chat messages from init
export function handleInitChatMessages(recentChat) {
  if (recentChat && Array.isArray(recentChat)) {
    setChatMessages(recentChat);
  }
}

// Fetch blacklist from API
async function fetchBlacklist() {
  try {
    const response = await fetch("/api/blacklist");
    if (response.ok) {
      const data = await response.json();
      blacklistWords.value = data.words || [];
      blacklistRegex.value = data.regex || [];
      window.dispatchEvent(new CustomEvent("app:blacklist-update"));
    }
  } catch (error) {
    console.error("Failed to fetch blacklist:", error);
  }
}

// Export for external use
export { fetchBlacklist };
