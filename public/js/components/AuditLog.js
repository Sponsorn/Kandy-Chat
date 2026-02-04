import { html } from "htm/preact";
import { useState, useEffect } from "preact/hooks";
import { auditLog, addAuditEntry } from "../state.js";
import { audit } from "../api.js";

const ACTION_LABELS = {
  restart: { label: "Restart", icon: "🔄", color: "var(--warning)" },
  stop: { label: "Stop", icon: "⏹️", color: "var(--error)" },
  start: { label: "Start", icon: "▶️", color: "var(--success)" },
  config_change: { label: "Config Change", icon: "⚙️", color: "var(--info)" },
  blacklist_add: { label: "Blacklist Add", icon: "➕", color: "var(--text-muted)" },
  blacklist_remove: { label: "Blacklist Remove", icon: "➖", color: "var(--text-muted)" },
  blacklist_import: { label: "Blacklist Import", icon: "📥", color: "var(--info)" },
  blacklist_export: { label: "Blacklist Export", icon: "📤", color: "var(--info)" }
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

function AuditEntry({ entry }) {
  const actionInfo = ACTION_LABELS[entry.action] || {
    label: entry.action,
    icon: "📝",
    color: "var(--text-muted)"
  };

  const sourceLabel = {
    dashboard: "Dashboard",
    discord: "Discord",
    system: "System"
  }[entry.source] || entry.source;

  return html`
    <div class="audit-entry">
      <div class="audit-icon" style="color: ${actionInfo.color}">
        ${actionInfo.icon}
      </div>
      <div class="audit-content">
        <div class="audit-header">
          <span class="audit-action" style="color: ${actionInfo.color}">
            ${actionInfo.label}
          </span>
          <span class="audit-meta">
            by <strong>${entry.actor}</strong> via ${sourceLabel}
          </span>
        </div>
        ${entry.details?.reason && html`
          <div class="audit-details">
            ${entry.details.reason}
          </div>
        `}
        <div class="audit-time">
          ${formatTimestamp(entry.timestamp)}
        </div>
      </div>
    </div>
  `;
}

export function AuditLog() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [entries, setEntries] = useState([]);

  useEffect(() => {
    loadAuditLog();

    // Listen for updates from state
    const handleUpdate = () => {
      setEntries([...auditLog.value]);
    };

    // Initial sync from signal
    if (auditLog.value.length > 0) {
      setEntries([...auditLog.value]);
    }

    window.addEventListener("app:audit-update", handleUpdate);
    return () => window.removeEventListener("app:audit-update", handleUpdate);
  }, []);

  async function loadAuditLog() {
    setLoading(true);
    setError(null);

    try {
      const result = await audit.get(100, 0);
      // Populate both local state and signal
      setEntries(result.entries || []);
      // Sync to signal for WebSocket updates to merge with
      for (const entry of (result.entries || []).reverse()) {
        addAuditEntry(entry);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Merge WebSocket entries with loaded entries
  const mergedEntries = [...auditLog.value];
  for (const entry of entries) {
    if (!mergedEntries.find(e => e.id === entry.id)) {
      mergedEntries.push(entry);
    }
  }
  mergedEntries.sort((a, b) => b.timestamp - a.timestamp);

  return html`
    <div class="card">
      <div class="card-header">
        <span class="card-title">Audit Log</span>
        <span class="text-muted">${mergedEntries.length} entries</span>
      </div>
      <div class="card-body">
        ${error && html`
          <div class="alert alert-error" style="margin-bottom: 1rem;">
            ${error}
          </div>
        `}

        ${loading ? html`
          <div class="loading-state">
            <div class="spinner"></div>
            <p>Loading audit log...</p>
          </div>
        ` : mergedEntries.length === 0 ? html`
          <div class="empty-state">
            <div class="empty-state-icon">📋</div>
            <p>No audit log entries yet</p>
          </div>
        ` : html`
          <div class="audit-list">
            ${mergedEntries.map(entry => html`
              <${AuditEntry} key=${entry.id} entry=${entry} />
            `)}
          </div>
        `}
      </div>
    </div>

    <style>
      .audit-list {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }

      .audit-entry {
        display: flex;
        gap: 0.75rem;
        padding: 0.75rem;
        background: var(--bg-secondary);
        border-radius: 0.5rem;
        border: 1px solid var(--border-color);
      }

      .audit-icon {
        font-size: 1.25rem;
        flex-shrink: 0;
      }

      .audit-content {
        flex: 1;
        min-width: 0;
      }

      .audit-header {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        align-items: baseline;
      }

      .audit-action {
        font-weight: 600;
      }

      .audit-meta {
        font-size: 0.875rem;
        color: var(--text-muted);
      }

      .audit-details {
        margin-top: 0.25rem;
        font-size: 0.875rem;
        color: var(--text-secondary);
      }

      .audit-time {
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
        to { transform: rotate(360deg); }
      }
    </style>
  `;
}
