import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { control } from "../api.js";

export function ControlPanel() {
  const [restarting, setRestarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [message, setMessage] = useState(null);

  const handleRestart = async () => {
    if (!confirm("Are you sure you want to restart the bot?")) return;

    setRestarting(true);
    setMessage(null);

    try {
      await control.restart();
      setMessage({ type: "success", text: "Bot is restarting..." });
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setRestarting(false);
    }
  };

  const handleStop = async () => {
    if (!confirm("Are you sure you want to stop the bot? It will not restart automatically."))
      return;

    setStopping(true);
    setMessage(null);

    try {
      await control.stop();
      setMessage({ type: "success", text: "Bot is stopping..." });
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setStopping(false);
    }
  };

  return html`
    <div class="card">
      <div class="card-header">
        <span class="card-title">Bot Control</span>
      </div>
      <div class="card-body">
        ${message &&
        html`
          <div
            class="alert ${message.type === "error" ? "alert-error" : "alert-success"}"
            style="margin-bottom: 1rem;"
          >
            ${message.text}
          </div>
        `}

        <div class="alert alert-warning" style="margin-bottom: 1.5rem;">
          <strong>Warning:</strong> These actions affect the live bot. Use with caution.
        </div>

        <div style="display: flex; gap: 1rem; flex-wrap: wrap;">
          <button
            class="btn btn-primary"
            onClick=${handleRestart}
            disabled=${restarting || stopping}
          >
            ${restarting ? "Restarting..." : "🔄 Restart Bot"}
          </button>

          <button class="btn btn-danger" onClick=${handleStop} disabled=${restarting || stopping}>
            ${stopping ? "Stopping..." : "⛔ Stop Bot"}
          </button>
        </div>

        <div
          style="margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid var(--border-color);"
        >
          <h4 style="margin-bottom: 0.5rem;">Actions</h4>
          <ul style="color: var(--text-secondary); padding-left: 1.5rem;">
            <li>
              <strong>Restart:</strong> Stops and restarts the bot process. The bot will reconnect
              to Discord and Twitch.
            </li>
            <li>
              <strong>Stop:</strong> Stops the bot and prevents automatic restart. Use the Restart
              command to start again.
            </li>
          </ul>
        </div>
      </div>
    </div>
  `;
}
