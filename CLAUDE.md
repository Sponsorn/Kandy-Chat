# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Kandy Chat is a Discord bot that relays Twitch chat messages to Discord channels with content filtering, moderation tools, and stream monitoring. It bridges Twitch IRC chat with Discord, allowing moderators to manage Twitch chat from Discord using emoji reactions and slash commands.

## Common Commands

### Running the Bot
```bash
npm start                  # Start the bot
npm run deploy-commands    # Deploy Discord slash commands
npm run deploy-eventsub    # Deploy Twitch EventSub subscriptions
```

### Development
```bash
npm run lint               # ESLint check (flat config, ESM)
npm run lint:fix            # ESLint auto-fix
npm run format              # Prettier format all files
npm run format:check        # Prettier check (CI)
npm test                    # Run tests (Vitest)
npm run test:watch          # Run tests in watch mode
```

No build step — code runs directly via Node.js ESM modules.

## Architecture

### Core Message Flow
1. **Twitch → Discord**: Messages flow from Twitch IRC (via tmi.js) through filters and normalization before being relayed to Discord channels
2. **Discord → Twitch**: Moderators react to Discord messages with configured emojis to delete, timeout, ban, or warn users on Twitch
3. **Bidirectional mapping**: `relayMessageMap` and `relayDiscordMap` maintain the connection between Twitch message IDs and Discord message IDs for moderation actions

### Multi-Channel Support
- Bot can join multiple Twitch channels simultaneously
- `TWITCH_CHANNEL_MAPPING` enables routing specific Twitch channels to specific Discord channels
- `TWITCH_RELAY_CHANNELS` allows joining channels without relaying them to Discord
- Channel prefixes (`[channelname]`) are added to messages in multi-channel mode

### Key Modules

#### [src/index.js](src/index.js) (main entry point)
- Discord and Twitch client initialization
- Message relay logic and moderation reaction handling
- Slash command handlers (`/klb` subcommands)
- Twitch subscription event handlers (sub/resub/gift sub thank you messages)
- Token refresh scheduling and persistence

#### [src/filters.js](src/filters.js)
- Message filtering logic: commands, emotes, blocklist words/regex, user allowlist/blocklist
- `shouldBlockMessage()` determines if a message should be filtered out
- `normalizeMessage()` standardizes whitespace before relay

#### [src/blacklistStore.js](src/blacklistStore.js)
- Persistent JSON storage for blacklist words/regex patterns in `data/blacklist.json`
- Supports plain text and regex entries (format: `/pattern/flags`)

#### [src/twitchAuth.js](src/twitchAuth.js)
- OAuth token refresh using Twitch refresh tokens
- Called by `tokenService.js` which persists new tokens to `data/tokens.json`

#### [src/freezeMonitor.js](src/freezeMonitor.js)
- Monitors Twitch stream for freeze detection using ffmpeg frame sampling
- Hashes frames to detect motion vs frozen content
- Auto-fetches HLS URLs using Twitch GQL API
- Handles offline detection with backoff

#### [src/server/webServer.js](src/server/webServer.js)
- Combined web server for dashboard and EventSub webhooks
- Serves static frontend from `public/` directory
- OAuth authentication routes for Discord and Twitch
- Session management with secure cookies
- WebSocket server for real-time dashboard updates

