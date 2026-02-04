import { html } from "htm/preact";
import { messages, canModerate } from "../state.js";
import { mod } from "../api.js";

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function ChatMessage({ message, onModAction }) {
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

export function ChatFeed() {
  const messageList = messages.value;

  if (messageList.length === 0) {
    return html`
      <div class="card">
        <div class="card-header">
          <span class="card-title">Chat Feed</span>
        </div>
        <div class="card-body">
          <div class="empty-state">
            <div class="empty-state-icon">💬</div>
            <p>No messages yet. Chat will appear here in real-time.</p>
          </div>
        </div>
      </div>
    `;
  }

  return html`
    <div class="card">
      <div class="card-header">
        <span class="card-title">Chat Feed</span>
        <span class="text-muted">${messageList.length} messages</span>
      </div>
      <div class="chat-feed">
        ${messageList.map(msg => html`
          <${ChatMessage} key=${msg.id} message=${msg} />
        `)}
      </div>
    </div>
  `;
}
