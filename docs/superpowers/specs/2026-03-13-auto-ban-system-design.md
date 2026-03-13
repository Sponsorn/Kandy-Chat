# Auto-Ban System Design

## Overview

Automated banning of Twitch chatters whose messages match configurable patterns. Designed primarily to catch spam bots (e.g., "buy followers at s t r e a m b o o .com") by combining pattern matching with first-time chatter detection. Managed via the web dashboard.

## Motivation

Spam bots in Twitch chat typically:
- Are first-time chatters (fresh accounts)
- Post messages containing obfuscated URLs (spaced-out domains like `streamboo .com`)
- The existing regex `/\w+\s+\.(?:com|net|org|gg|tv|co)\b/i` catches these reliably with zero false positives

Currently these are flagged as suspicious for manual moderation. This feature automates the ban for high-confidence patterns.

## Data Model

### Auto-Ban Rule

```json
{
  "id": "uuid",
  "pattern": "\\w+\\s+\\.(?:com|net|org|gg|tv|co)\\b",
  "isRegex": true,
  "flags": "i",
  "enabled": true,
  "firstMsgOnly": true,
  "createdAt": "2026-03-13T12:00:00Z"
}
```

- `pattern`: Plain text (case-insensitive substring match) or regex source
- `isRegex`: If true, pattern is compiled as `new RegExp(pattern, flags)`
- `flags`: Regex flags string (only used when `isRegex` is true, defaults to `"i"`)
- `enabled`: Per-rule toggle — disabled rules are stored but skipped during matching
- `firstMsgOnly`: If true, only matches users whose `tags["first-msg"]` is `"1"`
- `createdAt`: ISO timestamp for display ordering

### Storage

File: `data/auto-ban-rules.json`

```json
{
  "rules": [
    { "id": "...", "pattern": "...", "isRegex": true, "flags": "i", "enabled": true, "firstMsgOnly": true, "createdAt": "..." }
  ]
}
```

Follows the same pattern as `blacklistStore.js` — simple JSON file with load/save functions.

## Message Flow

```
Twitch message arrives
  ↓
Existing filters (shouldBlockMessage) — if blocked, stop
  ↓
Auto-ban check (checkAutoBan)
  ├─ No match → normal relay path (suspicious check, relay to Discord)
  └─ Match found:
       ├─ Ban user via Twitch Helix API
       ├─ Send "bot ban" V2 card to Discord (replaces normal relay)
       ├─ Record moderation action in audit log
       ├─ Record relay mapping (for unban button to work)
       └─ Stop (skip normal relay)
```

