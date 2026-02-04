import { html } from "htm/preact";
import { useState, useEffect } from "preact/hooks";
import { streamStatus, freezeDetectedAt, messages, canModerate } from "../state.js";
import { mod } from "../api.js";

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function ChatMessage({ message }) {
  const isSuspicious = message.suspicious || false;

  const handleDelete = async () => {
    try {
      await mod.deleteMessage(message.twitchChannel, message.twitchMessageId);
    } catch (error) {
      console.error("Delete failed:", error);
    }
  };

  const handleTimeout = async () => {
    try {
      await mod.timeoutUser(message.twitchChannel, message.twitchUsername);
    } catch (error) {
      console.error("Timeout failed:", error);
    }
  };

  const handleBan = async () => {
    if (!confirm(`Ban ${message.twitchUsername}?`)) return;
    try {
      await mod.banUser(message.twitchChannel, message.twitchUsername);
    } catch (error) {
      console.error("Ban failed:", error);
    }
  };

  return html`
    <div class="chat-message ${isSuspicious ? "suspicious" : ""}">
      <span class="chat-timestamp">${formatTime(message.timestamp)}</span>
      <div class="chat-content">
        <span class="chat-username">${message.twitchUsername}</span>
        <span>: </span>
        <span>${message.content || "(message content not available)"}</span>
      </div>
      ${canModerate.value && html`
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
      const filtered = messages.value.filter(
        m => m.twitchChannel?.toLowerCase() === channel.toLowerCase()
      );
      setMessageList(filtered);
    }

    window.addEventListener("app:status-update", handleStatusUpdate);

    // Also listen for new messages via signal subscription
    const unsubscribe = messages.subscribe(() => {
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
