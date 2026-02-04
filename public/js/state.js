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

// Stream status
export const streamStatus = signal("unknown");
export const freezeDetectedAt = signal(null);

// Metrics
export const metrics = signal({
  messagesRelayed: 0,
  messagesFiltered: 0,
  moderationActions: 0,
  lastMessageTime: null
});

// Chat messages (real-time feed)
export const messages = signal([]);
const MAX_MESSAGES = 200;

export function addMessage(msg) {
  const current = messages.value;
  const newMessages = [{ ...msg, id: Date.now() + Math.random() }, ...current];
  messages.value = newMessages.slice(0, MAX_MESSAGES);
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
    if (status.metrics?.streamStatus) {
      streamStatus.value = status.metrics.streamStatus;
      freezeDetectedAt.value = status.metrics.freezeDetectedAt;
    }
    dispatchStatusUpdate();
  } else if (data.type === "message:relay") {
    addMessage(data.data);
  } else if (data.type === "mod:action") {
    addModAction(data.data);
  } else if (data.type === "stream:status") {
    streamStatus.value = data.data.status;
    if (data.data.status === "frozen") {
      freezeDetectedAt.value = Date.now();
    } else {
      freezeDetectedAt.value = null;
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