The auto-ban check runs **after** `shouldBlockMessage` (so already-blocked messages don't waste API calls) and **before** the normal relay path. If auto-ban triggers, the bot ban card IS the relay — the message still appears in Discord for mod review.

## Discord V2 Cards

### Bot Ban Card

```
┌──────────────────────────────────────────────────┐ red accent (0xED4245)
│ [2026-03-13 14:30:01] **spammer123**: buy fol... │ (formatted relay text)
│ -# 🤖 Auto-banned · First-time chatter           │ (or just "Auto-banned" if not first-msg)
│ -# Matched: \w+\s+\.(?:com|net|org|gg|tv|co)\b  │ (pattern that triggered)
│ ┌─────────┐                                       │
│ │ Unban   │  (ButtonStyle.Success / green)        │
│ └─────────┘                                       │
└──────────────────────────────────────────────────┘
```

- Custom ID: `mod-unban`
- Red accent border matches suspicious card styling
- Shows which pattern matched so mods understand why
- "First-time chatter" label shown when `tags["first-msg"] === "1"` (based on actual message metadata, not the rule's `firstMsgOnly` setting)

### After Unban

```
┌──────────────────────────────────────────────────┐ red accent
│ [2026-03-13 14:30:01] **spammer123**: buy fol... │
│ -# 🤖 Auto-banned · First-time chatter           │
│ -# Matched: \w+\s+\.(?:com|net|org|gg|tv|co)\b  │
│ ┌───────────┐                                     │
│ │ Unban     │  (disabled)                         │
│ └───────────┘                                     │
│ -# ✅ Unbanned by moderatorname                   │
└──────────────────────────────────────────────────┘
```

### Message Builder Functions

- `buildAutoBanV2Message(formattedText, matchedPattern, isFirstMsg)` — the bot ban card
- `buildUnbannedV2Message(formattedText, matchedPattern, isFirstMsg, unbannedBy)` — after unban

## Twitch API

### Modified Method: `banUser(channelName, username, reason?)`

Add optional `reason` parameter to existing `banUser()`. When called from auto-ban, passes the matched pattern as the reason (e.g., `"Auto-ban: matched \\w+\\s+\\.(?:com|net)\\b"`). Existing callers are unaffected (reason defaults to undefined, which omits it from the API payload).

### New Method: `unbanUser(channelName, username)`

Added to `TwitchAPIClient.js`. Uses `DELETE /helix/moderation/bans` endpoint:

```
DELETE https://api.twitch.tv/helix/moderation/bans
  ?broadcaster_id={broadcasterId}
  &moderator_id={moderatorId}
  &user_id={userId}
```

Returns `204 No Content` on success — do not parse response body. Same pattern as existing `banUser()` which only checks `response.ok`.

## Button Interaction Handler

The existing `handleButtonInteraction` in `discordHandlers.js` routes via `BUTTON_ACTION_MAP`. The `mod-unban` button needs a **separate handler function** (`handleUnbanInteraction`) because the existing action flow (delete/timeout/ban/warn) assumes a different card structure and action set. Route it before the `BUTTON_ACTION_MAP` lookup in `handleInteraction`:

```javascript
if (interaction.isButton() && interaction.customId === "mod-unban") {
  await handleUnbanInteraction(interaction, dependencies.twitchAPIClient);
  return;
}
```

`handleUnbanInteraction` flow:
1. Permission check: `hasPrivilegedRole(member)` (same as other mod actions)
2. Look up relay mapping by `interaction.message.id`
3. `interaction.deferUpdate()`
4. Call `twitchAPIClient.unbanUser(channelName, relay.twitchUsername)`
5. Extract `matchedPattern` and `isFirstMsg` from the card's text components
6. Update the card to unbanned version via `interaction.editReply(buildUnbannedV2Message(...))`
7. Record moderation action in audit log
8. Post action summary to channel

Since the relay mapping has a TTL (1 hour), the unban button will stop working after that. This is acceptable — if a mod needs to unban later, they can use Twitch directly. The button is for quick "oops, false positive" corrections.

## Auto-Ban Service

New file: `src/services/autoBanService.js`

### `checkAutoBan(message, tags)`

- Loads enabled rules from BotState (rules have pre-compiled `RegExp` objects cached — see Regex Caching below)
- For each enabled rule:
  - If `firstMsgOnly` and `tags["first-msg"]` is not `"1"`, skip
  - If `isRegex`, test pre-compiled regex against message (reset `lastIndex` first if global/sticky)
  - If plain text, case-insensitive substring match
- Returns `{ matched: true, rule }` or `{ matched: false }`

Called from `handleTwitchMessage` in `twitchHandlers.js`, inserted between the `shouldBlockMessage` check (line ~268) and the `relayToDiscord` call (line ~273):

```javascript
// After shouldBlockMessage check, before relayToDiscord
const autoBanResult = checkAutoBan(normalized, tags);
if (autoBanResult.matched) {
  executeAutoBan(username, normalized, channel, tags, discordChannelId, autoBanResult.rule);
  return;
}
```

### `executeAutoBan(username, message, channel, tags, discordChannelId, rule)`

- Calls `twitchAPIClient.banUser(channel, username, reason)` with reason: `"Auto-ban: matched [pattern]"`
- Sends bot ban V2 card to Discord
- Records relay mapping (so unban button works)
- Records moderation action in audit log
- Logs to console
- If ban succeeds but Discord post fails: log error prominently, ban remains (mod can unban from Twitch directly)

### Regex Caching

Rules pre-compile regex when loaded or updated. `BotState.setAutoBanRules(rules)` compiles each regex rule into a `RegExp` object stored alongside the rule data (similar to how `blockedRegexes` works). Invalid regex patterns are logged as warnings and the rule is skipped during matching.

## Auto-Ban Store

New file: `src/autoBanStore.js` (follows existing convention — `blacklistStore.js`, `configStore.js` are in `src/` root)

Functions:
- `loadAutoBanRules()` — reads `data/auto-ban-rules.json`, returns rules array
- `saveAutoBanRules(rules)` — writes rules array to file
- `addAutoBanRule({ pattern, isRegex, flags, enabled, firstMsgOnly })` — adds rule with generated UUID
- `updateAutoBanRule(id, updates)` — partial update (enabled, firstMsgOnly, pattern, etc.)
- `removeAutoBanRule(id)` — removes by ID

Rules are loaded into `botState.autoBanRules` at startup and kept in sync on changes.

## Dashboard UI

### ConfigPanel: New "Auto Ban" Section

Added after the "Message Filters" section. Admin-only editing.

```
┌─ Auto Ban Rules ─────────────────────── [Editable] ─┐
│                                                       │
│  Pattern                    First-msg  Enabled  ✕     │
│  ─────────────────────────  ─────────  ───────  ───   │
│  /\w+\s+\.(?:com|...)\b/i    ✓          ✓      [x]  │
│  /buy\s+followers/i           ✓          ○      [x]  │
│  free nitro                   ○          ✓      [x]  │
│                                                       │
│  [+ Add Rule]                                         │
│                                                       │
└───────────────────────────────────────────────────────┘
```

- Toggle switches for `firstMsgOnly` and `enabled` per row
- Delete button per row
- "Add Rule" opens inline form: pattern input, regex toggle, first-msg toggle
- Changes save immediately on toggle (no Save button needed — individual PUT per rule)

### API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/auto-ban-rules` | Moderator+ | List all rules |
| `POST` | `/api/auto-ban-rules` | Admin | Add a new rule |
| `PUT` | `/api/auto-ban-rules/:id` | Admin | Update a rule (enabled, firstMsgOnly, pattern) |
| `DELETE` | `/api/auto-ban-rules/:id` | Admin | Remove a rule |

All mutating endpoints:
- Update `botState.autoBanRules` in memory
- Persist to `data/auto-ban-rules.json`
- Record audit event
- Emit `autoBanRules:updated` for WebSocket broadcast

## BotState Changes

- New field: `autoBanRules` (array, loaded at startup)
- New methods: `setAutoBanRules(rules)`, `getAutoBanRules()`
- `getSnapshot()` includes `autoBanRules` (count or full list for dashboard)
- New event: `autoBanRules:updated`

## File Changes Summary

| File | Change |
|------|--------|
| `src/services/autoBanService.js` | **New** — `checkAutoBan()`, `executeAutoBan()` |
| `src/autoBanStore.js` | **New** — JSON CRUD for auto-ban rules |
| `src/api/TwitchAPIClient.js` | Add `unbanUser()` method |
| `src/services/messageBuilder.js` | Add `buildAutoBanV2Message()`, `buildUnbannedV2Message()` |
| `src/handlers/twitchHandlers.js` | Insert auto-ban check between filter and relay |
| `src/handlers/discordHandlers.js` | Handle `mod-unban` button, add to interaction routing |
| `src/server/routes/configRoutes.js` | Add CRUD endpoints for auto-ban rules |
| `src/state/BotState.js` | Add `autoBanRules` state, events, snapshot |
| `src/index.js` | Load auto-ban rules at startup |
| `public/js/components/ConfigPanel.js` | Add Auto Ban Rules section |
| `public/js/api.js` | Add auto-ban API methods |
| `data/auto-ban-rules.json` | **New** — rule storage (created on first write) |

## Testing

- `tests/autoBanService.test.js` — rule matching logic (regex, plain text, first-msg filtering, disabled rules, invalid regex handling)
- `tests/autoBanStore.test.js` — CRUD operations, file persistence
- `tests/messageBuilder.test.js` — new V2 card builders (autoBan and unbanned variants)

## Edge Cases

- **Ban API fails**: Log error, fall through to normal relay (message still gets relayed as regular/suspicious)
- **Ban succeeds, Discord post fails**: Log error prominently. Ban remains in effect — mod can unban from Twitch directly. No card in Discord.
- **Multiple rules match**: First match wins, ban executes once
- **Rule with invalid regex**: Catch compilation error at load time, log warning, skip rule during matching
- **Unban after relay TTL expires**: Button interaction replies with "This message is no longer tracked" (existing behavior)
- **Non-V2 mode**: Auto-ban still executes the ban, but posts a plain text notification instead of a V2 card (fallback)
- **YouTube relay**: Not affected — `data/auto-ban-rules.json` is only read by the main bot, not the youtube-relay service

## Non-Goals

- Rate limiting auto-bans (can be added later if needed)
- Global enable/disable toggle (per-rule toggles are sufficient; disable all rules to disable the system)
