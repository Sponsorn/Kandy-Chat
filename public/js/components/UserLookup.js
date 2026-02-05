import { html } from "htm/preact";
import { useState, useEffect } from "preact/hooks";
import { chat, mod } from "../api.js";
import { chatMessages, canModerate } from "../state.js";

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function UserLookup({ username, channel, onClose }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ total: 0, deleted: 0 });

  useEffect(() => {
    // Load messages filtered by username from local state first
    const localMsgs = chatMessages.value.filter(
      m => (m.username?.toLowerCase() === username.toLowerCase() ||
            m.displayName?.toLowerCase() === username.toLowerCase()) &&
           (!channel || (m.channel || m.twitchChannel)?.toLowerCase() === channel.toLowerCase())
    );

    // Try to get more from chat history API
    chat.getHistory(channel, 500).then(result => {
      const historyMsgs = (result.messages || []).filter(
        m => m.username?.toLowerCase() === username.toLowerCase() ||
             m.displayName?.toLowerCase() === username.toLowerCase()
      );

      // Merge and deduplicate
      const seenIds = new Set();
      const allMsgs = [];
      for (const msg of [...localMsgs, ...historyMsgs]) {
        if (!seenIds.has(msg.id)) {
          seenIds.add(msg.id);
          allMsgs.push(msg);
        }
      }

      // Sort by timestamp (newest first)
      allMsgs.sort((a, b) => b.timestamp - a.timestamp);
      setMessages(allMsgs);

      // Calculate stats
      const deleted = allMsgs.filter(m => m.deleted).length;
      setStats({ total: allMsgs.length, deleted });
      setLoading(false);
    }).catch(() => {
      // Just use local messages on error
      setMessages(localMsgs.sort((a, b) => b.timestamp - a.timestamp));
      const deleted = localMsgs.filter(m => m.deleted).length;
      setStats({ total: localMsgs.length, deleted });
      setLoading(false);
    });
  }, [username, channel]);

  const handleTimeout = async () => {
    if (!confirm(`Timeout ${username}?`)) return;
    try {
      await mod.timeoutUser(channel, username);
      onClose();
    } catch (error) {
      console.error("Timeout failed:", error);
    }
  };

  const handleBan = async () => {
    if (!confirm(`Ban ${username}?`)) return;
    try {
      await mod.banUser(channel, username);
      onClose();
    } catch (error) {
      console.error("Ban failed:", error);
    }
  };

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return html`
    <div class="user-lookup-modal" onClick=${handleOverlayClick}>
      <div class="user-lookup-content">
        <div class="user-lookup-header">
          <span class="user-lookup-title">${username}</span>
          <button class="btn-icon" onClick=${onClose} title="Close">✕</button>
        </div>

        <div class="user-lookup-body">
          <div class="user-lookup-stats">
            <div class="user-lookup-stat">
              <div class="user-lookup-stat-value">${stats.total}</div>
              <div class="user-lookup-stat-label">Messages</div>
            </div>
            <div class="user-lookup-stat">
              <div class="user-lookup-stat-value">${stats.deleted}</div>
              <div class="user-lookup-stat-label">Deleted</div>
            </div>
          </div>

          <div class="user-lookup-messages">
            ${loading
              ? html`<div class="empty-state-small"><p>Loading...</p></div>`
              : messages.length === 0
                ? html`<div class="empty-state-small"><p>No messages found</p></div>`
                : messages.slice(0, 50).map(msg => html`
                  <div class="chat-message ${msg.deleted ? 'deleted' : ''}" key=${msg.id}>
                    <span class="chat-timestamp">${formatTime(msg.timestamp)}</span>
                    <div class="chat-content">
                      <span>${msg.deleted ? html`<s>${msg.message}</s>` : msg.message}</span>
                    </div>
                  </div>
                `)
            }
          </div>
        </div>

        ${canModerate.value && html`
          <div class="user-lookup-footer">
            <button class="btn btn-secondary" onClick=${handleTimeout}>Timeout</button>
            <button class="btn btn-danger" onClick=${handleBan}>Ban</button>
          </div>
        `}
      </div>
    </div>
  `;
}
