/**
 * API client for dashboard
 */

const API_BASE = "";

/**
 * Make an API request
 */
async function request(method, path, body = null) {
  const options = {
    method,
    headers: {
      "Content-Type": "application/json"
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${API_BASE}${path}`, options);

  if (response.status === 401) {
    // Unauthorized - redirect to login
    window.location.href = "/?error=session_expired";
    throw new Error("Session expired");
  }

  if (response.status === 403) {
    throw new Error("Permission denied");
  }

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }

  return data;
}

// Auth API
export const auth = {
  async getMe() {
    return request("GET", "/auth/me");
  },

  async logout() {
    return request("POST", "/auth/logout");
  }
};

// Status API
export const status = {
  async get() {
    return request("GET", "/api/status");
  },

  async getMetrics() {
    return request("GET", "/api/metrics");
  },

  async getStream() {
    return request("GET", "/api/stream");
  },

  async getHealth() {
    return request("GET", "/api/health");
  }
};

// Messages API
export const messages = {
  async getRecent(limit = 50) {
    return request("GET", `/api/messages?limit=${limit}`);
  }
};

// Moderation API
export const mod = {
  async getActions() {
    return request("GET", "/api/modactions");
  },

  async deleteMessage(channel, messageId) {
    return request("POST", "/api/mod/delete", { channel, messageId });
  },

  async timeoutUser(channel, username, duration) {
    return request("POST", "/api/mod/timeout", { channel, username, duration });
  },

  async banUser(channel, username) {
    return request("POST", "/api/mod/ban", { channel, username });
  },

  async warnUser(channel, username, reason) {
    return request("POST", "/api/mod/warn", { channel, username, reason });
  }
};

// Blacklist API
export const blacklist = {
  async get() {
    return request("GET", "/api/blacklist");
  },

  async add(word) {
    return request("POST", "/api/blacklist", { word });
  },

  async remove(word) {
    return request("DELETE", "/api/blacklist", { word });
  }
};

// Config API
export const config = {
  async get() {
    return request("GET", "/api/config");
  },

  async getChannels() {
    return request("GET", "/api/channels");
  },

  async getFilters() {
    return request("GET", "/api/filters");
  },

  async updateFilters(filters) {
    return request("PUT", "/api/filters", filters);
  },

  async getSubscriptionMessages() {
    return request("GET", "/api/subscription-messages");
  },

  async updateSubscriptionMessages(messages) {
    return request("PUT", "/api/subscription-messages", messages);
  }
};

// Control API
export const control = {
  async restart() {
    return request("POST", "/api/control/restart");
  },

  async stop() {
    return request("POST", "/api/control/stop");
  }
};

// Audit API
export const audit = {
  async get(limit = 50, offset = 0) {
    return request("GET", `/api/audit?limit=${limit}&offset=${offset}`);
  }
};