#### [src/api/TwitchAPIClient.js](src/api/TwitchAPIClient.js)
- Centralized Twitch Helix API client for moderation actions (delete, timeout, ban, warn)
- Also handles blocked terms and stream status
- **Caches** broadcaster IDs, moderator ID (bot's own), and user IDs in-memory — these are immutable during bot lifetime, eliminating redundant API calls
- `clearCache()` available for manual invalidation

#### [src/utils/permissions.js](src/utils/permissions.js)
- Parses `ADMIN_ROLE_ID` and `MOD_ROLE_ID` once at module level into `ADMIN_ROLE_IDS` / `MOD_ROLE_IDS` arrays
- `hasPrivilegedRole(member)`: checks admin role, mod role, or Administrator permission
- `hasAdminRole(member)`: checks admin role or Administrator permission
- All permission checks across the codebase use these functions (no inline parsing)

#### [src/services/messageBuilder.js](src/services/messageBuilder.js)
- Pure functions that build Discord Components V2 message payloads
- `buildNormalV2Message()`, `buildSuspiciousV2Message()`, `buildDisabledV2Message()`, `buildDeletedV2Message()`
- Used when `MODERATION_USE_BUTTONS=true`

#### [src/services/tokenService.js](src/services/tokenService.js)
- Token refresh orchestration and scheduling
- Persists both access and refresh tokens to `data/tokens.json` (shared with youtube-relay)
- `loadPersistedRefreshToken()`: loads saved token at startup (overrides `.env` value)
- `createTokenProvider()`: factory for API client token access

#### [src/auth/](src/auth/)
- `sessionManager.js`: In-memory session store with permission levels (VIEWER=0, MODERATOR=1, ADMIN=2)
- `discordOAuth.js`: Discord OAuth2 flow, fetches user roles from configured guild
- `twitchOAuth.js`: Twitch OAuth2 flow, checks moderator status in configured channels

#### [src/state/BotState.js](src/state/BotState.js)
- Centralized singleton for all runtime bot state
- EventEmitter-based for dashboard real-time updates
- Manages: tokens, filters, blacklist, metrics, audit log, runtime config
- `updateRuntimeConfig(section, key, value)` applies settings to both config and runtime filters
- `getSnapshot()` returns dashboard-safe state summary

#### [src/server/websocket/dashboardSocket.js](src/server/websocket/dashboardSocket.js)
- WebSocket server for real-time dashboard updates
- All permission levels can connect (VIEWER gets limited data)
- Subscribes to BotState events and broadcasts to clients
- Default subscriptions: `stream:status`, `status:update`

#### Dashboard Frontend ([public/js/](public/js/))
- **Framework**: Preact with htm (no build step, ESM imports from CDN)
- **State**: `@preact/signals` for reactive state management
- **Key files**:
  - `app.js`: Main app component, routing, WebSocket connection
  - `state.js`: Global signals (botStatus, metrics, user, etc.) and WebSocket message handler
  - `api.js`: REST API wrapper functions
  - `components/`: StatusCard, ConfigPanel, BlacklistEditor, AuditLog, etc.

### Moderation Features

#### Reaction-Based Moderation
Moderators and admins can react to Discord messages to trigger Twitch moderation actions. The bot maintains a cache (`relayDiscordMap`) mapping Discord message IDs to Twitch message metadata (message ID, channel, username).

Supported reactions (configured via env vars):
- `REACTION_DELETE_EMOJI`: Delete the Twitch message via Helix API
- `REACTION_TIMEOUT_EMOJI`: Timeout the user (duration: `REACTION_TIMEOUT_SECONDS`)
- `REACTION_BAN_EMOJI`: Ban the user
- `REACTION_WARN_EMOJI`: Issue a formal warning

All reactions remove themselves after execution and post an action summary to the Discord channel.

#### Button-Based Moderation (Components V2)
When `MODERATION_USE_BUTTONS=true`, the bot uses Discord Components V2 instead of emoji reactions:
- All relayed messages use a V2 Container + TextDisplay layout
- Suspicious messages get a red accent border, warning text, and Delete/Timeout/Ban/Warn buttons
- Normal messages get V2 layout but no buttons
- After a button is clicked, buttons are disabled and an action label is shown
- Message builder functions live in `src/services/messageBuilder.js`
- Both systems coexist — set `MODERATION_USE_BUTTONS=false` (default) for the legacy reaction system

#### Suspicious Message Detection
Messages matching blacklist words/regex are flagged with "⚠️ Suspicious message" and automatically receive moderation reaction emojis (legacy) or V2 buttons (`MODERATION_USE_BUTTONS=true`) for quick action.

### Blacklist System

Two sources of blocked content:
1. **Base filters**: `FILTER_BLOCKED_WORDS` env var (static, set at startup)
2. **Runtime blacklist**: `data/blacklist.json` (dynamic, managed via `/klb` commands)

Both support:
- Plain text matching (case-insensitive substring)
- Regex patterns (format: `/pattern/flags`)

Blacklist can be synced with Twitch channel blocked terms:
- `/klb importblacklist [channel]`: Import Twitch channel blocked terms
- `/klb exportblacklist [channel]`: Export local blacklist to Twitch channel

### Token Management

The bot supports two authentication modes:
1. **Static OAuth**: Set `TWITCH_OAUTH` directly (format: `oauth:xxxxx`)
2. **Auto-refresh**: Set `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_REFRESH_TOKEN` for automatic token rotation

Token refresh happens at 80% of expiration time. New refresh tokens are persisted to `data/tokens.json`. At startup, the persisted token is loaded and overrides the `.env` value if present.

The same access token is shared between:
- Twitch IRC connection (tmi.js)
- Twitch Helix API calls (moderation, user lookups)
- Freeze monitor HLS access (via `FREEZE_OAUTH_BEARER`)
- YouTube relay (reads from shared `data/tokens.json`)

### Permission Model

Commands use Discord role-based permissions:
- **Moderator**: Users with `MOD_ROLE_ID` or `ADMIN_ROLE_ID` roles (or Administrator permission)
  - Can use: `/klb addblacklist`, `/klb removeblacklist`, `/klb listblacklist`, `/klb warn`
  - Can trigger reaction-based moderation
- **Admin**: Users with `ADMIN_ROLE_ID` role (or Administrator permission)
  - Can use all moderator commands plus: `/klb restart`, `/klb stop`, `/klb importblacklist`, `/klb exportblacklist`

The `/klb` command is deployed with `setDefaultMemberPermissions("0")` to hide it from everyone by default. Access must be granted via Discord's Integrations settings.

## Configuration Notes

### Environment Variables
All configuration is via `.env` file. See [.env.example](.env.example) for the complete list.

Critical dependencies between env vars:
- Multi-channel requires: `TWITCH_CHANNEL` (comma-separated)
- Channel mapping requires: `TWITCH_CHANNEL_MAPPING` (format: `twitchchannel:discordid,...)
- Freeze monitor requires: `ffmpeg` in PATH + either `FREEZE_HLS_URL` or `FREEZE_CHANNEL`
- EventSub requires: Public HTTPS URL, set via `EVENTSUB_PUBLIC_URL`

### Offline Alert Filtering
- `OFFLINE_ALERT_CHANNELS`: Comma-separated list of channels that trigger offline alerts. If not set, all `EVENTSUB_BROADCASTER` channels trigger alerts.
- `RAID_SUPPRESS_WINDOW_SECONDS`: Suppress offline alerts for this duration (in seconds) after a channel raids another (default: 30). This prevents false "went offline" messages when a streamer ends by raiding.

### Web Dashboard
- `DASHBOARD_ENABLED`: Set to `true` to enable the web dashboard
- `DASHBOARD_DOMAIN`: Domain for cookie settings and OAuth redirects (e.g., `kandyland.sponsorn.com`)
- `DASHBOARD_DISCORD_CLIENT_SECRET`: Separate client secret for dashboard OAuth (can differ from bot's)
- Dashboard uses Discord/Twitch OAuth for authentication
- Permission levels determined by Discord roles (`ADMIN_ROLE_ID`, `MOD_ROLE_ID`) or Twitch moderator status

### Data Persistence
- `data/blacklist.json`: Runtime blacklist (managed by `/klb` commands), also read by youtube-relay
- `data/blacklist-metadata.json`: Full Twitch blocked term metadata from imports
- `data/tokens.json`: Shared access + refresh tokens (written by main bot, read by youtube-relay)
- `data/emoji-mappings.json`: YouTube emoji → text mappings (managed via dashboard, read by youtube-relay)
- `data/stream-status.json`: Per-channel live status (written by main bot on EventSub events, read by youtube-relay)

## Common Patterns

### Adding a New Filter
1. Add filter config parsing in [src/filters.js](src/filters.js) `buildFilters()`
2. Add filter logic in `shouldBlockMessage()`
3. Document the env var in [.env.example](.env.example) and [README.md](README.md)

### Adding a New Slash Command
1. Add subcommand in [deploy-commands.js](deploy-commands.js)
2. Add handler in [src/index.js](src/index.js) `interactionCreate` event
3. Check permissions using `hasPrivilegedRole()` or `hasAdminRole()`
4. Run `npm run deploy-commands` to register

### Working with Twitch API
All Twitch Helix API calls go through `TwitchAPIClient` (`src/api/TwitchAPIClient.js`). The client caches broadcaster IDs, the bot's moderator ID, and user IDs in-memory, so repeated calls for the same channel/user don't hit the API.

Usage: call methods like `twitchAPIClient.deleteMessage()`, `twitchAPIClient.banUser()`, `twitchAPIClient.warnUser()`, etc. The client handles token retrieval, ID lookups, and error handling internally.

## Code Quality

### Linting & Formatting
- **ESLint**: Flat config (`eslint.config.js`), `@eslint/js` recommended rules, `no-unused-vars` as warning with `_` prefix exception, `no-console: off`
- **Prettier**: Double quotes, semicolons, 2-space tabs, no trailing commas, 100 char print width (`.prettierrc.json`)
- Browser globals (`confirm`, `prompt`, `window`, etc.) are configured for `public/js/**/*.js` files

### Testing
- **Framework**: Vitest (native ESM support, no build config needed)
- **Config**: `vitest.config.js`
- **Test files**: `tests/*.test.js`
- **Current coverage**:
  - `tests/filters.test.js`: `buildFilters()`, `shouldBlockMessage()`, `normalizeMessage()`
  - `tests/permissions.test.js`: `hasPrivilegedRole()`, `hasAdminRole()`, `ADMIN_ROLE_IDS`, `MOD_ROLE_IDS`
  - `tests/configValidator.test.js`: `validateConfig()` — required fields, Discord IDs, auth modes, channel mapping, EventSub, freeze monitor

## YouTube Relay (`youtube-relay/`)

A self-contained Python service that reads YouTube live chat and relays messages to Twitch chat. Runs as a separate Docker container alongside the main bot.

### Key Files
- `youtube-relay/bot.py`: Main coordinator — connects Twitch, starts YouTube reader, runs message relay loop. Includes spam protection (per-user rate limiting, duplicate message filtering).
- `youtube-relay/youtube_reader.py`: YouTube chat reader using yt-dlp for stream discovery and YouTube innertube API for real-time chat polling (no API key required)
- `youtube-relay/twitch_bot.py`: HTTP-only Twitch API client — sends messages via Helix API, reads shared `data/tokens.json` for auth, loads blacklist from `data/blacklist.json` with regex support
- `youtube-relay/emoji_converter.py`: Converts YouTube emoji shortcodes (`:heart:`, `:smile:`) to text using mappings from `data/emoji-mappings.json`, reloads every 5 min
- `youtube-relay/config_loader.py`: Loads config from `.env` file (auth tokens optional — reads from shared `data/tokens.json`)
- `youtube-relay/run.py`: Entry point

### How It Works
1. `YouTubeChatReader` uses yt-dlp to find the live stream, then polls YouTube's innertube API for chat messages in a daemon thread
2. Main loop consumes from the queue with `queue.get(timeout=1)`
3. Messages pass through emoji conversion, spam protection (3 msgs/30s per user, duplicate filter), and blacklist checking
4. Messages are formatted (`[YT] author: message`) and sent to Twitch via Helix API
5. Blacklist is loaded from shared `data/blacklist.json` (same file as main bot), reloads only when file changes
6. Relay watches `data/stream-status.json` (written by main bot on EventSub events) to detect stream online/offline — stops YouTube reader when offline, restarts when live again

### Token Sharing
The youtube-relay reads its Twitch access token from `data/tokens.json`, written by the main bot. This avoids token refresh race conditions. The relay only refreshes as a fallback if `tokens.json` is unavailable. Docker Compose `depends_on` ensures the main bot starts first.

### Running
```bash
# Local
cd youtube-relay && python run.py

# Docker (alongside Kandy Chat)
docker compose up -d

# Tests
cd youtube-relay && python -m pytest tests/ -v
```

### Config
See `youtube-relay/.env.example` for all configuration options. Auth tokens (`TWITCH_OAUTH_TOKEN`, `TWITCH_BOT_REFRESH_TOKEN`) are optional when running alongside the main bot.

## Deployment

### Server Environment
- **Host**: Raspberry Pi (`pi-stack`)
- **OS disk**: SD card (15G) — OS only, keep minimal
- **Data disk**: NVME mounted at `/mnt/nvme`
- **Project path**: `/mnt/nvme/kandy-chat`
- **Docker data root**: `/mnt/nvme/docker` (configured in `/etc/docker/daemon.json`)
- **Docker Compose**: runs the bot container, exposes port 8080

### Maintenance
- SD card can fill up from Docker build cache or apt cache — run `sudo docker builder prune -f` and `sudo apt clean` periodically
- No swap file on SD card (uses zram instead)

### Unused Files
- `src/eventsubServer.js`: Orphaned — superseded by EventSub handling in `src/server/webServer.js`. Safe to delete.

## Troubleshooting

### OAuth Login Fails (Can't Get Past Login Screen)
**Symptoms**: Clicking "Continue with Discord/Twitch" redirects back but user stays on login page. WebSocket may show correct permission level in logs.

**Common causes**:
1. **Malformed `DASHBOARD_DOMAIN`**: Trailing whitespace or garbage characters in `.env` will break OAuth redirect URIs and cookie domain. The code trims this value, but check `.env` if issues persist.
2. **Cached `/auth/me` response**: Browser may cache `authenticated: false` response. Hard refresh (Ctrl+Shift+R) or clear cache to fix. The `/auth/me` endpoint now sets `Cache-Control: no-store` to prevent this.
3. **Cookie domain mismatch**: Ensure `DASHBOARD_DOMAIN` matches the actual domain you're accessing (no `https://` prefix, no trailing slash).

### WebSocket Shows Permission But Dashboard Shows Login
This typically indicates the session cookie is valid (WebSocket receives it) but HTTP requests are using cached responses. Hard refresh the browser.

### OAuth Redirect URI Mismatch
Ensure the redirect URIs in Discord/Twitch developer console match exactly:
- Discord: `https://{DASHBOARD_DOMAIN}/auth/discord/callback`
- Twitch: `https://{DASHBOARD_DOMAIN}/auth/twitch/callback`

### Dashboard Shows Stale Data After Navigation
**Symptoms**: Status cards or config panels show old/empty data when navigating between pages.

**Cause**: Components need to sync from signals on mount, not just listen for update events.

**Fix pattern**: In useEffect, initialize state from signals immediately on mount:
```javascript
useEffect(() => {
  setStatus({ ...botStatus.value }); // Sync on mount
  const handleUpdate = () => setStatus({ ...botStatus.value });
  window.addEventListener("app:status-update", handleUpdate);
  return () => window.removeEventListener("app:status-update", handleUpdate);
}, []);
```

### Settings Changes Don't Affect Bot Behavior
**Symptoms**: Toggling settings in dashboard saves successfully but bot doesn't change behavior.

**Cause**: `BotState.updateRuntimeConfig()` must apply changes to both `runtimeConfig` and the active `filters` object.

**Fix**: Ensure all filter settings are applied in `updateRuntimeConfig()`:
```javascript
if (section === "filters" && this.filters) {
  if (key === "blockCommands") this.filters.blockCommands = value;
  if (key === "blockEmotes") this.filters.blockEmotes = value;
  if (key === "suspiciousFlagEnabled") this.filters.suspiciousFlagEnabled = value;
}
```
