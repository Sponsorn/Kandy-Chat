/**
 * EventSub subscription management.
 *
 * Twitch revokes a webhook subscription after repeated delivery failures
 * (status "notification_failures_exceeded") and the revocation message itself
 * is delivered to the same unreachable callback, so a bot can silently lose
 * its stream.online / stream.offline events. This module lists the
 * subscriptions registered for the app, removes broken ones, and creates
 * whatever is missing so the set always matches what the bot expects.
 *
 * Used by the bot at startup and on a timer, and by deploy-eventsub.js.
 */

import { fetchWithTimeout } from "../utils/fetch.js";

const HELIX = "https://api.twitch.tv/helix";
const REQUEST_TIMEOUT_MS = 15000;

/** Subscription types the bot relies on, keyed by how the broadcaster id is used. */
export const REQUIRED_SUBSCRIPTIONS = [
  { type: "stream.online", version: "1", conditionKey: "broadcaster_user_id" },
  { type: "stream.offline", version: "1", conditionKey: "broadcaster_user_id" },
  { type: "channel.raid", version: "1", conditionKey: "from_broadcaster_user_id" }
];

/**
 * Build the callback URL from the public URL and callback path.
 */
export function buildCallbackUrl(publicUrl, callbackPath) {
  const base = String(publicUrl || "")
    .trim()
    .replace(/\/$/, "");
  const path = callbackPath || "/eventsub";
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Get an app access token (client credentials grant).
 * EventSub webhook subscriptions must be created with an app token.
 */
export async function getAppAccessToken(clientId, clientSecret, fetchImpl = fetchWithTimeout) {
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials"
  });

  const response = await fetchImpl(
    "https://id.twitch.tv/oauth2/token",
    { method: "POST", body: params },
    REQUEST_TIMEOUT_MS
  );

  if (!response.ok) {
    throw new Error(`Failed to get app access token: ${response.status}`);
  }

  const data = await response.json();
  return data.access_token;
}

function helixHeaders(clientId, accessToken) {
  return {
    "Client-ID": clientId,
    Authorization: `Bearer ${accessToken}`
  };
}

/**
 * Resolve Twitch user IDs for a list of logins.
 * @returns {Promise<Map<string, string>>} login (lowercase) -> user id
 */
export async function resolveUserIds(clientId, accessToken, logins, fetchImpl = fetchWithTimeout) {
  const result = new Map();
  const normalized = [...new Set(logins.map((l) => l.trim().toLowerCase()).filter(Boolean))];
  if (normalized.length === 0) return result;

  const params = normalized.map((l) => `login=${encodeURIComponent(l)}`).join("&");
  const response = await fetchImpl(
    `${HELIX}/users?${params}`,
    { headers: helixHeaders(clientId, accessToken) },
    REQUEST_TIMEOUT_MS
  );
  if (!response.ok) {
    throw new Error(`Helix users lookup failed: ${response.status}`);
  }
  const data = await response.json();
  for (const user of data.data || []) {
    result.set(String(user.login).toLowerCase(), String(user.id));
  }
  return result;
}

/**
 * List every EventSub subscription registered for this client id (all pages).
 */
export async function listSubscriptions(clientId, accessToken, fetchImpl = fetchWithTimeout) {
  const subscriptions = [];
  let cursor = null;

  do {
    const url = cursor
      ? `${HELIX}/eventsub/subscriptions?after=${encodeURIComponent(cursor)}`
      : `${HELIX}/eventsub/subscriptions`;
    const response = await fetchImpl(
      url,
      { headers: helixHeaders(clientId, accessToken) },
      REQUEST_TIMEOUT_MS
    );
    if (!response.ok) {
      throw new Error(`Failed to list EventSub subscriptions: ${response.status}`);
    }
    const data = await response.json();
    subscriptions.push(...(data.data || []));
    cursor = data.pagination?.cursor || null;
  } while (cursor);

  return subscriptions;
}

