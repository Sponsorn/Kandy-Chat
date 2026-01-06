# Kandy Relay Chat Twitch -> Discord

Minimal Discord bot that relays Twitch chat into a Discord channel, with basic filters.

## Setup

1) Install dependencies

```bash
npm install
```

2) Copy env file

```bash
copy .env.example .env
```

3) Fill out `.env`:
- `DISCORD_TOKEN`: your bot token
- `DISCORD_CHANNEL_ID`: target channel id
- `DISCORD_CLIENT_ID`: application client id
- `DISCORD_GUILD_ID`: guild id for slash commands
- `ADMIN_ROLE_ID`: admin role allowed to use `/klb restart`
- `MOD_ROLE_ID`: mod role allowed to use `/klb restart`
- `TWITCH_USERNAME`: Twitch bot username
- `TWITCH_OAUTH`: IRC oauth token (format: `oauth:xxxx`), or use refresh flow below
- `TWITCH_CHANNEL`: channel to read (no #)

Optional (auto refresh tokens):
- `TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_SECRET`
- `TWITCH_REFRESH_TOKEN`

4) Start

```bash
npm start
```

## Filters

Set in `.env`:
- `FILTER_BLOCK_COMMANDS=true` blocks `!commands`
- `FILTER_BLOCKED_WORDS=badword1,badword2` word list for content filter
- `FILTER_ONLY_BLOCKED_WORDS=true` only messages containing a listed word pass
- `SUSPICIOUS_FLAG_ENABLED=true` append a warning when a message matches blacklist words
- `REACTION_DELETE_EMOJI=` restrict reaction-based deletes to a specific emoji

## Reaction deletes (Discord -> Twitch)

When an admin/mod reacts to a relayed Discord message, the bot can delete the
original Twitch message. Requirements:
- Bot account must be a moderator in the Twitch channel.
- Discord bot must have the Guild Members intent enabled.

Optional reaction actions:
- `REACTION_TIMEOUT_EMOJI=` emoji name or ID to timeout the sender
- `REACTION_BAN_EMOJI=` emoji name or ID to ban the sender
- `REACTION_TIMEOUT_SECONDS=60` timeout duration in seconds

## Slash commands

Slash commands are registered per guild using a deploy script.

`/klb addblacklist [word]` adds a word to `data/blacklist.json`.
`/klb removeblacklist [word]` removes a word from `data/blacklist.json`.
`/klb listblacklist` lists current blacklist words.
`/klb restart` restarts the bot (admin only; requires a process manager).

Deploy:

```bash
npm run deploy-commands
```

## Freeze monitor (optional)

Detects a frozen Twitch stream by sampling frames from the HLS URL.

Requirements:
- `ffmpeg` in PATH
- An HLS URL in `FREEZE_HLS_URL` (m3u8), or set `FREEZE_CHANNEL` to auto-fetch

Env settings:
- `FREEZE_CHECK_ENABLED=true`
- `FREEZE_HLS_URL=...` (optional; if `FREEZE_CHANNEL` is not set)
- `FREEZE_CHANNEL=...` (twitch channel name for auto-fetch)
- `FREEZE_CLIENT_ID=...` (optional; defaults to Twitch web client id)
- `FREEZE_OAUTH_BEARER=...` (Helix OAuth token, without `oauth:` prefix)
- `FREEZE_TOKEN_REFRESH_SECONDS=300` (refresh token/HLS URL)
- `FREEZE_DEBUG=true` (log each sample in terminal)
- `FREEZE_ALERT_ROLE_ID=...` (role mention for freeze alerts)
- `FREEZE_OFFLINE_FAILS=3` (consecutive failures before declaring offline)
- `FREEZE_OFFLINE_BACKOFF_SECONDS=30` (delay between checks when offline)
- `FREEZE_SAMPLE_SECONDS=5` (how often to sample)
- `FREEZE_THRESHOLD_SECONDS=20` (unchanged duration to declare frozen)
- `FILTER_ALLOWED_USERS` allowlist (comma-separated)
- `FILTER_BLOCKED_USERS` blocklist (comma-separated)
- `FILTER_BLOCK_EMOTES=true` blocks emote-only messages
