# Kandy Relay Chat Twitch -> Discord

Minimal Discord bot that relays Twitch chat into a Discord channel, with basic filters.

## Setup

1. Install dependencies

```bash
npm install
```

2. Copy env file

```bash
copy .env.example .env
```

3. Fill out `.env`:

- `DISCORD_TOKEN`: your bot token
- `DISCORD_CHANNEL_ID`: target channel id (comma-separated supported)
- `DISCORD_CLIENT_ID`: application client id
- `DISCORD_GUILD_ID`: guild id for slash commands
- `ADMIN_ROLE_ID`: admin role(s) allowed to use `/klb restart` (comma-separated supported)
- `MOD_ROLE_ID`: mod role(s) allowed to use `/klb restart` (comma-separated supported)
- `TWITCH_USERNAME`: Twitch bot username
- `TWITCH_OAUTH`: IRC oauth token (format: `oauth:xxxx`), or use refresh flow below
- `TWITCH_CHANNEL`: channel(s) to join (no #, comma-separated for multiple channels)
- `TWITCH_CHANNEL_MAPPING`: (optional) map Twitch channels to specific Discord channels (format: `twitchchannel:discordchannelid,...`)

Optional (auto refresh tokens):

- `TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_SECRET`
- `TWITCH_REFRESH_TOKEN`

4. Start

```bash
npm start
```

## Multi-Channel Support

The bot can join multiple Twitch channels simultaneously. Configure this in `.env`:

### Basic Multi-Channel Setup

```env
TWITCH_CHANNEL=channel1,channel2,channel3
```

All messages from all channels will be relayed to all Discord channels. Messages will be prefixed with `[channelname]` to show their origin.

### Selective Relay

You can join multiple channels but only relay specific channels to Discord:

```env
TWITCH_CHANNEL=kandyland,kandylandvods
TWITCH_RELAY_CHANNELS=kandyland
```

With this configuration:

- Bot joins both `kandyland` and `kandylandvods`
- Only messages from `kandyland` are relayed to Discord
- `kandylandvods` messages are not relayed (useful for VOD channels or monitoring without spam)

### Channel Mapping (Advanced)

You can map specific Twitch channels to specific Discord channels:

```env
TWITCH_CHANNEL=channel1,channel2
DISCORD_CHANNEL_ID=123456789,987654321
TWITCH_CHANNEL_MAPPING=channel1:123456789,channel2:987654321
```

With this configuration:

- Messages from `channel1` → Discord channel `123456789`
- Messages from `channel2` → Discord channel `987654321`

If no mapping is found for a channel, messages will be relayed to all Discord channels.

## Filters

Set in `.env`:

- `FILTER_BLOCK_COMMANDS=true` blocks `!commands`
- `FILTER_BLOCKED_WORDS=badword1,badword2` word list for content filter
- `FILTER_ONLY_BLOCKED_WORDS=true` only messages containing a listed word pass
- `SUSPICIOUS_FLAG_ENABLED=true` append a warning when a message matches blacklist words
- `REACTION_DELETE_EMOJI=` restrict reaction-based deletes to a specific emoji

## Twitch Chat Automation

The bot automatically responds to Twitch events:

### Subscription Thank You Messages

When someone subscribes, resubs, or gifts a sub, the bot can automatically send a thank you message in Twitch chat (enabled by default):

- New Sub: "hype Welcome to Kandyland, [Username]! kandyKiss"
- Resub: "hype Welcome back to Kandyland, [Username]! kandyKiss"
- Gift Sub (single): "Thank you for gifting to [recipient], [Gifter]! kandyHype"
- Gift Sub (multiple): "Thank you for gifting to [count] users, [Gifter]! kandyHype"

Configure in `.env`:

```env
SUB_THANK_YOU_ENABLED=true
RESUB_THANK_YOU_ENABLED=true
GIFT_SUB_THANK_YOU_ENABLED=true
```

Set any to `false` to disable that specific thank you message type.

## Reaction deletes (Discord -> Twitch)

When an admin/mod reacts to a relayed Discord message, the bot can delete the
original Twitch message. Requirements:

- Bot account must be a moderator in the Twitch channel.

Optional reaction actions:

- `REACTION_TIMEOUT_EMOJI=` emoji name or ID to timeout the sender
- `REACTION_BAN_EMOJI=` emoji name or ID to ban the sender
- `REACTION_TIMEOUT_SECONDS=60` timeout duration in seconds

## Ban sync (main channel -> other channels)

When the bot moderates more than one channel, it can mirror bans one way: a user banned in the
main channel (for example `kandyland`) is banned in the other channels too (for example
`kandylandvods`), but a ban in those channels is never copied back.

- Configure it in the dashboard under Settings -> Ban Sync (admin): enable, pick the source
  channel, tick the target channels, and edit the ban reason template. Settings live in
  `data/config.json`, no restart needed.
- Every ban in the source channel counts, whoever issued it: a moderator in Twitch chat, a Discord
  reaction or button, the dashboard, or an auto-ban rule. The bot listens for the IRC ban notice.
- The mirrored ban carries a reason built from the template, default
  `Banned in {source} by {moderator}`. Tags: `{source}`, `{target}`, `{moderator}`, `{user}`,
  `{reason}`. For bans clicked in Discord or the dashboard, `{moderator}` is that user; for bans
  done directly in Twitch chat the bot looks the moderator up with the Helix "Get Banned Users"
  endpoint, which needs the `moderation:read` scope on the bot token (without it the reason falls
  back to "a moderator").
- "Mirror Unbans" lifts the mirrored bans again when the user is unbanned in the source channel.
  Unbans the bot performs itself (the Unban button on auto-ban cards) are mirrored at once. Twitch
  IRC has no unban notice, so for unbans done in Twitch chat the bot remembers every ban it
  mirrored (`data/ban-sync-state.json`) and checks those users against the Helix "Get Banned
  Users" endpoint at the interval set in the dashboard ("Unban check interval", in hours,
  default 1, 0 pauses it; the first check runs a minute after startup; needs `moderation:read`);
  a user who is no longer banned in the source is unbanned in the targets. Bans that already
  existed in a target before the sync are left alone.
