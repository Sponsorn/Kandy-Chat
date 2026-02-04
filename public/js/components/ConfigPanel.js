import { html } from "htm/preact";
import { useState, useEffect } from "preact/hooks";
import { config } from "../api.js";

function ConfigSection({ title, children }) {
  return html`
    <div class="card" style="margin-bottom: 1rem;">
      <div class="card-header">
        <span class="card-title">${title}</span>
      </div>
      <div class="card-body">
        ${children}
      </div>
    </div>
  `;
}

function ConfigItem({ label, value, type = "text" }) {
  const displayValue = () => {
    if (value === null || value === undefined) return "Not set";
    if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
    if (Array.isArray(value)) return value.length ? value.join(", ") : "None";
    return String(value);
  };

  return html`
    <div style="display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid var(--border-color);">
      <span style="color: var(--text-secondary);">${label}</span>
      <span style="font-family: monospace;">${displayValue()}</span>
    </div>
  `;
}

export function ConfigPanel() {
  const [configData, setConfigData] = useState(null);
  const [channels, setChannels] = useState(null);
  const [filters, setFilters] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function loadConfig() {
      try {
        const [configResult, channelsResult, filtersResult] = await Promise.all([
          config.get(),
          config.getChannels(),
          config.getFilters()
        ]);
        setConfigData(configResult);
        setChannels(channelsResult);
        setFilters(filtersResult);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    loadConfig();
  }, []);

  if (loading) {
    return html`
      <div class="loading">
        <div class="loading-spinner"></div>
        <p>Loading configuration...</p>
      </div>
    `;
  }

  if (error) {
    return html`
      <div class="alert alert-error">
        Failed to load configuration: ${error}
      </div>
    `;
  }

  return html`
    <div>
      <${ConfigSection} title="Channels">
        <${ConfigItem} label="Twitch Channels" value=${channels?.twitch} />
        <${ConfigItem} label="Relay Filter" value=${channels?.relayFilter || "All channels"} />
        <${ConfigItem}
          label="Channel Mapping"
          value=${Object.keys(channels?.mapping || {}).length > 0
            ? Object.entries(channels.mapping).map(([t, d]) => `${t} → ${d}`).join(", ")
            : "No mapping configured"}
        />
      <//>

      <${ConfigSection} title="Filters">
        <${ConfigItem} label="Block Commands" value=${filters?.blockCommands} />
        <${ConfigItem} label="Block Emote-Only" value=${filters?.blockEmotes} />
        <${ConfigItem} label="Only Blocked Words" value=${filters?.onlyBlockedWords} />
        <${ConfigItem} label="Blocked Words Count" value=${filters?.blockedWordsCount} />
        <${ConfigItem} label="Blocked Regex Count" value=${filters?.blockedRegexCount} />
        <${ConfigItem} label="Allowed Users" value=${filters?.allowedUsersCount} />
        <${ConfigItem} label="Blocked Users" value=${filters?.blockedUsersCount} />
      <//>

      <${ConfigSection} title="Alerts">
        <${ConfigItem} label="Suspicious Flag" value=${configData?.filters?.suspiciousFlagEnabled} />
        <${ConfigItem} label="Reaction Timeout" value=${`${configData?.filters?.reactionTimeoutSeconds}s`} />
        <${ConfigItem} label="Freeze Alert Role" value=${configData?.alerts?.freezeAlertRoleId || "Not set"} />
        <${ConfigItem} label="Stream Alert Role" value=${configData?.alerts?.streamAlertRoleId || "Not set"} />
      <//>

      <div class="alert alert-warning" style="margin-top: 1rem;">
        <strong>Note:</strong> Configuration changes require editing the .env file and restarting the bot.
      </div>
    </div>
  `;
}
