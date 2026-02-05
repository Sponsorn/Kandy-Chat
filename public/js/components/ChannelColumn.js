import { html } from "htm/preact";
import { useState, useEffect } from "preact/hooks";
import { streamStatus, freezeDetectedAt, chatMessages, canModerate } from "../state.js";
import { mod } from "../api.js";

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function ChatMessage({ message }) {
  const isSuspicious = message.suspicious || false;
  const isRelayed = message.relayed || false;
  const isDeleted = message.deleted || false;

  // Support both old format (twitchChannel, twitchUsername) and new format (channel, username)
  const channel = message.twitchChannel || message.channel;
  const username = message.twitchUsername || message.displayName || message.username;
  const messageId = message.twitchMessageId || message.id;
  const content = message.content || message.message || "(message content not available)";
  const nameColor = message.color || "var(--accent-primary)";
  const badges = message.badges || {};
  const isPrivileged = badges.broadcaster || badges.moderator;

  const handleDelete = async () => {
    try {
      await mod.deleteMessage(channel, messageId);
    } catch (error) {
      console.error("Delete failed:", error);
    }
  };

  const handleTimeout = async () => {
    try {
      await mod.timeoutUser(channel, message.username || message.twitchUsername);
    } catch (error) {
      console.error("Timeout failed:", error);
    }
  };

  const handleBan = async () => {
    if (!confirm(`Ban ${username}?`)) return;
    try {
      await mod.banUser(channel, message.username || message.twitchUsername);
    } catch (error) {
      console.error("Ban failed:", error);
    }
  };

  return html`
    <div class="chat-message ${isSuspicious ? "suspicious" : ""} ${isRelayed ? "relayed" : ""} ${isDeleted ? "deleted" : ""}">
      <span class="chat-timestamp">${formatTime(message.timestamp)}</span>
      <div class="chat-content">
        <span class="chat-username" style="color: ${nameColor}">${username}</span>
        <span>: </span>
        <span>${isDeleted ? html`<s>${content}</s>` : content}</span>
      </div>
      ${canModerate.value && !isPrivileged && !isDeleted && html`
        <div class="chat-actions">
          <button class="btn-icon" title="Delete" onClick=${handleDelete}>🗑️</button>
          <button class="btn-icon" title="Timeout" onClick=${handleTimeout}>⏱️</button>
          <button class="btn-icon" title="Ban" onClick=${handleBan}>🔨</button>
        </div>
      `}
    </div>
  `;
}

export function ChannelColumn({ channel, displayName }) {
  const [stream, setStream] = useState(streamStatus.value[channel] || "unknown");
  const [frozenAt, setFrozenAt] = useState(freezeDetectedAt.value[channel] || null);
  const [messageList, setMessageList] = useState([]);

  useEffect(() => {
    // Initialize with current values
    setStream(streamStatus.value[channel] || "unknown");
    setFrozenAt(freezeDetectedAt.value[channel] || null);
    updateMessages();

    const handleStatusUpdate = () => {
      setStream(streamStatus.value[channel] || "unknown");
      setFrozenAt(freezeDetectedAt.value[channel] || null);
      updateMessages();
    };

    function updateMessages() {
      // Filter by channel (support both old twitchChannel and new channel format)
      const filtered = chatMessages.value.filter(
        m => (m.twitchChannel || m.channel)?.toLowerCase() === channel.toLowerCase()
      );
      // Reverse so newest is at top
      setMessageList([...filtered].reverse());
    }

    window.addEventListener("app:status-update", handleStatusUpdate);

    // Also listen for new messages via signal subscription
    const unsubscribe = chatMessages.subscribe(() => {
      updateMessages();
    });

    return () => {
      window.removeEventListener("app:status-update", handleStatusUpdate);
      unsubscribe();
    };
  }, [channel]);

  const getStreamStatusClass = () => {
    if (stream === "online") return "online";
    if (stream === "offline") return "offline";
    if (stream === "frozen") return "frozen";
    return "";
  };

  const getStreamStatusText = () => {
    if (stream === "online") return "Online";
    if (stream === "offline") return "Offline";
    if (stream === "frozen") {
      if (frozenAt) {
        const seconds = Math.floor((Date.now() - frozenAt) / 1000);
        return `Frozen (${seconds}s)`;
      }
      return "Frozen";
    }
    return "Unknown";
  };

  return html`
    <div class="channel-column">
      <div class="channel-header">${displayName}</div>

      <div class="channel-status-row">
        <div class="channel-status-card">
          <div class="status-label">Stream</div>
          <div class="status-value ${getStreamStatusClass()}">${getStreamStatusText()}</div>
        </div>
        <div class="channel-status-card">
          <div class="status-label">Bitrate</div>
          <div class="status-value">--</div>
        </div>
      </div>

      <div class="card channel-chat-card">
        <div class="card-header">
          <span class="card-title">Chat Feed</span>
          <span class="text-muted">${messageList.length} messages</span>
        </div>
        <div class="chat-feed">
          ${messageList.length === 0
            ? html`
              <div class="empty-state-small">
                <p>No messages yet</p>
              </div>
            `
            : messageList.map(msg => html`
              <${ChatMessage} key=${msg.id} message=${msg} />
            `)
          }
        </div>
      </div>
    </div>
  `;
}
