import { html } from "htm/preact";
import { user, currentRoute, navigate, wsConnected, wsConnecting, canModerate, canAdmin } from "../state.js";
import { auth } from "../api.js";

function NavLink({ href, icon, children, requireMod, requireAdmin }) {
  const isActive = currentRoute.value === href;

  // Check permissions
  if (requireAdmin && !canAdmin.value) return null;
  if (requireMod && !canModerate.value) return null;

  const handleClick = (e) => {
    e.preventDefault();
    navigate(href);
  };

  return html`
    <li class="nav-item">
      <a href=${href} class="nav-link ${isActive ? "active" : ""}" onClick=${handleClick}>
        <span class="nav-icon">${icon}</span>
        ${children}
      </a>
    </li>
  `;
}

function Sidebar() {
  const handleLogout = async () => {
    try {
      await auth.logout();
      window.location.href = "/";
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };

  const permissionName = ["Viewer", "Moderator", "Admin"][user.value?.permission ?? 0];

  return html`
    <aside class="sidebar">
      <div class="sidebar-header">
        <div class="sidebar-logo">
          <span>🍬</span>
          <span>Kandy Chat</span>
        </div>
      </div>

      <nav>
        <ul class="nav-menu">
          <${NavLink} href="/" icon="📊">Dashboard<//>
          <${NavLink} href="/chat" icon="💬">Chat Monitor<//>
          <${NavLink} href="/modlog" icon="📋" requireMod>Mod Log<//>
          <${NavLink} href="/blacklist" icon="🚫" requireMod>Blacklist<//>
          <${NavLink} href="/settings" icon="⚙️" requireMod>Settings<//>
          <${NavLink} href="/control" icon="🎛️" requireAdmin>Control Panel<//>
        </ul>
      </nav>

      <div class="sidebar-footer">
        <div class="connection-indicator">
          <span class="connection-dot ${wsConnected.value ? "" : wsConnecting.value ? "connecting" : "disconnected"}"></span>
          ${wsConnected.value ? "Connected" : wsConnecting.value ? "Connecting..." : "Disconnected"}
        </div>

        ${user.value && html`
          <div class="user-info" style="margin-top: 0.75rem;">
            ${user.value.avatar ? html`
              <img class="user-avatar" src=${user.value.avatar} alt="" />
            ` : html`
              <div class="user-avatar"></div>
            `}
            <div>
              <div class="user-name">${user.value.username}</div>
              <div class="user-role">${permissionName}</div>
            </div>
          </div>
          <button class="btn btn-secondary btn-sm" style="width: 100%; margin-top: 0.75rem;" onClick=${handleLogout}>
            Logout
          </button>
        `}
      </div>
    </aside>
  `;
}

export function Layout({ children }) {
  return html`
    <div class="dashboard">
      <${Sidebar} />
      <main class="main-content">
        ${children}
      </main>
    </div>
  `;
}
