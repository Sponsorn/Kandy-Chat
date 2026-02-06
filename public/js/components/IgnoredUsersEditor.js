import { html } from "htm/preact";
import { useState, useEffect } from "preact/hooks";
import { chat } from "../api.js";

function IgnoredUserItem({ username, onRemove }) {
  const [removing, setRemoving] = useState(false);

  const handleRemove = async () => {
    setRemoving(true);
    try {
      await onRemove(username);
    } finally {
      setRemoving(false);
    }
  };

  return html`
    <div class="blacklist-item">
      <span class="blacklist-word">${username}</span>
      <button class="btn-icon" onClick=${handleRemove} disabled=${removing} title="Remove">
        ${removing ? "..." : "\u2715"}
      </button>
    </div>
  `;
}

export function IgnoredUsersEditor() {
  const [newUsername, setNewUsername] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [togglingDebug, setTogglingDebug] = useState(false);

  const fetchIgnoredUsers = async () => {
    try {
      const result = await chat.getIgnoredUsers();
      setUsers(result.ignoredUsers || []);
    } catch (err) {
      console.error("Failed to fetch ignored users:", err);
    } finally {
      setLoading(false);
    }
  };

  const fetchSettings = async () => {
    try {
      const result = await chat.getSettings();
      setDebugEnabled(result.debug || false);
    } catch (err) {
      console.error("Failed to fetch chat settings:", err);
    }
  };

  useEffect(() => {
    fetchIgnoredUsers();
    fetchSettings();
  }, []);

  const handleToggleDebug = async () => {
    setTogglingDebug(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await chat.updateSettings({ debug: !debugEnabled });
      if (result.success) {
        setDebugEnabled(!debugEnabled);
        setSuccess(`Chat feed debug logging ${!debugEnabled ? "enabled" : "disabled"}`);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setTogglingDebug(false);
    }
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!newUsername.trim()) return;

    setAdding(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await chat.addIgnoredUser(newUsername.trim());
      if (result.success) {
        setSuccess(`Added "${newUsername.trim()}" to ignored users`);
        setNewUsername("");
        setUsers(result.ignoredUsers || []);
      } else {
        setError(result.message || "Failed to add user");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (username) => {
    setError(null);
    setSuccess(null);

    try {
      const result = await chat.removeIgnoredUser(username);
      if (result.success) {
        setSuccess(`Removed "${username}" from ignored users`);
        setUsers(result.ignoredUsers || []);
      } else {
        setError(result.message || "Failed to remove user");
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const sortedUsers = [...users].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );

  return html`
    <div class="card">
      <div class="card-header">
        <span class="card-title">Chat Feed Settings</span>
      </div>
      <div class="card-body">
        <div
          style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border-color);"
        >
          <div>
            <div style="font-weight: 500;">Debug Logging</div>
            <div style="font-size: 0.75rem; color: var(--text-muted);">
              Log captured messages to console
            </div>
          </div>
          <button
            class="btn ${debugEnabled ? "btn-primary" : "btn-secondary"}"
            onClick=${handleToggleDebug}
            disabled=${togglingDebug}
          >
            ${togglingDebug ? "..." : debugEnabled ? "Enabled" : "Disabled"}
          </button>
        </div>

        <div style="font-weight: 500; margin-bottom: 0.5rem;">
          Ignored Users
          <span class="text-muted" style="font-weight: normal;">(${users.length})</span>
        </div>
        ${error &&
        html` <div class="alert alert-error" style="margin-bottom: 1rem;">${error}</div> `}
        ${success &&
        html` <div class="alert alert-success" style="margin-bottom: 1rem;">${success}</div> `}

        <form onSubmit=${handleAdd} style="margin-bottom: 1rem;">
          <div style="display: flex; gap: 0.5rem;">
            <input
              type="text"
              class="form-input"
              placeholder="Username to ignore..."
              value=${newUsername}
              onInput=${(e) => setNewUsername(e.target.value)}
              disabled=${adding}
            />
            <button type="submit" class="btn btn-primary" disabled=${adding || !newUsername.trim()}>
              ${adding ? "Adding..." : "Add"}
            </button>
          </div>
          <p style="margin-top: 0.5rem; color: var(--text-muted); font-size: 0.75rem;">
            Messages from ignored users will not appear in the chat feed or be stored. Common bots:
            nightbot, streamelements, moobot, streamlabs
          </p>
        </form>

        ${loading
          ? html`
              <div class="empty-state">
                <p>Loading...</p>
              </div>
            `
          : sortedUsers.length === 0
            ? html`
                <div class="empty-state">
                  <div class="empty-state-icon">👁️</div>
                  <p>No users ignored</p>
                </div>
              `
            : html`
                <div class="blacklist-list">
                  ${sortedUsers.map(
                    (username) => html`
                      <${IgnoredUserItem}
                        key=${username}
                        username=${username}
                        onRemove=${handleRemove}
                      />
                    `
                  )}
                </div>
              `}
      </div>
    </div>
  `;
}
