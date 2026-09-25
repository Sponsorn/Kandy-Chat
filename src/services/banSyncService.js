import botState from "../state/BotState.js";
import { saveTrackedBans } from "../banSyncStore.js";

/**
 * Ban sync: mirror bans from one "source" Twitch channel to one or more "target" channels.
 *
 * The trigger is the IRC CLEARCHAT notice tmi.js turns into a "ban" event, so every ban in the
 * source channel is mirrored no matter who issued it (a moderator in Twitch chat, a Discord
 * reaction or button, the dashboard, or an auto-ban rule). Bans in a target channel are never
 * mirrored anywhere, so the sync is strictly one-way.
 *
 * Twitch IRC has no unban notice, so unbans come from the EventSub "channel.moderate"
 * subscription (created for the source channel as the bot's moderator account, see
 * eventSubManager.js) and, when the bot itself unbans someone (the Unban button on auto-ban
 * cards), straight from that code path. The same subscription reports who issued a ban and why,
 * which fills {moderator} and {reason} for bans done in Twitch chat.
 *
 * Every mirrored ban is remembered in data/ban-sync-state.json, and an unban only lifts the
 * target bans the sync placed itself: a target that was already banned independently stays
 * banned.
 */

export const DEFAULT_BAN_REASON_TEMPLATE = "Banned in {source} by {moderator}";

export const DEFAULT_BAN_SYNC_CONFIG = Object.freeze({
  enabled: false,
  sourceChannel: null,
  targetChannels: [],
  mirrorUnbans: true,
  announceInDiscord: true,
  reasonTemplate: DEFAULT_BAN_REASON_TEMPLATE
});

export const REASON_TEMPLATE_TAGS = ["source", "target", "moderator", "user", "reason"];

const BAN_SYNC_ACTOR = "BanSync";
const UNKNOWN_MODERATOR = "a moderator";
const MAX_REASON_LENGTH = 500; // Helix limit for ban reasons
const ATTRIBUTION_TTL_MS = 60 * 1000;
// How long a ban seen on IRC waits for the matching EventSub notice to say who issued it. The
// two arrive within a second or so of each other, in either order.
const DEFAULT_ATTRIBUTION_WAIT_MS = 3000;
const ATTRIBUTION_WAIT_STEP_MS = 100;
let attributionWaitMs = DEFAULT_ATTRIBUTION_WAIT_MS;

/** Tests only: shorten or disable the wait for an EventSub attribution. */
export function setAttributionWaitMs(ms) {
  attributionWaitMs = Math.max(0, Number(ms) || 0);
}

// Who issued a ban, keyed by "channel:login": noted right before the bot issues a ban (so the
// mirrored ban names the Discord/dashboard moderator instead of the bot account) and when an
// EventSub channel.moderate ban notice arrives for a ban done elsewhere.
const pendingAttributions = new Map();

/**
 * Remember who banned `username` in `channel`. Call right before the bot issues a ban so the
 * ban sync can credit that moderator when the IRC ban notice arrives.
 * @param {string} channel
 * @param {string} username
 * @param {string} moderator - Display name of the moderator (Discord/dashboard user or "AutoBan")
 * @param {string} [reason] - Ban reason, when known
 */
export function noteBanAttribution(channel, username, moderator, reason = "") {
  const key = `${normalizeChannel(channel)}:${(username ?? "").toString().toLowerCase()}`;
  if (!moderator || key.endsWith(":")) return;
  pendingAttributions.set(key, { moderator, reason: reason || "", timestamp: Date.now() });

  // Opportunistic cleanup so the map never grows unbounded
  const cutoff = Date.now() - ATTRIBUTION_TTL_MS;
  for (const [k, v] of pendingAttributions) {
    if (v.timestamp < cutoff) pendingAttributions.delete(k);
  }
}

/**
 * Take (and forget) a remembered attribution for a ban.
 * @returns {{moderator: string, reason: string}|null} null when nothing recent is remembered
 */
export function takeBanAttribution(channel, username) {
  const key = `${normalizeChannel(channel)}:${(username ?? "").toString().toLowerCase()}`;
  const entry = pendingAttributions.get(key);
  if (!entry) return null;
  pendingAttributions.delete(key);
  if (Date.now() - entry.timestamp > ATTRIBUTION_TTL_MS) return null;
  return { moderator: entry.moderator, reason: entry.reason || "" };
}

