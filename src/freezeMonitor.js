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

export function parseMasterPlaylist(text) {
  const lines = text.split("\n").map((l) => l.trim());
  let lowestBandwidth = Infinity;
  let lowestUrl = null;

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
    const attrs = lines[i].substring("#EXT-X-STREAM-INF:".length);
    // Skip audio-only variants (no RESOLUTION and VIDEO="audio_only")
    if (!attrs.includes("RESOLUTION=") && attrs.includes("audio_only")) continue;
    const bwMatch = attrs.match(/BANDWIDTH=(\d+)/);
    if (!bwMatch) continue;
    const bw = parseInt(bwMatch[1], 10);
    const url = lines[i + 1];
    if (url && !url.startsWith("#") && bw < lowestBandwidth) {
      lowestBandwidth = bw;
      lowestUrl = url;
    }
  }

  return lowestUrl;
}

export function parseMediaPlaylist(text) {
  const lines = text.split("\n").map((l) => l.trim());
  let mediaSequence = 0;
  const segments = [];

  for (const line of lines) {
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = parseInt(line.split(":")[1], 10) || 0;
    } else if (line && !line.startsWith("#")) {
      segments.push(line);
    }
  }

  return { mediaSequence, segments };
}

export function createEscalationState({
  l1StaleChecks,
  l2MatchChecks,
  l3MatchChecks,
  recoveryChecks,
  ffmpegAvailable
}) {
  return {
    // Config
    l1StaleChecks,
    l2MatchChecks,
    l3MatchChecks,
    recoveryChecks,
    ffmpegAvailable,
    // State
    level: "NORMAL", // NORMAL | L2_CHECK | L3_CHECK
    frozen: false,
    prevSegments: null,
    prevSegmentHash: null,
    prevFrameHash: null,
    l1StaleCount: 0,
    l2MatchCount: 0,
    l3MatchCount: 0,
    motionChecks: 0
  };
}