- "Announce in Discord" posts a `[SYSTEM]` line in the relay channel of the source channel each
  time a ban is mirrored. Mirrored actions also appear in the dashboard Mod Log with source "Bot".

## Slash commands

Slash commands are registered per guild using a deploy script.

- `/klb addblacklist [word]` adds a word to `data/blacklist.json`.
- `/klb removeblacklist [word]` removes a word from `data/blacklist.json`.
- `/klb listblacklist` lists current blacklist words.
- `/klb restart` restarts the bot (admin only; requires a process manager).

Blacklist entries can be plain text or regex in the form `/pattern/flags`.
Example: `/spam\\d+/i`

Deploy:

```bash
npm run deploy-commands
```

`DISCORD_GUILD_ID` can be a comma-separated list of guild ids.

To hide `/klb`, the command is deployed with no default permissions.
Assign access in Discord: Server Settings -> Integrations -> Bots -> Kandy Chat -> Manage -> Commands.

## EventSub (optional)

EventSub is used for stream online/offline notifications (in addition to IRC chat).

Setup:

1. Set EventSub env vars in `.env`:

- `EVENTSUB_ENABLED=true`
- `EVENTSUB_SECRET=...` (random secret)
- `EVENTSUB_PUBLIC_URL=...` (public HTTPS URL to your machine)
- `EVENTSUB_CALLBACK_PATH=/eventsub`
- `EVENTSUB_PORT=8080`
- `EVENTSUB_BROADCASTER=your_channel_name`
- `STREAM_ALERT_ROLE_ID=...` (optional: role to ping when stream goes offline)

2. Expose your local port (example with ngrok):

```bash
ngrok http 8080
```

3. Deploy subscriptions:

```bash
npm run deploy-eventsub
```

The bot also manages its subscriptions itself: at startup and every `EVENTSUB_RECONCILE_MINUTES`
(default 60) it lists the subscriptions registered for the client id, removes revoked or broken
ones, and creates any that are missing. Twitch revokes a subscription after repeated delivery
failures (for example during a network outage) and sends the revocation notice to the same
unreachable callback, so without this check the bot would silently stop receiving events.

Useful commands:

```bash
npm run deploy-eventsub -- --list      # show every subscription and its status
npm run deploy-eventsub -- --dry-run   # report what would be created/removed
```

As a further safety net the bot polls the Helix streams endpoint every
`STREAM_STATUS_POLL_SECONDS` (default 60). A stream state that differs from what EventSub last
reported, on two consecutive polls, is fed through the same online/offline handler, so the
dashboard, offline alerts and `data/stream-status.json` (read by youtube-relay) recover even if
an event was missed.

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
- `FREEZE_FFMPEG_TIMEOUT_SECONDS=8` (ffmpeg capture timeout)
- `FREEZE_SAMPLE_SECONDS=5` (how often to sample)
- `FREEZE_THRESHOLD_SECONDS=20` (unchanged duration to declare frozen)
- `FILTER_ALLOWED_USERS` allowlist (comma-separated)
- `FILTER_BLOCKED_USERS` blocklist (comma-separated)
- `FILTER_BLOCK_EMOTES=true` blocks emote-only messages
