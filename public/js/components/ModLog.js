import { html } from "htm/preact";
import { modActions } from "../state.js";

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString("sv-SE");
}

function ModLogEntry({ action }) {
  return html`
    <div class="mod-log-entry">
      <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.25rem;">
        <span class="mod-action ${action.action}">${action.action}</span>
        <span class="chat-timestamp">${formatTime(action.timestamp)}</span>
      </div>
      <div style="color: var(--text-secondary);">
        <strong>${action.moderator}</strong> ${action.action === "delete" ? "deleted message from" : `${action.action}ed`} <strong>${action.target}</strong>
        ${action.details?.channel && html`
          <span> in ${action.details.channel}</span>
        `}
      </div>
      ${action.details?.message && html`
        <div style="margin-top: 0.5rem; padding: 0.5rem; background: var(--bg-tertiary); border-radius: 4px; font-size: 0.875rem;">
          ${action.details.message}
        </div>
      `}
    </div>
  `;
}

export function ModLog() {
  const actions = modActions.value;

  if (actions.length === 0) {
    return html`
      <div class="card">
        <div class="card-header">
          <span class="card-title">Moderation Log</span>
        </div>
        <div class="card-body">
          <div class="empty-state">
            <div class="empty-state-icon">📋</div>
            <p>No moderation actions recorded yet.</p>
          </div>
        </div>
      </div>
    `;
  }

  return html`
    <div class="card">
      <div class="card-header">
        <span class="card-title">Moderation Log</span>
        <span class="text-muted">${actions.length} actions</span>
      </div>
      <div class="card-body" style="padding: 0; max-height: 600px; overflow-y: auto;">
        ${actions.map(action => html`
          <${ModLogEntry} key=${action.id} action=${action} />
        `)}
      </div>
    </div>
  `;
}
