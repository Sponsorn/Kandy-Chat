/**
 * Helix stream status poller.
 *
 * EventSub is the fast path for stream online/offline, but a webhook can be
 * missed (network outage) or the subscription can be revoked by Twitch after
 * repeated delivery failures. When that happens nothing else tells the bot,
 * the dashboard, or the youtube-relay (via data/stream-status.json) that the
 * stream state changed. This poller periodically asks Helix directly and
 * reports any channel whose live state differs from what the bot believes.
 *
 * Helix can lag a stream.online event by a minute or two, so a difference is
 * only reported after it has been observed on `confirmations` consecutive
 * polls. This prevents the poller from flapping state right after EventSub
 * delivered a fresh event.
 */

/**
 * @param {Object} options
 * @param {{ getStreamStatus: (logins: string[]) => Promise<Map<string, { live: boolean }>> }} options.twitchAPIClient
 * @param {string[]} options.channels - Twitch logins to poll
 * @param {(channel: string) => boolean|null} options.getKnownLive - current belief per channel (null if unknown)
 * @param {(channel: string, live: boolean) => void|Promise<void>} options.onChange - called when a confirmed difference is found
 * @param {number} [options.intervalMs=60000]
 * @param {number} [options.confirmations=2] - consecutive polls that must disagree before onChange fires
 * @param {{ log: Function, error: Function }} [options.logger]
 */
export function createStreamStatusPoller({
  twitchAPIClient,
  channels,
  getKnownLive,
  onChange,
  intervalMs = 60000,
  confirmations = 2,
  logger = console
}) {
  const normalizedChannels = (channels || [])
    .map((c) => String(c).replace(/^#/, "").trim().toLowerCase())
    .filter(Boolean);

  // channel -> number of consecutive polls that disagreed with the known state
  const disagreeCount = new Map();
  let timer = null;
  let polling = false;

  async function pollOnce() {
    if (polling || normalizedChannels.length === 0) return;
    polling = true;
    try {
      const statuses = await twitchAPIClient.getStreamStatus(normalizedChannels);

      for (const channel of normalizedChannels) {
        const polled = statuses.get(channel);
        if (!polled) continue;

        const known = getKnownLive(channel);
        // Unknown state: adopt what Helix says immediately (matches startup behaviour)
        if (known === null || known === undefined) {
          disagreeCount.delete(channel);
          await onChange(channel, polled.live);
          continue;
        }

        if (polled.live === known) {
          disagreeCount.delete(channel);
          continue;
        }

        const count = (disagreeCount.get(channel) || 0) + 1;
        if (count < confirmations) {
          disagreeCount.set(channel, count);
          continue;
        }

        disagreeCount.delete(channel);
        logger?.log(
          `Stream status poll: ${channel} is ${polled.live ? "online" : "offline"} on Helix but bot thought ${known ? "online" : "offline"} (EventSub missed?)`
        );
        await onChange(channel, polled.live);
      }
    } catch (error) {
      logger?.error(`Stream status poll failed: ${error?.message || error}`);
    } finally {
      polling = false;
    }
  }

  function start() {
    if (timer || normalizedChannels.length === 0 || intervalMs <= 0) return;
    timer = setInterval(() => {
      pollOnce();
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
    logger?.log(
      `Stream status poller started (every ${Math.round(intervalMs / 1000)}s for ${normalizedChannels.join(", ")})`
    );
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, pollOnce, channels: normalizedChannels };
}
