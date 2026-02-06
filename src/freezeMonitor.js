import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBool, parseIntEnv } from "./envUtils.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a timeout-based promise that resolves after specified seconds
 * Used as fallback when EventSub is not available
 */
function createPollingWait(seconds, logger) {
  return () => {
    logger?.log(`Freeze monitor: polling mode - waiting ${seconds}s before retry`);
    return sleep(seconds * 1000);
  };
}

function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { windowsHide: true });
    let timedOut = false;
    let settled = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (timedOut) {
        reject(new Error("ffmpeg timed out"));
        return;
      }
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function checkFfmpeg() {
  try {
    await runFfmpeg(["-version"], 2000);
    return true;
  } catch {
    return false;
  }
}

async function captureFrame(hlsUrl, outputPath, timeoutMs) {
  await runFfmpeg(
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      hlsUrl,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      outputPath
    ],
    timeoutMs
  );
}

async function hashFile(path) {
  const buffer = await fs.readFile(path);
  return createHash("sha1").update(buffer).digest("hex");
}

const PLAYBACK_ACCESS_QUERY = {
  operationName: "PlaybackAccessToken",
  variables: {
    isLive: true,
    login: "",
    isVod: false,
    vodID: "",
    playerType: "embed"
  },
  extensions: {
    persistedQuery: {
      version: 1,
      sha256Hash: "0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712"
    }
  }
};