// Bans this sync mirrored, keyed by login: { userId, source, targets, mirroredAt }.
// An unban in the source only lifts these targets.
const trackedBans = new Map();
const MAX_TRACKED_BANS = 5000;
let persistQueue = Promise.resolve();

function persistTrackedBans() {
  const snapshot = [...trackedBans.entries()].map(([login, entry]) => ({ login, ...entry }));
  persistQueue = persistQueue
    .then(() => saveTrackedBans(snapshot))
    .catch((error) => console.warn("[BanSync] Failed to save ban sync state:", error.message));
  return persistQueue;
}

/**
 * Load previously mirrored bans (from data/ban-sync-state.json) into memory.
 * `userId` is kept for files written by older versions; nothing needs it any more.
 * @param {Array<{login: string, userId?: string|null, source: string, targets: string[], mirroredAt?: number}>} entries
 */
export function hydrateTrackedBans(entries) {
  trackedBans.clear();
  for (const entry of entries || []) {
    const login = (entry?.login ?? "").toString().toLowerCase();
    const targets = Array.isArray(entry?.targets) ? entry.targets.map(normalizeChannel) : [];
    if (!login || !targets.length) continue;
    trackedBans.set(login, {
      userId: entry.userId || null,
      source: normalizeChannel(entry.source),
      targets: [...new Set(targets.filter(Boolean))],
      mirroredAt: Number(entry.mirroredAt) || Date.now()
    });
  }
}

/**
 * @returns {Array<{login: string, userId: string|null, source: string, targets: string[], mirroredAt: number}>}
 */
export function getTrackedBans() {
  return [...trackedBans.entries()].map(([login, entry]) => ({ login, ...entry }));
}

export function getTrackedBanCount() {
  return trackedBans.size;
}

function trackMirroredBan(login, userId, source, targets) {
  const existing = trackedBans.get(login);
  const merged = new Set([...(existing?.targets || []), ...targets]);
  trackedBans.set(login, {
    userId: userId || existing?.userId || null,
    source,
    targets: [...merged],
    mirroredAt: existing?.mirroredAt || Date.now()
  });

  // Bound the state file: drop the oldest entries once the cap is exceeded
  if (trackedBans.size > MAX_TRACKED_BANS) {
    const oldest = [...trackedBans.entries()]
      .sort((a, b) => a[1].mirroredAt - b[1].mirroredAt)
      .slice(0, trackedBans.size - MAX_TRACKED_BANS);
    for (const [key] of oldest) trackedBans.delete(key);
  }
  return persistTrackedBans();
}

function untrackMirroredBan(login, targets) {
  const existing = trackedBans.get(login);
  if (!existing) return Promise.resolve();
  const remaining = existing.targets.filter((t) => !targets.includes(t));
  if (remaining.length) {
    trackedBans.set(login, { ...existing, targets: remaining });
  } else {
    trackedBans.delete(login);
  }
  return persistTrackedBans();
}

/**
 * Fill a reason template. Unknown tags are left untouched; the result is trimmed to the Helix
 * ban reason limit.
 * @param {string} template
 * @param {Object} vars - { source, target, moderator, user, reason }
 * @returns {string}
 */
