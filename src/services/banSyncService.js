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
 * Twitch IRC has no unban notice, so unbans are handled two ways: immediately when the bot
 * itself unbans someone (the Unban button on auto-ban cards), and by polling. Every mirrored ban
 * is remembered in data/ban-sync-state.json; the poller asks Helix "Get Banned Users" for just
 * those users and, when one is no longer banned in the source channel, lifts the mirrored bans.
 */

export const DEFAULT_BAN_REASON_TEMPLATE = "Banned in {source} by {moderator}";

export const DEFAULT_UNBAN_POLL_HOURS = 1;
export const MAX_UNBAN_POLL_HOURS = 168; // one week

export const DEFAULT_BAN_SYNC_CONFIG = Object.freeze({
  enabled: false,
  sourceChannel: null,
  targetChannels: [],
  mirrorUnbans: true,
  announceInDiscord: true,
  reasonTemplate: DEFAULT_BAN_REASON_TEMPLATE,
  // How often (hours, fractions allowed) to ask Helix whether tracked users are still banned in
  // the source. 0 turns the check off; bot-performed unbans still mirror immediately.
  unbanPollHours: DEFAULT_UNBAN_POLL_HOURS
});

export const REASON_TEMPLATE_TAGS = ["source", "target", "moderator", "user", "reason"];

const BAN_SYNC_ACTOR = "BanSync";
const UNKNOWN_MODERATOR = "a moderator";
const MAX_REASON_LENGTH = 500; // Helix limit for ban reasons
const ATTRIBUTION_TTL_MS = 60 * 1000;

// Bans the bot issued itself, keyed by "channel:login", so the mirrored ban can name the
// Discord/dashboard moderator instead of the bot account Helix reports.
const pendingAttributions = new Map();

/**
 * Remember who asked the bot to ban `username` in `channel`. Call right before the bot issues a
 * ban so the ban sync can credit that moderator when the IRC ban notice arrives.
 * @param {string} channel
 * @param {string} username
 * @param {string} moderator - Display name of the moderator (Discord/dashboard user or "AutoBan")
 */
export function noteBanAttribution(channel, username, moderator) {
  const key = `${normalizeChannel(channel)}:${(username ?? "").toString().toLowerCase()}`;
  if (!moderator || key.endsWith(":")) return;
  pendingAttributions.set(key, { moderator, timestamp: Date.now() });

  // Opportunistic cleanup so the map never grows unbounded
  const cutoff = Date.now() - ATTRIBUTION_TTL_MS;
  for (const [k, v] of pendingAttributions) {
    if (v.timestamp < cutoff) pendingAttributions.delete(k);
  }
}

/**
 * Take (and forget) a remembered attribution for a ban.
 * @returns {string|null} Moderator name, or null if the bot did not issue this ban recently
 */
export function takeBanAttribution(channel, username) {
  const key = `${normalizeChannel(channel)}:${(username ?? "").toString().toLowerCase()}`;
  const entry = pendingAttributions.get(key);
  if (!entry) return null;
  pendingAttributions.delete(key);
  if (Date.now() - entry.timestamp > ATTRIBUTION_TTL_MS) return null;
  return entry.moderator;
}

