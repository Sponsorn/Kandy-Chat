import { html } from "htm/preact";
import { useState, useEffect, useRef } from "preact/hooks";
import { botLogs } from "../state.js";

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("sv-SE", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

const LEVEL_STYLES = {
  info: { color: "var(--text-primary)", label: "INFO" },
  warn: { color: "var(--warning)", label: "WARN" },
  error: { color: "var(--error)", label: "ERR " }
};

export function BotLog() {
  const [logs, setLogs] = useState(botLogs.value);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState("all"); // "all", "info", "warn", "error"
  const [searchTerm, setSearchTerm] = useState("");
  const feedRef = useRef(null);

  useEffect(() => {
    setLogs([...botLogs.value]);
    const unsubscribe = botLogs.subscribe((value) => {
      setLogs([...value]);
    });
    return () => unsubscribe();
  }, []);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const filteredLogs = logs.filter((entry) => {
    if (filter !== "all" && entry.level !== filter) return false;
    if (searchTerm) {
      return entry.message.toLowerCase().includes(searchTerm.toLowerCase());
    }
    return true;
  });

  return html`
    <div class="card">
      <div class="card-header">
        <span class="card-title">Bot Logs</span>
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <input
            type="text"
            class="form-input"
            placeholder="Search logs..."
            value=${searchTerm}
            onInput=${(e) => setSearchTerm(e.target.value)}
            style="width: 160px; padding: 0.25rem 0.5rem; font-size: 0.75rem;"
          />
          <select
            class="form-input"
            value=${filter}
            onChange=${(e) => setFilter(e.target.value)}
            style="padding: 0.25rem 0.5rem; font-size: 0.75rem;"
          >
            <option value="all">All levels</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
          <button
            class="btn btn-sm ${autoScroll ? "btn-primary" : "btn-secondary"}"
            onClick=${() => {
              const newValue = !autoScroll;
              setAutoScroll(newValue);
              if (newValue && feedRef.current) {
                feedRef.current.scrollTop = feedRef.current.scrollHeight;
              }
            }}
            title=${autoScroll ? "Auto-scroll enabled" : "Auto-scroll disabled"}
          >
            ${autoScroll ? "Auto" : "Paused"}
          </button>
          <span class="text-muted">${filteredLogs.length} entries</span>
        </div>
      </div>
      <div class="bot-log-feed" ref=${feedRef}>
        ${filteredLogs.length === 0
          ? html`
              <div class="empty-state-small">
                <p>
                  ${searchTerm || filter !== "all"
                    ? "No matching log entries"
                    : "No log entries yet"}
                </p>
              </div>
            `
          : filteredLogs.map(
              (entry) => html`
                <div key=${entry.id} class="bot-log-line bot-log-${entry.level}">
                  <span class="bot-log-time">${formatTime(entry.timestamp)}</span>
                  <span
                    class="bot-log-level"
                    style="color: ${LEVEL_STYLES[entry.level]?.color || "var(--text-primary)"}"
                    >${LEVEL_STYLES[entry.level]?.label || entry.level}</span
                  >
                  <span class="bot-log-message">${entry.message}</span>
                </div>
              `
            )}
      </div>
    </div>

    <style>
      .bot-log-feed {
        font-family: "Cascadia Code", "Fira Code", "JetBrains Mono", "Consolas", monospace;
        font-size: 0.8125rem;
        line-height: 1.5;
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-top: none;
        border-radius: 0 0 0.5rem 0.5rem;
        max-height: 70vh;
        overflow-y: auto;
        padding: 0.5rem;
      }

      .bot-log-line {
        display: flex;
        gap: 0.75rem;
        padding: 0.125rem 0.25rem;
        border-radius: 0.25rem;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .bot-log-line:hover {
        background: var(--bg-secondary);
      }

      .bot-log-time {
        color: var(--text-muted);
        flex-shrink: 0;
      }

      .bot-log-level {
        font-weight: 600;
        flex-shrink: 0;
        width: 3rem;
      }

      .bot-log-message {
        flex: 1;
        min-width: 0;
      }

      .bot-log-warn {
        background: rgba(var(--warning-rgb, 255, 193, 7), 0.05);
      }

      .bot-log-error {
        background: rgba(var(--error-rgb, 239, 68, 68), 0.08);
      }
    </style>
  `;
}
