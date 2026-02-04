import { html } from "htm/preact";

export function LoginPage() {
  // Check for error in URL
  const urlParams = new URLSearchParams(window.location.search);
  const error = urlParams.get("error");

  const errorMessages = {
    discord_denied: "Discord login was cancelled or denied.",
    twitch_denied: "Twitch login was cancelled or denied.",
    invalid_state: "Invalid authentication state. Please try again.",
    no_code: "Authentication code not received. Please try again.",
    auth_failed: "Authentication failed. Please try again.",
    session_expired: "Your session has expired. Please log in again.",
    access_denied: "Access denied. You must be a moderator or admin to use this dashboard."
  };

  return html`
    <div class="login-page">
      <div class="login-card">
        <div style="font-size: 3rem; margin-bottom: 1rem;">🌸</div>
        <h1 class="login-title">Kandy Chat Dashboard</h1>
        <p class="login-subtitle">Sign in to access the dashboard</p>

        ${error && html`
          <div class="alert alert-error" style="text-align: left; margin-bottom: 1.5rem;">
            ${errorMessages[error] || "An error occurred during login."}
          </div>
        `}

        <div class="login-buttons">
          <a href="/auth/discord" class="btn btn-discord">
            <svg width="20" height="20" viewBox="0 0 71 55" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M60.1045 4.8978C55.5792 2.8214 50.7265 1.2916 45.6527 0.41542C45.5603 0.39851 45.468 0.440769 45.4204 0.525289C44.7963 1.6353 44.105 3.0834 43.6209 4.2216C38.1637 3.4046 32.7345 3.4046 27.3892 4.2216C26.905 3.0581 26.1886 1.6353 25.5617 0.525289C25.5141 0.443589 25.4218 0.40133 25.3294 0.41542C20.2584 1.2888 15.4057 2.8186 10.8776 4.8978C10.8384 4.9147 10.8048 4.9429 10.7825 4.9795C1.57795 18.7309 -0.943561 32.1443 0.293408 45.3914C0.299005 45.4562 0.335386 45.5182 0.385761 45.5576C6.45866 50.0174 12.3413 52.7249 18.1147 54.5195C18.2071 54.5477 18.305 54.5139 18.3638 54.4378C19.7295 52.5728 20.9469 50.6063 21.9907 48.5383C22.0523 48.4172 21.9935 48.2735 21.8676 48.2256C19.9366 47.4931 18.0979 46.6 16.3292 45.5858C16.1893 45.5041 16.1781 45.304 16.3068 45.2082C16.679 44.9293 17.0513 44.6391 17.4067 44.3461C17.471 44.2926 17.5606 44.2813 17.6362 44.3151C29.2558 49.6202 41.8354 49.6202 53.3179 44.3151C53.3935 44.2785 53.4804 44.2898 53.5475 44.3433C53.9029 44.6363 54.2751 44.9293 54.6501 45.2082C54.7788 45.304 54.7676 45.5041 54.6277 45.5858C52.859 46.6197 51.0203 47.4931 49.0893 48.2228C48.9634 48.2707 48.9074 48.4172 48.969 48.5383C50.0381 50.6035 51.2555 52.5699 52.5929 54.435C52.6489 54.5139 52.7496 54.5477 52.8419 54.5195C58.6426 52.7249 64.5253 50.0174 70.5982 45.5576C70.6513 45.5182 70.6849 45.459 70.6905 45.3942C72.1747 30.0791 68.2147 16.7757 60.1968 4.9823C60.1772 4.9429 60.1437 4.9147 60.1045 4.8978ZM23.7259 37.3253C20.2276 37.3253 17.3451 34.1136 17.3451 30.1693C17.3451 26.225 20.1717 23.0133 23.7259 23.0133C27.308 23.0133 30.1626 26.2532 30.1099 30.1693C30.1099 34.1136 27.2789 37.3253 23.7259 37.3253ZM47.3178 37.3253C43.8196 37.3253 40.9371 34.1136 40.9371 30.1693C40.9371 26.225 43.7636 23.0133 47.3178 23.0133C50.8999 23.0133 53.7545 26.2532 53.7018 30.1693C53.7018 34.1136 50.8999 37.3253 47.3178 37.3253Z" fill="currentColor"/>
            </svg>
            Continue with Discord
          </a>

          <a href="/auth/twitch" class="btn btn-twitch">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/>
            </svg>
            Continue with Twitch
          </a>
        </div>

        <p style="margin-top: 2rem; font-size: 0.75rem; color: var(--text-muted);">
          Your access level is determined by your Discord roles or Twitch moderator status.
        </p>
      </div>
    </div>
  `;
}