export function runCheckCycle(state, data, callbacks) {
  const s = { ...state };
  const segmentsKey = data.segments.join(",");
  const prevKey = s.prevSegments ? s.prevSegments.join(",") : null;
  const segmentsChanged = prevKey !== null && segmentsKey !== prevKey;
  s.prevSegments = data.segments;

  // --- Recovery path (when frozen) ---
  if (s.frozen) {
    if (segmentsChanged) {
      s.motionChecks += 1;
      if (s.motionChecks >= s.recoveryChecks) {
        s.frozen = false;
        s.motionChecks = 0;
        s.level = "NORMAL";
        s.l1StaleCount = 0;
        s.l2MatchCount = 0;
        s.l3MatchCount = 0;
        s.prevSegmentHash = null;
        s.prevFrameHash = null;
        if (callbacks) callbacks.onRecover = true;
      }
    } else {
      s.motionChecks = 0;
    }
    return s;
  }

  // --- Normal detection path ---
  if (segmentsChanged || prevKey === null) {
    // Segments changed (or first check) — reset everything
    s.level = "NORMAL";
    s.l1StaleCount = 0;
    s.l2MatchCount = 0;
    s.l3MatchCount = 0;
    s.prevSegmentHash = null;
    s.prevFrameHash = null;
    return s;
  }

  // Segments are stale
  if (s.level === "NORMAL") {
    s.l1StaleCount += 1;
    if (s.l1StaleCount >= s.l1StaleChecks) {
      s.level = "L2_CHECK";
    }
    return s;
  }

  if (s.level === "L2_CHECK") {
    if (data.segmentHash != null) {
      if (s.prevSegmentHash == null || data.segmentHash === s.prevSegmentHash) {
        s.l2MatchCount += 1;
      } else {
        s.l2MatchCount = 0;
      }
      s.prevSegmentHash = data.segmentHash;

      if (s.l2MatchCount >= s.l2MatchChecks) {
        if (s.ffmpegAvailable) {
          s.level = "L3_CHECK";
        } else {
          s.frozen = true;
          if (callbacks) callbacks.onFreeze = true;
        }
      }
    }
    return s;
  }

  if (s.level === "L3_CHECK") {
    if (data.frameHash != null) {
      if (s.prevFrameHash == null || data.frameHash === s.prevFrameHash) {
        s.l3MatchCount += 1;
      } else {
        s.l3MatchCount = 0;
      }
      s.prevFrameHash = data.frameHash;

      if (s.l3MatchCount >= s.l3MatchChecks) {
        s.frozen = true;
        if (callbacks) callbacks.onFreeze = true;
      }
    }
    return s;
  }

  return s;
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

async function fetchMasterAndSelectVariant(masterUrl) {
  const response = await fetch(masterUrl);
  if (!response.ok) throw new Error(`Master playlist fetch failed: ${response.status}`);
  const text = await response.text();
  const variantUrl = parseMasterPlaylist(text);
  if (!variantUrl) throw new Error("No suitable variant found in master playlist");
  // Handle relative URLs
  if (variantUrl.startsWith("http")) return variantUrl;
  const base = masterUrl.substring(0, masterUrl.lastIndexOf("/") + 1);
  return base + variantUrl;
}

async function fetchMediaPlaylist(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Media playlist fetch failed: ${response.status}`);
  const text = await response.text();
  return parseMediaPlaylist(text);
}

async function hashSegment(segmentUrl) {
  const response = await fetch(segmentUrl);
  if (!response.ok) throw new Error(`Segment fetch failed: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return createHash("sha1").update(buffer).digest("hex");
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
  const pollWhenOfflineSeconds = parseIntEnv(env.FREEZE_POLL_WHEN_OFFLINE_SECONDS, 60);
  const sampleSeconds = parseIntEnv(env.FREEZE_SAMPLE_SECONDS, 5);
  const ffmpegTimeoutSeconds = parseIntEnv(env.FREEZE_FFMPEG_TIMEOUT_SECONDS, 8);
  const recoveryChecks = parseIntEnv(env.FREEZE_RECOVERY_FRAMES, 3);
  const l1StaleChecks = parseIntEnv(env.FREEZE_L1_STALE_CHECKS, 4);
  const l2MatchChecks = parseIntEnv(env.FREEZE_L2_MATCH_CHECKS, 2);
  const l3MatchChecks = parseIntEnv(env.FREEZE_L3_MATCH_CHECKS, 1);

  let nextRefreshAt = 0;
  const effectiveWaitForOnline = waitForOnline || createPollingWait(pollWhenOfflineSeconds, logger);

  if (!hlsUrl && !channel) {
    logger?.warn("Freeze monitor disabled: FREEZE_HLS_URL or FREEZE_CHANNEL required");
    return;
  }

  const ffmpegAvailable = await checkFfmpeg();
  if (!ffmpegAvailable) {
    logger?.log("Freeze monitor: ffmpeg not found, Level 3 (frame capture) disabled");
  }

  logger?.log(
    `Freeze monitor enabled: sample ${sampleSeconds}s, levels 1-${ffmpegAvailable ? 3 : 2}`
  );

  let state = createEscalationState({
    l1StaleChecks,
    l2MatchChecks,
    l3MatchChecks,
    recoveryChecks,
    ffmpegAvailable
  });
  let mediaPlaylistUrl = null;
  let offline = false;
  let consecutiveFailures = 0;

  while (true) {
    try {
      // Refresh master playlist URL if needed
      if (!hlsUrl || Date.now() >= nextRefreshAt) {
        if (!channel) throw new Error("FREEZE_CHANNEL is required for auto-fetch");
        hlsUrl = await getPlaybackAccessToken(channel, clientId, getAuthToken());
        nextRefreshAt = Date.now() + tokenRefreshSeconds * 1000;
        mediaPlaylistUrl = null; // force re-resolve
      }

      // Resolve media playlist URL from master if needed
      if (!mediaPlaylistUrl) {
        mediaPlaylistUrl = await fetchMasterAndSelectVariant(hlsUrl);
        if (debug) logger?.log(`Freeze monitor: using variant ${mediaPlaylistUrl}`);
      }

      // Level 1: fetch media playlist
      const playlist = await fetchMediaPlaylist(mediaPlaylistUrl);
      if (debug) {
        logger?.log(
          `Freeze monitor: L1 seq=${playlist.mediaSequence} segs=${playlist.segments.length} level=${state.level}`
        );
      }

      const cycleData = { segments: playlist.segments };

      // Level 2: hash segment if escalation requires it
      if (state.level === "L2_CHECK" && playlist.segments.length > 0) {
        const lastSegment = playlist.segments[playlist.segments.length - 1];
        try {
          cycleData.segmentHash = await hashSegment(lastSegment);
          if (debug) logger?.log(`Freeze monitor: L2 hash=${cycleData.segmentHash.slice(0, 8)}`);
        } catch (err) {
          logger?.warn(`Freeze monitor: L2 segment fetch failed: ${err.message}`);
        }
      }

      // Level 3: ffmpeg frame capture if escalation requires it
      if (state.level === "L3_CHECK" && ffmpegAvailable) {
        const now = Date.now();
        const outputPath = join(tmpdir(), `kandy-frame-${now}.jpg`);
        try {
          const timeoutMs = Math.max(4000, ffmpegTimeoutSeconds * 1000);
          await captureFrame(hlsUrl, outputPath, timeoutMs);
          cycleData.frameHash = await hashFile(outputPath);
          if (debug) logger?.log(`Freeze monitor: L3 hash=${cycleData.frameHash.slice(0, 8)}`);
        } catch (err) {
          logger?.warn(`Freeze monitor: L3 frame capture failed: ${err.message}`);
        } finally {
          try {
            await fs.unlink(outputPath);
          } catch {
            /* ignore */
          }
        }
      }

      // Run state machine
      consecutiveFailures = 0;
      if (offline) {
        offline = false;
        state = createEscalationState({
          l1StaleChecks,
          l2MatchChecks,
          l3MatchChecks,
          recoveryChecks,
          ffmpegAvailable
        });
        onOnline?.();
      }

      const callbacks = {};
      state = runCheckCycle(state, cycleData, callbacks);

      if (callbacks.onFreeze) onFreeze?.();
      if (callbacks.onRecover) onRecover?.();
    } catch (error) {
      consecutiveFailures += 1;
      logger?.warn(`Freeze monitor error: ${error.message}`);
      if (!offline && consecutiveFailures >= offlineFailThreshold) {
        offline = true;
        onOffline?.();
      }
    }

    if (offline) {
      if (waitForOnline) {
        logger?.log("Freeze monitor: waiting for EventSub online signal");
      }
      await effectiveWaitForOnline();
      if (waitForOnline) {
        logger?.log("Freeze monitor: received online signal, resuming");
      }
      hlsUrl = env.FREEZE_HLS_URL || null;
      mediaPlaylistUrl = null;
      nextRefreshAt = 0;
      await sleep(sampleSeconds * 1000);
    } else {
      await sleep(sampleSeconds * 1000);
    }
  }
}
