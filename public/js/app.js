import { render } from "preact";
import { html } from "htm/preact";
import { useEffect } from "preact/hooks";
import { user, isAuthenticated, currentRoute, canModerate, canAdmin } from "./state.js";
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

// Pages
function HomePage() {
  return html`
    <div>
      <header class="page-header">
        <h1 class="page-title">Dashboard</h1>
        <p class="page-subtitle">Overview of bot status and activity</p>
      </header>
      <${StatusGrid} />
      <${ChatFeed} />
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
function Router() {
  const route = currentRoute.value;

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
    default:
      return html`<${NotFoundPage} />`;
  }
}

// Main App component
function App() {
  useEffect(() => {
    // Check authentication on mount
    auth.getMe()
      .then(data => {
        if (data.authenticated) {
          // Set user with permission in a single signal update
          user.value = { ...data.user, permission: data.permission };
          // Connect WebSocket after authentication
          connect();
        } else {
          user.value = null;
        }
      })
      .catch(err => {
        console.error("Auth check failed:", err);
        user.value = null;
      });

    // Cleanup WebSocket on unmount
    return () => {
      disconnect();
    };
  }, []);

  // Show login page if not authenticated
  if (!isAuthenticated.value) {
    return html`<${LoginPage} />`;
  }

  // Show main app with layout
  return html`
    <${Layout}>
      <${Router} />
    <//>
  `;
}

// Mount the app
render(html`<${App} />`, document.getElementById("app"));
