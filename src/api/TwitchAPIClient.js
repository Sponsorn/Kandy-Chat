import { fetchWithTimeout } from "../utils/fetch.js";

/**
 * Centralized Twitch Helix API client
 * Eliminates code duplication and provides consistent error handling
 */
export class TwitchAPIClient {
  constructor(clientId, botUsername, getAccessToken) {
    this.clientId = clientId;
    this.botUsername = botUsername;
    this.getAccessToken = getAccessToken;
  }

  /**
   * Get user ID by login name
   * @param {string} login - Twitch username
   * @returns {Promise<string>} User ID
   */
  async getUserId(login) {
    const accessToken = await this.getAccessToken();

    const response = await fetchWithTimeout(
      `https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`,
      {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Client-Id": this.clientId
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get user ID for ${login}: ${response.status}`);
    }

    const data = await response.json();
    const userId = data.data?.[0]?.id;

    if (!userId) {
      throw new Error(`User not found: ${login}`);
    }

    return userId;
  }

  /**
   * Get broadcaster and moderator IDs (common pattern in API calls)
   * @param {string} channelLogin - Channel name
   * @returns {Promise<{broadcasterId: string, moderatorId: string}>}
   */
  async getBroadcasterAndModeratorIds(channelLogin) {
    const accessToken = await this.getAccessToken();

    // Get broadcaster ID
    const broadcasterResponse = await fetchWithTimeout(
      `https://api.twitch.tv/helix/users?login=${channelLogin.replace("#", "")}`,
      {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Client-Id": this.clientId
        }
      }
    );

    if (!broadcasterResponse.ok) {
      throw new Error(`Failed to get broadcaster ID: ${broadcasterResponse.status}`);
    }

    const broadcasterData = await broadcasterResponse.json();
    const broadcasterId = broadcasterData.data?.[0]?.id;

    if (!broadcasterId) {
      throw new Error("Broadcaster not found");
    }

    // Get moderator ID (the bot itself)
    const modResponse = await fetchWithTimeout(
      `https://api.twitch.tv/helix/users?login=${this.botUsername}`,
      {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Client-Id": this.clientId
        }
      }
    );

    if (!modResponse.ok) {
      throw new Error(`Failed to get moderator ID: ${modResponse.status}`);
    }

    const modData = await modResponse.json();
    const moderatorId = modData.data?.[0]?.id;

    if (!moderatorId) {
      throw new Error("Moderator user not found");
    }