export async function createSubscription(
  clientId,
  accessToken,
  { type, version, condition, callbackUrl, secret },
  fetchImpl = fetchWithTimeout
) {
  const response = await fetchImpl(
    `${HELIX}/eventsub/subscriptions`,
    {
      method: "POST",
      headers: { ...helixHeaders(clientId, accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({
        type,
        version: version || "1",
        condition,
        transport: { method: "webhook", callback: callbackUrl, secret }
      })
    },
    REQUEST_TIMEOUT_MS
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`EventSub create failed (${type}): ${response.status} ${text}`);
  }
  const data = await response.json().catch(() => ({}));
  return data.data?.[0] || null;
}

export async function deleteSubscription(clientId, accessToken, id, fetchImpl = fetchWithTimeout) {
  const response = await fetchImpl(
    `${HELIX}/eventsub/subscriptions?id=${encodeURIComponent(id)}`,
    { method: "DELETE", headers: helixHeaders(clientId, accessToken) },
    REQUEST_TIMEOUT_MS
  );
  // 404 means it is already gone, which is fine
  if (!response.ok && response.status !== 404) {
    throw new Error(`EventSub delete failed (${id}): ${response.status}`);
  }
}

/**
 * Compute the set of subscriptions the bot needs.
 * @param {Map<string, string>} userIds login -> id
 */
export function buildRequiredSubscriptions(userIds) {
  const required = [];
  for (const [login, userId] of userIds) {
    for (const spec of REQUIRED_SUBSCRIPTIONS) {
      required.push({
        login,
        type: spec.type,
        version: spec.version,
        condition: { [spec.conditionKey]: userId }
      });
    }
  }
  return required;
}

function conditionMatches(existing, wanted) {
  const keys = Object.keys(wanted);
  return keys.every((k) => String(existing?.[k] ?? "") === String(wanted[k]));
}

/**
 * Decide what to do with the existing subscriptions given what is required.
 * Pure function so it can be tested without network access.
 *
 * @returns {{ keep: object[], remove: object[], create: object[], extra: object[] }}
 */
export function planReconciliation(existing, required, callbackUrl) {
  const keep = [];
  const remove = [];
  const create = [];

  // Anything that is not enabled, or points at another callback, is useless to us
  const usable = [];
  for (const sub of existing) {
    const sameCallback =
      sub.transport?.method === "webhook" && sub.transport?.callback === callbackUrl;
    if (sub.status === "enabled" && sameCallback) {
      usable.push(sub);
    } else if (sameCallback || sub.status !== "enabled") {
      // Stale callback or revoked/failed: clean it up
      remove.push(sub);
    } else {
      // Enabled but for another callback (another deployment sharing the client id): leave it alone
      keep.push(sub);
    }
  }

  for (const want of required) {
    const matches = usable.filter(
      (sub) => sub.type === want.type && conditionMatches(sub.condition, want.condition)
    );
    if (matches.length === 0) {
      create.push(want);
      continue;
    }
    // Keep one, remove duplicates
    keep.push(matches[0]);
    for (const dup of matches.slice(1)) remove.push(dup);
  }

  // Enabled subscriptions on our callback that are not in the required set
  // (e.g. a broadcaster that was removed from EVENTSUB_BROADCASTER, or one
  // created by hand). They are harmless and the bot handles their events, so
  // keep them and let the caller report them rather than deleting.
  const extra = [];
  for (const sub of usable) {
    if (!keep.includes(sub) && !remove.includes(sub)) {
      keep.push(sub);
      extra.push(sub);
    }
  }

  return { keep, remove, create, extra };
}

/**
 * Make the registered EventSub subscriptions match what the bot needs.
 *
 * @param {Object} options
 * @param {string} options.clientId
 * @param {string} options.clientSecret
 * @param {string} options.callbackUrl
 * @param {string} options.secret - webhook secret
 * @param {string[]} options.broadcasters - Twitch logins
 * @param {{ log: Function, warn?: Function, error: Function }} [options.logger]
 * @param {boolean} [options.dryRun=false] - only report, do not change anything
 * @param {Function} [options.fetchImpl]
 * @returns {Promise<{ created: number, removed: number, kept: number, plan: object }>}
 */
export async function ensureSubscriptions({
  clientId,
  clientSecret,
  callbackUrl,
  secret,
  broadcasters,
  logger = console,
  dryRun = false,
  fetchImpl = fetchWithTimeout
}) {
  const accessToken = await getAppAccessToken(clientId, clientSecret, fetchImpl);

  const userIds = await resolveUserIds(clientId, accessToken, broadcasters, fetchImpl);
  for (const login of broadcasters) {
    if (!userIds.has(login.trim().toLowerCase())) {
      logger?.warn?.(`EventSub: unable to resolve broadcaster id for ${login}, skipping`);
    }
  }

  const required = buildRequiredSubscriptions(userIds);
  const existing = await listSubscriptions(clientId, accessToken, fetchImpl);
  const plan = planReconciliation(existing, required, callbackUrl);

  for (const sub of plan.extra) {
    logger?.log(
      `EventSub: keeping ${sub.type} for ${JSON.stringify(sub.condition)} (not in EVENTSUB_BROADCASTER)`
    );
  }

  let verificationFailed = false;
  for (const sub of plan.remove) {
    logger?.log(
      `EventSub: removing ${sub.type} (${sub.status}) for ${JSON.stringify(sub.condition)}`
    );
    if (sub.status === "webhook_callback_verification_failed") verificationFailed = true;
    if (!dryRun) await deleteSubscription(clientId, accessToken, sub.id, fetchImpl);
  }

  if (verificationFailed) {
    logger?.warn?.(
      `EventSub: Twitch could not verify ${callbackUrl}. Check that the URL is reachable from the internet and not behind a login page; a POST without a signature should return 403.`
    );
  }

  for (const want of plan.create) {
    logger?.log(`EventSub: creating ${want.type} for ${want.login}`);
    if (!dryRun) {
      await createSubscription(
        clientId,
        accessToken,
        {
          type: want.type,
          version: want.version,
          condition: want.condition,
          callbackUrl,
          secret
        },
        fetchImpl
      );
    }
  }

  const summary = {
    created: plan.create.length,
    removed: plan.remove.length,
    kept: plan.keep.length,
    plan
  };

  if (plan.create.length === 0 && plan.remove.length === 0) {
    logger?.log(`EventSub: all ${plan.keep.length} subscriptions healthy`);
  } else {
    logger?.log(
      `EventSub: ${dryRun ? "would have " : ""}created ${summary.created}, removed ${summary.removed}, kept ${summary.kept}`
    );
  }

  return summary;
}

/**
 * Read the EventSub configuration from env and report whether self-management is possible.
 */
export function readEventSubConfig(env) {
  const enabled = String(env.EVENTSUB_ENABLED || "").toLowerCase() === "true";
  const broadcasters = String(env.EVENTSUB_BROADCASTER || "")
    .split(",")
    .map((b) => b.trim().toLowerCase())
    .filter(Boolean);

  const config = {
    enabled,
    clientId: env.TWITCH_CLIENT_ID,
    clientSecret: env.TWITCH_CLIENT_SECRET,
    secret: env.EVENTSUB_SECRET,
    callbackUrl: buildCallbackUrl(env.EVENTSUB_PUBLIC_URL, env.EVENTSUB_CALLBACK_PATH),
    broadcasters,
    reconcileMinutes: Number.parseInt(env.EVENTSUB_RECONCILE_MINUTES, 10)
  };
  if (!Number.isFinite(config.reconcileMinutes)) config.reconcileMinutes = 60;

  const missing = [];
  if (!config.clientId) missing.push("TWITCH_CLIENT_ID");
  if (!config.clientSecret) missing.push("TWITCH_CLIENT_SECRET");
  if (!config.secret) missing.push("EVENTSUB_SECRET");
  if (!env.EVENTSUB_PUBLIC_URL) missing.push("EVENTSUB_PUBLIC_URL");
  if (broadcasters.length === 0) missing.push("EVENTSUB_BROADCASTER");

  return { ...config, missing, canManage: enabled && missing.length === 0 };
}
