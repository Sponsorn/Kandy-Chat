import { html } from "htm/preact";
import { useState, useEffect } from "preact/hooks";
import { modActions, addModAction } from "../state.js";
import { modlog } from "../api.js";

const ACTION_LABELS = {
  delete: { label: "Delete", color: "var(--warning)" },
  timeout: { label: "Timeout", color: "var(--info)" },
  ban: { label: "Ban", color: "var(--error)" },
  warn: { label: "Warn", color: "#f59e0b" }
};

function formatTimestamp(ts) {
  const date = new Date(ts);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function ModLogEntry({ action }) {
  const actionInfo = ACTION_LABELS[action.action] || {
    label: action.action,
    color: "var(--text-muted)"
  };

  const sourceLabel = action.source === "dashboard" ? "Dashboard" : "Discord";
  const isFailed = action.status === "failed";

  return html`
    <div class="modlog-entry">
      <div class="modlog-content">
        <div class="modlog-header">
          <span class="mod-action ${action.action}" style="color: ${actionInfo.color}">
            ${actionInfo.label}
          </span>
          <span class="modlog-source modlog-source--${action.source || "discord"}">
            ${sourceLabel}
          </span>
          ${isFailed &&
          html`
            <span class="modlog-status-failed" title=${action.error || "Action failed"}>
              Failed
            </span>
          `}
        </div>
        <div class="modlog-details">
          <strong>${action.moderator}</strong>
          ${" "}${action.action === "delete" ? "deleted message from" : `${action.action}ed`}${" "}
          <strong>${action.target}</strong>
          ${action.details?.channel && html` <span> in ${action.details.channel}</span> `}
        </div>
        ${action.details?.message &&
        html`
          <div class="modlog-message">
            ${action.details.message}
          </div>
        `}
        ${isFailed &&
        action.error &&
        html` <div class="modlog-error">${action.error}</div> `}
        <div class="modlog-time">${formatTimestamp(action.timestamp)}</div>
      </div>
    </div>
  `;
}

export function ModLog() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [entries, setEntries] = useState([]);

  useEffect(() => {
    loadModLog();

    // Initial sync from signal
    if (modActions.value.length > 0) {
      setEntries([...modActions.value]);
    }
  }, []);

  async function loadModLog() {
    setLoading(true);
    setError(null);

    try {
      const result = await modlog.get(200, 0);
      setEntries(result.entries || []);
      // Sync to signal for WebSocket updates to merge with
      for (const entry of (result.entries || []).reverse()) {
        addModAction(entry);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Merge WebSocket entries with loaded entries
  const mergedEntries = [...modActions.value];
  for (const entry of entries) {
    if (!mergedEntries.find((e) => e.id === entry.id)) {
      mergedEntries.push(entry);
    }
  }
  mergedEntries.sort((a, b) => b.timestamp - a.timestamp);

  return html`
    <div class="card">
      <div class="card-header">
        <span class="card-title">Moderation Log</span>
        <span class="text-muted">${mergedEntries.length} actions</span>
      </div>
      <div class="card-body">
        ${error &&
        html` <div class="alert alert-error" style="margin-bottom: 1rem;">${error}</div> `}
        ${loading
          ? html`
              <div class="loading-state">
                <div class="spinner"></div>
                <p>Loading moderation log...</p>
              </div>
            `
          : mergedEntries.length === 0
            ? html`
                <div class="empty-state">
                  <div class="empty-state-icon">📋</div>
                  <p>No moderation actions recorded yet.</p>
                </div>
              `
            : html`
                <div class="modlog-list">
                  ${mergedEntries.map(
                    (action) => html` <${ModLogEntry} key=${action.id} action=${action} /> `
                  )}
                </div>
              `}
      </div>
    </div>

    <style>
      .modlog-list {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }

      .modlog-entry {
        display: flex;
        gap: 0.75rem;
        padding: 0.75rem;
        background: var(--bg-secondary);
        border-radius: 0.5rem;
        border: 1px solid var(--border-color);
      }

      .modlog-content {
        flex: 1;
        min-width: 0;
      }

      .modlog-header {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        align-items: center;
        margin-bottom: 0.25rem;
      }

      .modlog-source {
        font-size: 0.75rem;
        padding: 0.125rem 0.5rem;
        border-radius: 9999px;
        font-weight: 500;
      }

      .modlog-source--discord {
        background: rgba(88, 101, 242, 0.15);
        color: #7289da;
      }

      .modlog-source--dashboard {
        background: rgba(139, 92, 246, 0.15);
        color: #a78bfa;
      }

      .modlog-status-failed {
        font-size: 0.75rem;
        padding: 0.125rem 0.5rem;
        border-radius: 9999px;
        font-weight: 600;
        background: rgba(239, 68, 68, 0.15);
        color: var(--error);
        cursor: help;
      }

      .modlog-details {
        font-size: 0.875rem;
        color: var(--text-secondary);
      }

      .modlog-message {
        margin-top: 0.5rem;
        padding: 0.5rem;
        background: var(--bg-tertiary);
        border-radius: 4px;
        font-size: 0.875rem;
      }

      .modlog-error {
        margin-top: 0.25rem;
        font-size: 0.75rem;
        color: var(--error);
      }

      .modlog-time {
        margin-top: 0.25rem;
        font-size: 0.75rem;
        color: var(--text-muted);
      }

      .loading-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1rem;
        padding: 2rem;
        color: var(--text-muted);
      }

      .spinner {
        width: 2rem;
        height: 2rem;
        border: 2px solid var(--border-color);
        border-top-color: var(--primary);
        border-radius: 50%;
        animation: spin 1s linear infinite;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    </style>
  `;
}