    return { broadcasterId, moderatorId };
  }

  /**
   * Delete a Twitch chat message
   * @param {string} channelName - Channel name (with or without #)
   * @param {string} messageId - Message ID to delete
   */
  async deleteMessage(channelName, messageId) {
    const accessToken = await this.getAccessToken();
    const { broadcasterId, moderatorId } = await this.getBroadcasterAndModeratorIds(channelName);

    const deleteResponse = await fetchWithTimeout(
      `https://api.twitch.tv/helix/moderation/chat?broadcaster_id=${broadcasterId}&moderator_id=${moderatorId}&message_id=${messageId}`,
      {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Client-Id": this.clientId
        }
      }
    );

    if (!deleteResponse.ok) {
      const errorText = await deleteResponse.text();
      throw new Error(`Failed to delete message: ${deleteResponse.status} - ${errorText}`);
    }
  }

  /**
   * Timeout a user in Twitch chat
   * @param {string} channelName - Channel name
   * @param {string} username - Username to timeout
   * @param {number} duration - Duration in seconds
   */
  async timeoutUser(channelName, username, duration) {
    const accessToken = await this.getAccessToken();
    const { broadcasterId, moderatorId } = await this.getBroadcasterAndModeratorIds(channelName);
    const userId = await this.getUserId(username);

    const response = await fetchWithTimeout(
      `https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${moderatorId}`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Client-Id": this.clientId,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          data: {
            user_id: userId,
            duration
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to timeout user: ${response.status} - ${errorText}`);
    }
  }

  /**
   * Ban a user from Twitch chat
   * @param {string} channelName - Channel name
   * @param {string} username - Username to ban
   */
  async banUser(channelName, username) {
    const accessToken = await this.getAccessToken();
    const { broadcasterId, moderatorId } = await this.getBroadcasterAndModeratorIds(channelName);
    const userId = await this.getUserId(username);

    const response = await fetchWithTimeout(
      `https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${moderatorId}`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Client-Id": this.clientId,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          data: {
            user_id: userId
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to ban user: ${response.status} - ${errorText}`);
    }
  }

  /**
   * Warn a user in Twitch chat
   * @param {string} channelName - Channel name
   * @param {string} username - Username to warn
   * @param {string} reason - Reason for warning
   */
  async warnUser(channelName, username, reason = "Violating community guidelines") {
    const accessToken = await this.getAccessToken();
    const { broadcasterId, moderatorId } = await this.getBroadcasterAndModeratorIds(channelName);
    const userId = await this.getUserId(username);

    const warnResponse = await fetchWithTimeout(
      `https://api.twitch.tv/helix/moderation/warnings?broadcaster_id=${broadcasterId}&moderator_id=${moderatorId}`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Client-Id": this.clientId,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          user_id: userId,
          reason
        })
      }
    );

    if (!warnResponse.ok) {
      const errorText = await warnResponse.text();
      throw new Error(`Failed to warn user: ${warnResponse.status} - ${errorText}`);
    }
  }

  /**
   * Get blocked terms from a Twitch channel
   * @param {string} channelLogin - Channel login name
   * @returns {Promise<Array>} Array of blocked term objects
   */
  async getBlockedTerms(channelLogin) {
    const accessToken = await this.getAccessToken();
    const { broadcasterId, moderatorId } = await this.getBroadcasterAndModeratorIds(channelLogin);

    const allTerms = [];
    let cursor = null;

    do {
      const url = new URL("https://api.twitch.tv/helix/moderation/blocked_terms");
      url.searchParams.append("broadcaster_id", broadcasterId);
      url.searchParams.append("moderator_id", moderatorId);
      url.searchParams.append("first", "100");
      if (cursor) {
        url.searchParams.append("after", cursor);
      }

      const response = await fetchWithTimeout(url.toString(), {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Client-Id": this.clientId
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to fetch blocked terms: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      allTerms.push(...(data.data || []));
      cursor = data.pagination?.cursor || null;
    } while (cursor);

    return allTerms;
  }

  /**
   * Add a blocked term to a Twitch channel
   * @param {string} channelLogin - Channel login name
   * @param {string} term - Term to block
   * @returns {Promise<Object>} Response data
   */
  async addBlockedTerm(channelLogin, term) {
    const accessToken = await this.getAccessToken();

    // Get broadcaster ID
    const userResponse = await fetchWithTimeout(
      `https://api.twitch.tv/helix/users?login=${encodeURIComponent(channelLogin)}`,
      {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Client-Id": this.clientId
        }
      }
    );

    if (!userResponse.ok) {
      throw new Error(`Failed to fetch user info: ${userResponse.status}`);
    }

    const userData = await userResponse.json();
    if (!userData.data?.length) {
      throw new Error(`Channel not found: ${channelLogin}`);
    }

    const broadcasterId = userData.data[0].id;

    // Get moderator ID (the authenticated user making the request)
    const moderatorResponse = await fetchWithTimeout(
      "https://api.twitch.tv/helix/users",
      {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Client-Id": this.clientId
        }
      }
    );

    if (!moderatorResponse.ok) {
      throw new Error(`Failed to fetch moderator info: ${moderatorResponse.status}`);
    }

    const moderatorData = await moderatorResponse.json();
    if (!moderatorData.data?.length) {
      throw new Error("Could not get authenticated user ID");
    }

    const moderatorId = moderatorData.data[0].id;

    // Add blocked term
    const addResponse = await fetchWithTimeout(
      `https://api.twitch.tv/helix/moderation/blocked_terms?broadcaster_id=${broadcasterId}&moderator_id=${moderatorId}`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Client-Id": this.clientId,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ text: term })
      }
    );

    if (!addResponse.ok) {
      const errorText = await addResponse.text();
      throw new Error(`Failed to add blocked term: ${addResponse.status} ${errorText}`);
    }

    return await addResponse.json();
  }

  /**
   * Get stream status for one or more channels
   * @param {string[]} logins - Array of channel login names
   * @returns {Promise<Map<string, {live: boolean, data?: object}>>} Map of login -> status
   */
  async getStreamStatus(logins) {
    const accessToken = await this.getAccessToken();
    const results = new Map();

    // Normalize logins - strip # prefix if present (tmi.js mutates channel arrays)
    const normalizedLogins = logins.map(l => l.replace(/^#/, "").toLowerCase());

    // Initialize all as offline
    for (const login of normalizedLogins) {
      results.set(login, { live: false });
    }

    // Twitch allows up to 100 user_login params per request
    const batchSize = 100;
    for (let i = 0; i < normalizedLogins.length; i += batchSize) {
      const batch = normalizedLogins.slice(i, i + batchSize);
      const params = batch.map(l => `user_login=${encodeURIComponent(l)}`).join("&");

      const response = await fetchWithTimeout(
        `https://api.twitch.tv/helix/streams?${params}`,
        {
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Client-Id": this.clientId
          }
        }
      );

      if (!response.ok) {
        console.error(`Failed to get stream status: ${response.status}`);
        continue;
      }

      const data = await response.json();

      // Streams endpoint only returns data for live channels
      for (const stream of data.data || []) {
        const login = stream.user_login.toLowerCase();
        results.set(login, { live: true, data: stream });
      }
    }

    return results;
  }
}