// Bans this sync mirrored, keyed by login: { userId, source, targets, mirroredAt }.
// Only these users are polled for unbans, so the poll cost scales with mirrored bans, not with
// the channel's whole ban list.
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

  let unbanPollHours = DEFAULT_UNBAN_POLL_HOURS;
  if (input.unbanPollHours !== undefined && input.unbanPollHours !== null) {
    const n = Number(input.unbanPollHours);
    if (!Number.isFinite(n) || n < 0 || n > MAX_UNBAN_POLL_HOURS) {
      errors.push(`unbanPollHours must be a number between 0 and ${MAX_UNBAN_POLL_HOURS}`);
    } else {
      unbanPollHours = Math.round(n * 100) / 100;
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
      reasonTemplate,
      unbanPollHours
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
 * Discord/dashboard moderator that triggered them; everything else is looked up through Helix
 * (needs the moderation:read scope), and falls back to "a moderator".
 */
async function resolveBanAttribution(source, login, twitchAPIClient) {
  const remembered = takeBanAttribution(source, login);
  if (remembered) return { moderator: remembered, reason: "" };

  if (typeof twitchAPIClient.getBannedUser === "function") {
    try {
      const entry = await twitchAPIClient.getBannedUser(`#${source}`, login);
      if (entry) {
        return {
          moderator: entry.moderatorName || entry.moderatorLogin || UNKNOWN_MODERATOR,
          reason: entry.reason || ""
        };
      }
    } catch (error) {
      console.warn(`[BanSync] Could not look up who banned ${login} in #${source}:`, error.message);
    }
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
  const attribution = await resolveBanAttribution(source, login, twitchAPIClient);
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
    let userId = null;
    try {
      userId = await twitchAPIClient.getUserId(login);
    } catch {
      // The poller will resolve the id later
    }
    await trackMirroredBan(login, userId, source, result.mirrored);
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
 * Mirror an unban in `channel` to the configured target channels.
 * Only runs when `mirrorUnbans` is enabled.
 *
 * @param {string} channel - Channel the unban happened in (with or without #)
 * @param {string} username - Twitch login of the unbanned user
 * @param {Object} twitchAPIClient - TwitchAPIClient instance
 * @param {Object} [options]
 * @param {"bot"|"poll"} [options.detectedBy="bot"] - "bot" when the bot itself unbanned the user,
 *   "poll" when the Helix poller noticed the source ban is gone
 * @returns {Promise<{ mirrored: string[], skipped: string[], failed: string[] }>}
 */
export async function mirrorUnban(channel, username, twitchAPIClient, options = {}) {
  const result = { mirrored: [], skipped: [], failed: [] };
  const config = botState.getBanSyncConfig();
  if (!config.mirrorUnbans) return result;
  const targets = planBanMirror(config, channel);
  if (!targets.length || !username || !twitchAPIClient) return result;

  const source = normalizeChannel(channel);
  const login = username.toLowerCase();
  const detectedBy = options.detectedBy === "poll" ? "poll" : "bot";

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

  // Stop tracking targets that are unbanned (or were not banned any more); keep failed ones
  // so the poller retries them next round.
  await untrackMirroredBan(login, [...result.mirrored, ...result.skipped]);

  if (config.announceInDiscord && (result.mirrored.length || result.failed.length)) {
    const parts = [];
    if (result.mirrored.length) {
      parts.push(`also unbanned in ${result.mirrored.map((t) => `#${t}`).join(", ")}`);
    }
    if (result.failed.length) {
      parts.push(`failed to unban in ${result.failed.map((t) => `#${t}`).join(", ")}`);
    }
    const how = detectedBy === "poll" ? "is no longer banned" : "was unbanned";
    await announce(source, `Ban sync: **${login}** ${how} in #${source}, ${parts.join("; ")}`);
  }

  return result;
}

/**
 * One poll round: ask Helix which tracked users are still banned in the source channel and
 * mirror an unban for every one that no longer is. Users the sync banned in the targets but
 * whose source ban was lifted by a moderator in Twitch chat are caught here.
 *
 * @param {Object} twitchAPIClient - TwitchAPIClient instance
 * @returns {Promise<{ checked: number, unbanned: string[], failed: string[] }>}
 */
export async function checkTrackedUnbans(twitchAPIClient) {
  const summary = { checked: 0, unbanned: [], failed: [] };
  const config = botState.getBanSyncConfig();
  if (!config.enabled || !config.mirrorUnbans || !twitchAPIClient) return summary;

  const source = normalizeChannel(config.sourceChannel);
  if (!source) return summary;

  const candidates = [...trackedBans.entries()].filter(([, entry]) => entry.source === source);
  if (!candidates.length) return summary;

  // Resolve ids for entries that were tracked without one
  let changed = false;
  for (const [login, entry] of candidates) {
    if (entry.userId) continue;
    try {
      entry.userId = await twitchAPIClient.getUserId(login);
      changed = true;
    } catch (error) {
      console.warn(`[BanSync] Could not resolve user id for ${login}:`, error.message);
    }
  }
  if (changed) await persistTrackedBans();

  const withIds = candidates.filter(([, entry]) => entry.userId);
  if (!withIds.length) return summary;

  let stillBanned;
  try {
    stillBanned = await twitchAPIClient.getBannedUsersByIds(
      `#${source}`,
      withIds.map(([, entry]) => entry.userId)
    );
  } catch (error) {
    console.warn(`[BanSync] Unban check failed for #${source}:`, error.message);
    return summary;
  }
  summary.checked = withIds.length;

  for (const [login, entry] of withIds) {
    if (stillBanned.has(entry.userId)) continue;
    console.log(`[BanSync] ${login} is no longer banned in #${source}, lifting mirrored ban(s)`);
    const result = await mirrorUnban(`#${source}`, login, twitchAPIClient, { detectedBy: "poll" });
    if (result.mirrored.length || result.skipped.length) summary.unbanned.push(login);
    if (result.failed.length) summary.failed.push(login);
  }

  return summary;
}

/**
 * Periodically run checkTrackedUnbans(). The interval comes from the ban sync config
 * (`unbanPollHours`, editable in the dashboard) and is re-read after every run and whenever
 * the config changes, so no restart is needed. 0 pauses the check; the poller then just waits
 * for the setting to change.
 *
 * @param {Object} options
 * @param {Object} options.twitchAPIClient
 * @param {{ log: Function, error: Function }} [options.logger]
 */
export function createBanSyncPoller({ twitchAPIClient, logger = console }) {
  let timer = null;
  let polling = false;
  let running = false;
  let lastAnnouncedHours = null;

  function currentHours() {
    const hours = botState.getBanSyncConfig().unbanPollHours;
    return Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_UNBAN_POLL_HOURS;
  }

  async function pollOnce() {
    if (polling) return null;
    polling = true;
    try {
      return await checkTrackedUnbans(twitchAPIClient);
    } catch (error) {
      logger.error(`[BanSync] Unban poll failed: ${error?.message || error}`);
      return null;
    } finally {
      polling = false;
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!running) return;

    const hours = currentHours();
    if (hours !== lastAnnouncedHours) {
      logger.log(
        hours > 0
          ? `[BanSync] Unban check every ${hours}h`
          : "[BanSync] Unban check paused (interval set to 0)"
      );
      lastAnnouncedHours = hours;
    }
    if (hours <= 0) return; // paused until the config changes

    timer = setTimeout(
      async () => {
        timer = null;
        await pollOnce();
        schedule();
      },
      Math.round(hours * 60 * 60 * 1000)
    );
    timer.unref?.();
  }

  function onConfigUpdate(data) {
    if (data?.section === "banSync" || data?.config?.banSync) schedule();
  }

  function start() {
    if (running) return;
    running = true;
    botState.on("runtimeConfig:updated", onConfigUpdate);
    schedule();
  }

  function stop() {
    running = false;
    botState.off("runtimeConfig:updated", onConfigUpdate);
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    start,
    stop,
    pollOnce,
    get running() {
      return running;
    },
    get intervalHours() {
      return currentHours();
    }
  };
}
