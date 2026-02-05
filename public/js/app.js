import { render } from "preact";
import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { user, currentRoute, canModerate, canAdmin, twitchChannels } from "./state.js";
import { auth } from "./api.js";
import { connect, disconnect } from "./websocket.js";

// Components
import { Layout } from "./components/Layout.js";
import { LoginPage } from "./components/LoginPage.js";
import { StatusGrid } from "./components/StatusCard.js";
import { ChatFeed } from "./components/ChatFeed.js";
import { ModLog } from "./components/ModLog.js";
import { BlacklistEditor } from "./components/BlacklistEditor.js";
import { ConfigPanel } from "./components/ConfigPanel.js";
import { ControlPanel } from "./components/ControlPanel.js";
import { AuditLog } from "./components/AuditLog.js";
import { ChannelColumn } from "./components/ChannelColumn.js";
import { IgnoredUsersEditor } from "./components/IgnoredUsersEditor.js";

// Utility to format channel display name
function formatChannelName(channel) {
  if (!channel) return channel;
  return channel.charAt(0).toUpperCase() + channel.slice(1);
}

// Pages
function HomePage() {
  const [channels, setChannels] = useState(twitchChannels.value);

  useEffect(() => {
    setChannels([...twitchChannels.value]);

    const handleStatusUpdate = () => {
      setChannels([...twitchChannels.value]);
    };

    window.addEventListener("app:status-update", handleStatusUpdate);
    return () => window.removeEventListener("app:status-update", handleStatusUpdate);
  }, []);

  return html`
    <div>
      <header class="page-header">
        <h1 class="page-title">Dashboard</h1>
        <p class="page-subtitle">Overview of bot status and activity</p>
      </header>
      <${StatusGrid} />
      ${channels.length > 0 ? html`
        <div class="channel-columns">
          ${channels.map(channel => html`
            <${ChannelColumn}
              key=${channel}
              channel=${channel}
              displayName=${formatChannelName(channel)}
            />
          `)}
        </div>
      ` : html`
        <${ChatFeed} />
      `}
    </div>
  `;
}

function ChatPage() {
  return html`
    <div>
      <header class="page-header">
        <h1 class="page-title">Chat Monitor</h1>
        <p class="page-subtitle">Real-time Twitch chat feed</p>
      </header>
      <${ChatFeed} />
    </div>
  `;
}

function ModLogPage() {
  if (!canModerate.value) {
    return html`
      <div class="alert alert-error">
        You don't have permission to view this page.
      </div>
    `;
  }

  return html`
    <div>
      <header class="page-header">
        <h1 class="page-title">Moderation Log</h1>
        <p class="page-subtitle">Recent moderation actions</p>
      </header>
      <${ModLog} />
    </div>
  `;
}

function BlacklistPage() {
  if (!canModerate.value) {
    return html`
      <div class="alert alert-error">
        You don't have permission to view this page.
      </div>
    `;
  }

  return html`
    <div>
      <header class="page-header">
        <h1 class="page-title">Blacklist</h1>
        <p class="page-subtitle">Manage blocked words and patterns</p>
      </header>
      <${BlacklistEditor} />
    </div>
  `;
}

function SettingsPage() {
  if (!canModerate.value) {
    return html`
      <div class="alert alert-error">
        You don't have permission to view this page.
      </div>
    `;
  }

  return html`
    <div>
      <header class="page-header">
        <h1 class="page-title">Settings</h1>
        <p class="page-subtitle">Bot configuration</p>
      </header>
      <${ConfigPanel} />
      <div style="margin-top: 1.5rem;">
        <${IgnoredUsersEditor} />
      </div>
    </div>
  `;
}

function ControlPage() {
  if (!canAdmin.value) {
    return html`
      <div class="alert alert-error">
        You don't have permission to view this page.
      </div>
    `;
  }

  return html`
    <div>
      <header class="page-header">
        <h1 class="page-title">Control Panel</h1>
        <p class="page-subtitle">Bot administration</p>
      </header>
      <${ControlPanel} />
    </div>
  `;
}

function AuditPage() {
  if (!canAdmin.value) {
    return html`
      <div class="alert alert-error">
        You don't have permission to view this page.
      </div>
    `;
  }

  return html`
    <div>
      <header class="page-header">
        <h1 class="page-title">Audit Log</h1>
        <p class="page-subtitle">History of administrative actions</p>
      </header>
      <${AuditLog} />
    </div>
  `;
}

function NotFoundPage() {
  return html`
    <div class="empty-state">
      <div class="empty-state-icon">🔍</div>
      <h2>Page Not Found</h2>
      <p>The page you're looking for doesn't exist.</p>
    </div>
  `;
}

// Router
function Router({ route }) {
  switch (route) {
    case "/":
      return html`<${HomePage} />`;
    case "/chat":
      return html`<${ChatPage} />`;
    case "/modlog":
      return html`<${ModLogPage} />`;
    case "/blacklist":
      return html`<${BlacklistPage} />`;
    case "/settings":
      return html`<${SettingsPage} />`;
    case "/control":
      return html`<${ControlPage} />`;
    case "/audit":
      return html`<${AuditPage} />`;
    default:
      return html`<${NotFoundPage} />`;
  }
}

// Main App component
function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [route, setRoute] = useState(window.location.pathname);

  useEffect(() => {
    // Check authentication on mount
    auth.getMe()
      .then(data => {
        if (data.authenticated) {
          // Set user with permission in a single signal update
          user.value = { ...data.user, permission: data.permission };
          setAuthenticated(true);
          // Connect WebSocket after authentication
          connect();
        } else {
          user.value = null;
          setAuthenticated(false);
        }
        setAuthChecked(true);
      })
      .catch(err => {
        console.error("Auth check failed:", err);
        user.value = null;
        setAuthenticated(false);
        setAuthChecked(true);
      });

    // Cleanup WebSocket on unmount
    return () => {
      disconnect();
    };
  }, []);

  // Handle navigation
  useEffect(() => {
    const handleNav = (e) => {
      setRoute(e.detail || window.location.pathname);
    };
    const handlePopState = () => {
      setRoute(window.location.pathname);
    };

    window.addEventListener("app:navigate", handleNav);
    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("app:navigate", handleNav);
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  // Show loading while checking auth
  if (!authChecked) {
    return html`<div class="loading">Loading...</div>`;
  }

  // Show login page if not authenticated
  if (!authenticated) {
    return html`<${LoginPage} />`;
  }

  // Show main app with layout
  return html`
    <${Layout}>
      <${Router} route=${route} />
    <//>
  `;
}

// Mount the app
render(html`<${App} />`, document.getElementById("app"));
