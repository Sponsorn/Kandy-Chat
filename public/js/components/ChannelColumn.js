import { html } from "htm/preact";
import { useState, useEffect, useRef } from "preact/hooks";
import {
  streamStatus,
  freezeDetectedAt,
  chatMessages,
  canModerate,
  chatStats,
  recentRaids
} from "../state.js";
import { mod, blacklist } from "../api.js";
import { UserLookup } from "./UserLookup.js";

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("sv-SE", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function ChatMessage({ message, onUserClick }) {
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
  const isBroadcaster = !!badges.broadcaster;
  const isMod = !!badges.moderator;
  const isVip = !!badges.vip;
  const isSub = !!badges.subscriber;
  const isFirstMsg = message.firstMsg || false;

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

  const handleBlacklist = async () => {
    const word = prompt("Add to blacklist:", content.split(" ")[0]);
    if (!word) return;
    try {
      await blacklist.add(word.trim());
    } catch (error) {
      console.error("Blacklist failed:", error);
    }
  };

  return html`
    <div
      class="chat-message ${isSuspicious ? "suspicious" : ""} ${isRelayed
        ? "relayed"
        : ""} ${isDeleted ? "deleted" : ""}"
    >
      <span class="chat-timestamp">${formatTime(message.timestamp)}</span>
      <div class="chat-content">
        ${isBroadcaster && html`<span class="chat-badge broadcaster" title="Broadcaster">📺</span>`}
        ${isMod && !isBroadcaster && html`<span class="chat-badge mod" title="Moderator">⚔️</span>`}
        ${isVip && html`<span class="chat-badge vip" title="VIP">💎</span>`}
        ${isSub && html`<span class="chat-badge sub" title="Subscriber">⭐</span>`}
        ${isFirstMsg && html`<span class="chat-badge first" title="First message">🆕</span>`}
        <span
          class="chat-username chat-username-clickable"
          style="color: ${nameColor}"
          onClick=${() =>
            onUserClick && onUserClick(message.username || message.twitchUsername, channel)}
          title="Click to view user info"
          >${username}</span
        >
        <span>: </span>
        <span>${isDeleted ? html`<s>${content}</s>` : content}</span>
      </div>
      ${canModerate.value &&
      !isPrivileged &&
      !isDeleted &&
      html`
        <div class="chat-actions">
          <button class="btn-icon" title="Delete" onClick=${handleDelete}>🗑️</button>
          <button class="btn-icon" title="Timeout" onClick=${handleTimeout}>⏱️</button>
          <button class="btn-icon" title="Ban" onClick=${handleBan}>🔨</button>
          <button class="btn-icon" title="Add to blacklist" onClick=${handleBlacklist}>🚫</button>
        </div>
      `}
    </div>
  `;
}

export function ChannelColumn({ channel, displayName }) {
  const [stream, setStream] = useState(streamStatus.value[channel] || "unknown");
  const [frozenAt, setFrozenAt] = useState(freezeDetectedAt.value[channel] || null);
  const [messageList, setMessageList] = useState([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [stats, setStats] = useState(
    chatStats.value[channel] || { messageCount: 0, uniqueUsers: 0, messagesPerHour: 0 }
  );
  const [latestRaid, setLatestRaid] = useState(null);
  const [lookupUser, setLookupUser] = useState(null);
  const chatFeedRef = useRef(null);

  useEffect(() => {
    // Initialize with current values
    setStream(streamStatus.value[channel] || "unknown");
    setFrozenAt(freezeDetectedAt.value[channel] || null);
    updateMessages();

    const handleStatusUpdate = () => {
      setStream(streamStatus.value[channel] || "unknown");
      setFrozenAt(freezeDetectedAt.value[channel] || null);
      setStats(chatStats.value[channel] || { messageCount: 0, uniqueUsers: 0, messagesPerHour: 0 });
      updateMessages();
    };

    function updateMessages() {
      // Filter by channel (support both old twitchChannel and new channel format)
      const filtered = chatMessages.value.filter(
        (m) => (m.twitchChannel || m.channel)?.toLowerCase() === channel.toLowerCase()
      );
      // Reverse so newest is at top
      setMessageList([...filtered].reverse());
    }

    window.addEventListener("app:status-update", handleStatusUpdate);

    // Also listen for new messages via signal subscription
    const unsubscribe = chatMessages.subscribe(() => {
      updateMessages();
    });

    // Listen for raid events
    const handleRaidIncoming = (e) => {
      const raid = e.detail;
      // Show raid notification for this channel (if it's the target)
      if (raid.to?.toLowerCase() === channel.toLowerCase()) {
        setLatestRaid(raid);
        // Auto-dismiss after 30 seconds
        setTimeout(() => setLatestRaid(null), 30000);
      }
    };
    window.addEventListener("app:raid-incoming", handleRaidIncoming);

    return () => {
      window.removeEventListener("app:status-update", handleStatusUpdate);
      window.removeEventListener("app:raid-incoming", handleRaidIncoming);
      unsubscribe();
    };
  }, [channel]);

  // Auto-scroll effect when new messages arrive
  useEffect(() => {
    if (autoScroll && chatFeedRef.current) {
      chatFeedRef.current.scrollTop = 0; // Newest messages are at top
    }
  }, [messageList, autoScroll]);

  // Filter messages by search term
  const filteredMessages = messageList.filter((m) => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (
      m.message?.toLowerCase().includes(term) ||
      m.username?.toLowerCase().includes(term) ||
      m.displayName?.toLowerCase().includes(term)
    );
  });

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

      ${latestRaid &&
      html`
        <div class="raid-notification">
          <span class="raid-icon">🎉</span>
          <span>${latestRaid.from} raided with ${latestRaid.viewers} viewers!</span>
          <button
            class="btn-icon raid-dismiss"
            onClick=${() => setLatestRaid(null)}
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      `}

      <div class="channel-status-row">
        <div class="channel-status-card">
          <div class="status-label">Stream</div>
          <div class="status-value ${getStreamStatusClass()}">${getStreamStatusText()}</div>
        </div>
        <div class="channel-status-card">
          <div class="status-label">Chat Stats</div>
          <div class="status-value" style="font-size: 0.875rem;">
            ${stats.messagesPerHour}/hr | ${stats.uniqueUsers} users
          </div>
        </div>
      </div>

      <div class="card channel-chat-card">
        <div class="card-header">
          <span class="card-title">Chat Feed</span>
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <input
              type="text"
              class="form-input"
              placeholder="Search..."
              value=${searchTerm}
              onInput=${(e) => setSearchTerm(e.target.value)}
              style="width: 120px; padding: 0.25rem 0.5rem; font-size: 0.75rem;"
            />
            <button
              class="btn btn-sm ${autoScroll ? "btn-primary" : "btn-secondary"}"
              onClick=${() => {
                const newValue = !autoScroll;
                setAutoScroll(newValue);
                // Immediately scroll to top when re-enabling
                if (newValue && chatFeedRef.current) {
                  chatFeedRef.current.scrollTop = 0;
                }
              }}
              title=${autoScroll ? "Auto-scroll enabled" : "Auto-scroll disabled"}
            >
              ${autoScroll ? "Auto" : "Paused"}
            </button>
            <span class="text-muted">${filteredMessages.length} messages</span>
          </div>
        </div>
        <div class="chat-feed" ref=${chatFeedRef}>
          ${filteredMessages.length === 0
            ? html`
                <div class="empty-state-small">
                  <p>${searchTerm ? "No matching messages" : "No messages yet"}</p>
                </div>
              `
            : filteredMessages.map(
                (msg) => html`
                  <${ChatMessage}
                    key=${msg.id}
                    message=${msg}
                    onUserClick=${(user) => setLookupUser(user)}
                  />
                `
              )}
        </div>
      </div>

      ${lookupUser &&
      html`
        <${UserLookup}
          username=${lookupUser}
          channel=${channel}
          onClose=${() => setLookupUser(null)}
        />
      `}
    </div>
  `;
}