export function renderBanReason(template, vars) {
  const tpl =
    typeof template === "string" && template.trim() ? template : DEFAULT_BAN_REASON_TEMPLATE;
  let out = tpl;
  for (const tag of REASON_TEMPLATE_TAGS) {
    out = out.replace(new RegExp(`\\{${tag}\\}`, "g"), vars?.[tag] ?? "");
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > MAX_REASON_LENGTH ? out.slice(0, MAX_REASON_LENGTH) : out;
}

/**
 * Normalize a Twitch channel name: lowercase, no leading #, trimmed.
 * @param {string} channel
 * @returns {string}
 */
export function normalizeChannel(channel) {
  return (channel ?? "").toString().trim().toLowerCase().replace(/^#/, "");
}

/**
 * Pure decision: which channels should a ban in `channel` be mirrored to?
 * @param {Object} config - Ban sync config (see DEFAULT_BAN_SYNC_CONFIG)
 * @param {string} channel - Channel the ban happened in
 * @returns {string[]} Normalized target channel names (empty when nothing to do)
 */
export function planBanMirror(config, channel) {
  if (!config?.enabled) return [];

  const source = normalizeChannel(config.sourceChannel);
  if (!source || normalizeChannel(channel) !== source) return [];

  const targets = Array.isArray(config.targetChannels) ? config.targetChannels : [];
  const seen = new Set();
  const result = [];
  for (const raw of targets) {
    const target = normalizeChannel(raw);
    if (!target || target === source || seen.has(target)) continue;
    seen.add(target);
    result.push(target);
  }
  return result;
}

/**
 * Validate and normalize a ban sync config coming from the dashboard.
 * @param {Object} input - Untrusted config object
 * @param {string[]} knownChannels - Channels the bot has joined
 * @returns {{ config: Object|null, errors: string[] }}
 */
export function validateBanSyncConfig(input, knownChannels) {
  const errors = [];
  const known = new Set((knownChannels || []).map(normalizeChannel).filter(Boolean));

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { config: null, errors: ["Config must be an object"] };
  }

  const enabled = input.enabled === undefined ? DEFAULT_BAN_SYNC_CONFIG.enabled : input.enabled;
  if (typeof enabled !== "boolean") errors.push("enabled must be a boolean");

  const mirrorUnbans =
    input.mirrorUnbans === undefined ? DEFAULT_BAN_SYNC_CONFIG.mirrorUnbans : input.mirrorUnbans;
  if (typeof mirrorUnbans !== "boolean") errors.push("mirrorUnbans must be a boolean");

  const announceInDiscord =
    input.announceInDiscord === undefined
      ? DEFAULT_BAN_SYNC_CONFIG.announceInDiscord
      : input.announceInDiscord;
  if (typeof announceInDiscord !== "boolean") errors.push("announceInDiscord must be a boolean");

  let reasonTemplate = DEFAULT_BAN_REASON_TEMPLATE;
  if (input.reasonTemplate !== undefined && input.reasonTemplate !== null) {
    if (typeof input.reasonTemplate !== "string") {
      errors.push("reasonTemplate must be a string");
    } else if (input.reasonTemplate.length > MAX_REASON_LENGTH) {
      errors.push(`reasonTemplate must be at most ${MAX_REASON_LENGTH} characters`);
    } else {
      reasonTemplate = input.reasonTemplate.trim() || DEFAULT_BAN_REASON_TEMPLATE;
    }
  }

  let sourceChannel = null;
  if (input.sourceChannel !== null && input.sourceChannel !== undefined) {
    if (typeof input.sourceChannel !== "string") {
      errors.push("sourceChannel must be a string");
    } else {
      sourceChannel = normalizeChannel(input.sourceChannel) || null;
      if (sourceChannel && !known.has(sourceChannel)) {
        errors.push(`sourceChannel "${sourceChannel}" is not a channel the bot has joined`);
      }
    }
  }

  let targetChannels = [];
  if (input.targetChannels !== undefined) {
    if (!Array.isArray(input.targetChannels)) {
      errors.push("targetChannels must be an array");
    } else {
      const seen = new Set();
      for (const raw of input.targetChannels) {
        if (typeof raw !== "string") {
          errors.push("targetChannels entries must be strings");
          continue;
        }
        const target = normalizeChannel(raw);
        if (!target || seen.has(target)) continue;
        seen.add(target);
        if (!known.has(target)) {
          errors.push(`targetChannel "${target}" is not a channel the bot has joined`);
          continue;
        }
        if (target === sourceChannel) {
          errors.push(`targetChannel "${target}" cannot be the same as sourceChannel`);
          continue;
        }
        targetChannels.push(target);
      }
    }
  }

  if (enabled === true) {
    if (!sourceChannel) errors.push("sourceChannel is required when ban sync is enabled");
    if (targetChannels.length === 0) {
      errors.push("At least one targetChannel is required when ban sync is enabled");
    }
  }

  if (errors.length) return { config: null, errors };

  return {
    config: {
      enabled,
      sourceChannel,
      targetChannels,
      mirrorUnbans,
      announceInDiscord,
      reasonTemplate
    },
    errors: []
  };
}

function isAlreadyBannedError(error) {
  return /already banned/i.test(error?.message || "");
}

function isNotBannedError(error) {
  return /is not banned|not banned/i.test(error?.message || "");
}

/**
 * Discord channels to post ban sync notices in: the ones mapped to the source Twitch channel,
 * or every relay channel when no mapping is configured.
 */
function discordChannelsFor(sourceChannel) {
  const channels = botState.discordChannels || [];
  if (botState.channelMapping.size > 0) {
    const mappedId = botState.channelMapping.get(sourceChannel);
    if (mappedId) return channels.filter((ch) => ch?.id === mappedId);
  }
  return channels;
}

async function announce(sourceChannel, text) {
  const targets = discordChannelsFor(sourceChannel).filter((ch) => ch?.isTextBased?.());
  for (const channel of targets) {
    try {
      await channel.send(`[SYSTEM] ${text}`);
    } catch (error) {
      console.warn(
        `[BanSync] Failed to post notice to Discord channel ${channel.id}:`,
        error.message
      );
    }
  }
}

/**
 * Work out who banned `login` in `source` and why. Bot-issued bans are credited to the
 * Discord/dashboard moderator that triggered them; bans done elsewhere are credited from the
 * EventSub channel.moderate notice, which can arrive just after the IRC ban notice, so wait
 * briefly for it before falling back to "a moderator".
 */
async function resolveBanAttribution(source, login) {
  const deadline = Date.now() + attributionWaitMs;
  for (;;) {
    const remembered = takeBanAttribution(source, login);
    if (remembered) return remembered;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, ATTRIBUTION_WAIT_STEP_MS));
  }
  return { moderator: UNKNOWN_MODERATOR, reason: "" };
}

