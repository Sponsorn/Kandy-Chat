import { html } from "htm/preact";
import { useState, useEffect } from "preact/hooks";
import { botStatus, metrics } from "../state.js";

export function StatusCard({ label, value, className = "" }) {
  return html`
    <div class="status-card">
      <div class="status-label">${label}</div>
      <div class="status-value ${className}">${value}</div>
    </div>
  `;
}

export function StatusGrid() {
  const [status, setStatus] = useState(botStatus.value);
  const [stats, setStats] = useState(metrics.value);

  // Sync state from signals on mount and when signals change
  useEffect(() => {
    // Initialize with current signal values on mount
    setStatus({ ...botStatus.value });
    setStats({ ...metrics.value });

    const handleStatusUpdate = () => {
      setStatus({ ...botStatus.value });
      setStats({ ...metrics.value });
    };

    window.addEventListener("app:status-update", handleStatusUpdate);
    return () => window.removeEventListener("app:status-update", handleStatusUpdate);
  }, []);

  const formatUptime = () => {
    return status.uptimeString || "Unknown";
  };

  return html`
    <div class="status-grid">
      <${StatusCard}
        label="Bot Status"
        value=${status.connections?.discord && status.connections?.twitch ? "Online" : "Partial"}
        className=${status.connections?.discord && status.connections?.twitch
          ? "online"
          : "warning"}
      />
      <${StatusCard} label="Uptime" value=${formatUptime()} />
      <${StatusCard} label="Messages Relayed" value=${stats.messagesRelayed.toLocaleString()} />
      <${StatusCard} label="Messages Filtered" value=${stats.messagesFiltered.toLocaleString()} />
      <${StatusCard} label="Mod Actions" value=${stats.moderationActions.toLocaleString()} />
    </div>
  `;
}