async function getPlaybackAccessToken(channel, clientId, authToken) {
  if (typeof fetch !== "function") {
    throw new Error("global fetch is not available (requires Node 18+)");
  }

  const normalizedChannel = channel.toLowerCase();
  const body = [
    {
      ...PLAYBACK_ACCESS_QUERY,
      variables: { ...PLAYBACK_ACCESS_QUERY.variables, login: normalizedChannel }
    }
  ];

  const headers = {
    "Client-ID": clientId,
    "Content-Type": "application/json"
  };

  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const response = await fetch("https://gql.twitch.tv/gql", {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch playback token: ${response.status}`);
  }

  const payload = await response.json();
  const tokenData = payload?.[0]?.data?.streamPlaybackAccessToken;
  if (!tokenData?.signature || !tokenData?.value) {
    throw new Error("Playback token response missing signature/value");
  }

  const params = new URLSearchParams({
    sig: tokenData.signature,
    token: tokenData.value,
    allow_source: "true",
    allow_audio_only: "true"
  });

  return `https://usher.ttvnw.net/api/channel/hls/${encodeURIComponent(
    normalizedChannel
  )}.m3u8?${params.toString()}`;
}

export async function startFreezeMonitor(
  env,
  { onFreeze, onRecover, onOffline, onOnline, waitForOnline, logger }
) {
  const enabled = parseBool(env.FREEZE_CHECK_ENABLED, false);
  if (!enabled) return;

  const channel = env.FREEZE_CHANNEL;
  const clientId = env.FREEZE_CLIENT_ID || "kimne78kx3ncx6brgo4mv6wki5h1ko";
  const getAuthToken = () => env.FREEZE_OAUTH_BEARER;
  let hlsUrl = env.FREEZE_HLS_URL;
  const tokenRefreshSeconds = parseIntEnv(env.FREEZE_TOKEN_REFRESH_SECONDS, 300);
  const debug = parseBool(env.FREEZE_DEBUG, false);
  const offlineFailThreshold = parseIntEnv(env.FREEZE_OFFLINE_FAILS, 3);
  const recoveryFrames = parseIntEnv(env.FREEZE_RECOVERY_FRAMES, 3);
  const offlineBackoffSeconds = parseIntEnv(env.FREEZE_OFFLINE_BACKOFF_SECONDS, 30);
  // Polling interval when EventSub is disabled (default: 60 seconds)
  const pollWhenOfflineSeconds = parseIntEnv(env.FREEZE_POLL_WHEN_OFFLINE_SECONDS, 60);
  let nextRefreshAt = 0;

  // If no waitForOnline provided, use polling-based recovery
  const effectiveWaitForOnline = waitForOnline || createPollingWait(pollWhenOfflineSeconds, logger);

  const sampleSeconds = parseIntEnv(env.FREEZE_SAMPLE_SECONDS, 5);
  const thresholdSeconds = parseIntEnv(env.FREEZE_THRESHOLD_SECONDS, 20);
  const ffmpegTimeoutSeconds = parseIntEnv(env.FREEZE_FFMPEG_TIMEOUT_SECONDS, 8);
  const ffmpegOk = await checkFfmpeg();

  if (!ffmpegOk) {
    logger?.warn("Freeze monitor disabled: ffmpeg not found");
    return;
  }

  if (!hlsUrl && !channel) {
    logger?.warn("Freeze monitor disabled: FREEZE_HLS_URL or FREEZE_CHANNEL required");
    return;
  }

  logger?.log(`Freeze monitor enabled: sample ${sampleSeconds}s, threshold ${thresholdSeconds}s`);

  let lastHash = null;
  let lastChangeAt = Date.now();
  let frozen = false;
  let motionFrames = 0;
  let offline = false;
  let consecutiveFailures = 0;

  while (true) {
    const now = Date.now();
    const outputPath = join(tmpdir(), `kandy-frame-${now}.jpg`);

    try {
      if (!hlsUrl || Date.now() >= nextRefreshAt) {
        if (!channel) {
          throw new Error("FREEZE_CHANNEL is required for auto-fetch");
        }
        hlsUrl = await getPlaybackAccessToken(channel, clientId, getAuthToken());
        nextRefreshAt = Date.now() + tokenRefreshSeconds * 1000;
      }

      if (debug) {
        logger?.log("Freeze monitor: capturing frame");
      }
      const timeoutMs = Math.max(4000, ffmpegTimeoutSeconds * 1000);
      await captureFrame(hlsUrl, outputPath, timeoutMs);
      const hash = await hashFile(outputPath);
      consecutiveFailures = 0;
      if (offline) {
        offline = false;
        // Reset freeze state when coming back online
        frozen = false;
        motionFrames = 0;
        lastHash = null;
        lastChangeAt = Date.now();
        onOnline?.();
      }

      if (lastHash && hash === lastHash) {
        if (debug) {
          logger?.log("Freeze monitor: unchanged frame");
        }
        motionFrames = 0;
        if (!frozen && now - lastChangeAt >= thresholdSeconds * 1000) {
          frozen = true;
          onFreeze?.();
        }
      } else {
        if (debug) {
          logger?.log("Freeze monitor: motion detected");
        }
        lastHash = hash;
        lastChangeAt = now;
        if (frozen) {
          motionFrames += 1;
          if (motionFrames >= recoveryFrames) {
            frozen = false;
            motionFrames = 0;
            onRecover?.();
          }
        }
      }
    } catch (error) {
      consecutiveFailures += 1;
      logger?.warn(`Freeze monitor error: ${error.message}`);
      if (!offline && consecutiveFailures >= offlineFailThreshold) {
        offline = true;
        onOffline?.();
      }
    } finally {
      try {
        await fs.unlink(outputPath);
      } catch {
        // ignore cleanup errors
      }
    }

    if (offline) {
      // Use effectiveWaitForOnline which handles both EventSub and polling modes
      if (waitForOnline) {
        logger?.log("Freeze monitor: waiting for EventSub online signal");
      }
      await effectiveWaitForOnline();
      if (waitForOnline) {
        logger?.log("Freeze monitor: received online signal, resuming");
      }
      // Reset HLS URL so it gets re-fetched on next iteration
      hlsUrl = env.FREEZE_HLS_URL || null;
      nextRefreshAt = 0;
      await sleep(sampleSeconds * 1000);
    } else {
      await sleep(sampleSeconds * 1000);
    }
  }
}