/**
 * Mirror a ban that happened in `channel` to the configured target channels.
 * Safe to call for every ban event: returns immediately when nothing is configured.
 *
 * @param {string} channel - Channel the ban happened in (with or without #)
 * @param {string} username - Twitch login of the banned user
 * @param {Object} twitchAPIClient - TwitchAPIClient instance
 * @returns {Promise<{ mirrored: string[], skipped: string[], failed: string[], moderator?: string }>}
 */
export async function mirrorBan(channel, username, twitchAPIClient) {
  const result = { mirrored: [], skipped: [], failed: [] };
  const config = botState.getBanSyncConfig();
  const targets = planBanMirror(config, channel);
  if (!targets.length || !username || !twitchAPIClient) return result;

  const source = normalizeChannel(channel);
  const login = username.toLowerCase();
  const attribution = await resolveBanAttribution(source, login);
  result.moderator = attribution.moderator;

  for (const target of targets) {
    const reason = renderBanReason(config.reasonTemplate, {
      source,
      target,
      moderator: attribution.moderator,
      user: login,
      reason: attribution.reason
    });
    try {
      await twitchAPIClient.banUser(`#${target}`, login, reason);
      result.mirrored.push(target);
      console.log(
        `[BanSync] Banned ${login} in #${target} (banned in #${source} by ${attribution.moderator})`
      );
      botState.recordModerationAction(
        "ban",
        BAN_SYNC_ACTOR,
        login,
        { channel: `#${target}`, sourceChannel: `#${source}`, reason },
        "auto",
        "success"
      );
    } catch (error) {
      if (isAlreadyBannedError(error)) {
        result.skipped.push(target);
        console.log(`[BanSync] ${login} is already banned in #${target}, nothing to do`);
        continue;
      }
      result.failed.push(target);
      console.error(`[BanSync] Failed to ban ${login} in #${target}:`, error.message);
      botState.recordModerationAction(
        "ban",
        BAN_SYNC_ACTOR,
        login,
        { channel: `#${target}`, sourceChannel: `#${source}`, reason },
        "auto",
        "failed",
        error.message
      );
    }
  }

  // Remember what we banned so an unban in the source can be detected and mirrored later.
  // Targets that were already banned independently are not tracked: that ban was not ours.
  if (result.mirrored.length) {
    await trackMirroredBan(login, null, source, result.mirrored);
  }

  if (config.announceInDiscord && (result.mirrored.length || result.failed.length)) {
    const parts = [];
    if (result.mirrored.length) {
      parts.push(`also banned in ${result.mirrored.map((t) => `#${t}`).join(", ")}`);
    }
    if (result.failed.length) {
      parts.push(`failed to ban in ${result.failed.map((t) => `#${t}`).join(", ")}`);
    }
    await announce(
      source,
      `Ban sync: **${login}** was banned in #${source} by ${attribution.moderator}, ${parts.join("; ")}`
    );
  }

  return result;
}

/**
 * Mirror an unban in `channel` to the target channels the sync banned the user in.
 * Only runs when `mirrorUnbans` is enabled. Targets where the user was banned independently of
 * the sync are never tracked, so their bans stay.
 *
 * @param {string} channel - Channel the unban happened in (with or without #)
 * @param {string} username - Twitch login of the unbanned user
 * @param {Object} twitchAPIClient - TwitchAPIClient instance
 * @param {Object} [options]
 * @param {string} [options.moderator] - Who lifted the source ban, when known
 * @returns {Promise<{ mirrored: string[], skipped: string[], failed: string[] }>}
 */
export async function mirrorUnban(channel, username, twitchAPIClient, options = {}) {
  const result = { mirrored: [], skipped: [], failed: [] };
  const config = botState.getBanSyncConfig();
  if (!config.mirrorUnbans) return result;
  const configured = planBanMirror(config, channel);
  if (!configured.length || !username || !twitchAPIClient) return result;

  const source = normalizeChannel(channel);
  const login = username.toLowerCase();
  const tracked = trackedBans.get(login);
  const targets =
    tracked && tracked.source === source
      ? configured.filter((t) => tracked.targets.includes(t))
      : [];
  if (!targets.length) {
    console.log(`[BanSync] ${login} was unbanned in #${source}, no mirrored bans to lift`);
    return result;
  }

  for (const target of targets) {
    try {
      await twitchAPIClient.unbanUser(`#${target}`, login);
      result.mirrored.push(target);
      console.log(`[BanSync] Unbanned ${login} in #${target} (unbanned in #${source})`);
      botState.recordModerationAction(
        "unban",
        BAN_SYNC_ACTOR,
        login,
        { channel: `#${target}`, sourceChannel: `#${source}` },
        "auto",
        "success"
      );
    } catch (error) {
      if (isNotBannedError(error)) {
        result.skipped.push(target);
        console.log(`[BanSync] ${login} is not banned in #${target}, nothing to do`);
        continue;
      }
      result.failed.push(target);
      console.error(`[BanSync] Failed to unban ${login} in #${target}:`, error.message);
      botState.recordModerationAction(
        "unban",
        BAN_SYNC_ACTOR,
        login,
        { channel: `#${target}`, sourceChannel: `#${source}` },
        "auto",
        "failed",
        error.message
      );
    }
  }

  // Stop tracking targets that are unbanned (or were not banned any more); keep failed ones so
  // a later unban in the source (or the bot's Unban button) can retry them.
  await untrackMirroredBan(login, [...result.mirrored, ...result.skipped]);

  if (config.announceInDiscord && (result.mirrored.length || result.failed.length)) {
    const parts = [];
    if (result.mirrored.length) {
      parts.push(`also unbanned in ${result.mirrored.map((t) => `#${t}`).join(", ")}`);
    }
    if (result.failed.length) {
      parts.push(`failed to unban in ${result.failed.map((t) => `#${t}`).join(", ")}`);
    }
    const by = options.moderator ? ` by ${options.moderator}` : "";
    await announce(
      source,
      `Ban sync: **${login}** was unbanned in #${source}${by}, ${parts.join("; ")}`
    );
  }

  return result;
}

/**
 * Handle an EventSub channel.moderate notification (the `event` object of the payload).
 * - "ban": remember who banned the user and why, for the mirrored ban's reason
 * - "unban": lift the bans the sync mirrored
 * Everything else is ignored. Actions the bot itself performed are skipped for attribution
 * (the Discord/dashboard moderator was already noted) but unbans are still mirrored; a second
 * mirror of the same unban finds nothing tracked and does nothing.
 *
 * @param {Object} event - channel.moderate event
 * @param {Object} twitchAPIClient - TwitchAPIClient instance
 * @param {Object} [options]
 * @param {string} [options.botLogin] - The bot's own Twitch login
 * @returns {Promise<{ action: string, handled: boolean }>}
 */
export async function handleModerationEvent(event, twitchAPIClient, options = {}) {
  const action = event?.action || "";
  const channel = normalizeChannel(event?.broadcaster_user_login);
  // Shared chat: an action taken in another channel of the session is not a source ban
  const origin = normalizeChannel(event?.source_broadcaster_user_login);
  if (!channel || (origin && origin !== channel)) return { action, handled: false };

  const moderatorLogin = (event?.moderator_user_login || "").toLowerCase();
  const moderator = event?.moderator_user_name || event?.moderator_user_login || "";
  const isBot = !!options.botLogin && moderatorLogin === options.botLogin.toLowerCase();

  if (action === "ban") {
    const login = event?.ban?.user_login;
    if (!login || isBot) return { action, handled: false };
    noteBanAttribution(channel, login, moderator, event?.ban?.reason || "");
    return { action, handled: true };
  }

  if (action === "unban") {
    const login = event?.unban?.user_login;
    if (!login) return { action, handled: false };
    await mirrorUnban(channel, login, twitchAPIClient, {
      moderator: isBot ? undefined : moderator
    });
    return { action, handled: true };
  }

  return { action, handled: false };
}
