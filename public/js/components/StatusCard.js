import { html } from "htm/preact";
import { useState, useEffect } from "preact/hooks";
import { botStatus, streamStatus, metrics, freezeDetectedAt } from "../state.js";

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
  const [stream, setStream] = useState(streamStatus.value);
  const [stats, setStats] = useState(metrics.value);
  const [frozenAt, setFrozenAt] = useState(freezeDetectedAt.value);

  // Sync state from signals on mount and when signals change
  useEffect(() => {
    // Initialize with current signal values on mount
    setStatus({ ...botStatus.value });
    setStream(streamStatus.value);
    setStats({ ...metrics.value });
    setFrozenAt(freezeDetectedAt.value);

    const handleStatusUpdate = () => {
      setStatus({ ...botStatus.value });
      setStream(streamStatus.value);
      setStats({ ...metrics.value });
      setFrozenAt(freezeDetectedAt.value);
    };

    window.addEventListener("app:status-update", handleStatusUpdate);
    return () => window.removeEventListener("app:status-update", handleStatusUpdate);
  }, []);

  const formatUptime = () => {
    return status.uptimeString || "Unknown";
  };

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
    <div class="status-grid">
      <${StatusCard}
        label="Bot Status"
        value=${status.connections?.discord && status.connections?.twitch ? "Online" : "Partial"}
        className=${status.connections?.discord && status.connections?.twitch ? "online" : "warning"}
      />
      <${StatusCard}
        label="Uptime"
        value=${formatUptime()}
      />
      <${StatusCard}
        label="Stream Status"
        value=${getStreamStatusText()}
        className=${getStreamStatusClass()}
      />
      <${StatusCard}
        label="Messages Relayed"
        value=${stats.messagesRelayed.toLocaleString()}
      />
      <${StatusCard}
        label="Messages Filtered"
        value=${stats.messagesFiltered.toLocaleString()}
      />
      <${StatusCard}
        label="Mod Actions"
        value=${stats.moderationActions.toLocaleString()}
      />
    </div>
  `;
}
