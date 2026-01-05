import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

function parseBool(value, fallback = false) {
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

function parseIntEnv(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { windowsHide: true });
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
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
  const body = [{ ...PLAYBACK_ACCESS_QUERY, variables: { ...PLAYBACK_ACCESS_QUERY.variables, login: normalizedChannel } }];

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
  { onFreeze, onRecover, onOffline, onOnline, logger }
) {
  const enabled = parseBool(env.FREEZE_CHECK_ENABLED, false);
  if (!enabled) return;

  const channel = env.FREEZE_CHANNEL;
  const clientId = env.FREEZE_CLIENT_ID || "kimne78kx3ncx6brgo4mv6wki5h1ko";
  const authToken = env.FREEZE_OAUTH_BEARER;
  let hlsUrl = env.FREEZE_HLS_URL;
  const tokenRefreshSeconds = parseIntEnv(env.FREEZE_TOKEN_REFRESH_SECONDS, 300);
  const debug = parseBool(env.FREEZE_DEBUG, false);
  const offlineFailThreshold = parseIntEnv(env.FREEZE_OFFLINE_FAILS, 3);
  const offlineBackoffSeconds = parseIntEnv(
    env.FREEZE_OFFLINE_BACKOFF_SECONDS,
    30
  );
  let nextRefreshAt = 0;

  const sampleSeconds = parseIntEnv(env.FREEZE_SAMPLE_SECONDS, 5);
  const thresholdSeconds = parseIntEnv(env.FREEZE_THRESHOLD_SECONDS, 20);
  const ffmpegOk = await checkFfmpeg();

  if (!ffmpegOk) {
    logger?.warn("Freeze monitor disabled: ffmpeg not found");
    return;
  }

  if (!hlsUrl && !channel) {
    logger?.warn("Freeze monitor disabled: FREEZE_HLS_URL or FREEZE_CHANNEL required");
    return;
  }

  logger?.log(
    `Freeze monitor enabled: sample ${sampleSeconds}s, threshold ${thresholdSeconds}s`
  );

  let lastHash = null;
  let lastChangeAt = Date.now();
  let frozen = false;
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
        hlsUrl = await getPlaybackAccessToken(channel, clientId, authToken);
        nextRefreshAt = Date.now() + tokenRefreshSeconds * 1000;
      }

      if (debug) {
        logger?.log("Freeze monitor: capturing frame");
      }
      await captureFrame(hlsUrl, outputPath, Math.max(4000, sampleSeconds * 1000));
      const hash = await hashFile(outputPath);
      consecutiveFailures = 0;
      if (offline) {
        offline = false;
        onOnline?.();
      }

      if (lastHash && hash === lastHash) {
        if (debug) {
          logger?.log("Freeze monitor: unchanged frame");
        }
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
          frozen = false;
          onRecover?.();
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

    const delaySeconds = offline ? offlineBackoffSeconds : sampleSeconds;
    await sleep(delaySeconds * 1000);
  }
}
