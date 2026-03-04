import { describe, it, expect } from "vitest";
import {
  parseMasterPlaylist,
  parseMediaPlaylist,
  createEscalationState,
  runCheckCycle,
} from "../src/freezeMonitor.js";

describe("parseMasterPlaylist", () => {
  it("returns the lowest bandwidth variant URL", () => {
    const m3u8 = [
      "#EXTM3U",
      '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080',
      "https://video-edge/source.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
      "https://video-edge/360p.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720',
      "https://video-edge/720p.m3u8",
    ].join("\n");

    expect(parseMasterPlaylist(m3u8)).toBe("https://video-edge/360p.m3u8");
  });

  it("returns the only variant when there is just one", () => {
    const m3u8 = [
      "#EXTM3U",
      '#EXT-X-STREAM-INF:BANDWIDTH=3000000',
      "https://video-edge/only.m3u8",
    ].join("\n");

    expect(parseMasterPlaylist(m3u8)).toBe("https://video-edge/only.m3u8");
  });

  it("returns null for empty or invalid playlist", () => {
    expect(parseMasterPlaylist("")).toBeNull();
    expect(parseMasterPlaylist("#EXTM3U\n")).toBeNull();
  });

  it("skips audio-only variants", () => {
    const m3u8 = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked"',
      '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080',
      "https://video-edge/source.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=200000,VIDEO="audio_only"',
      "https://video-edge/audio.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
      "https://video-edge/360p.m3u8",
    ].join("\n");

    expect(parseMasterPlaylist(m3u8)).toBe("https://video-edge/360p.m3u8");
  });
});

describe("parseMediaPlaylist", () => {
  it("extracts segment URIs and media sequence", () => {
    const m3u8 = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:2",
      "#EXT-X-MEDIA-SEQUENCE:100",
      "#EXTINF:2.000,",
      "https://video-edge/seg100.ts",
      "#EXTINF:2.000,",
      "https://video-edge/seg101.ts",
      "#EXTINF:2.000,",
      "https://video-edge/seg102.ts",
    ].join("\n");

    const result = parseMediaPlaylist(m3u8);
    expect(result.mediaSequence).toBe(100);
    expect(result.segments).toEqual([
      "https://video-edge/seg100.ts",
      "https://video-edge/seg101.ts",
      "https://video-edge/seg102.ts",
    ]);
  });

  it("defaults mediaSequence to 0 if missing", () => {
    const m3u8 = [
      "#EXTM3U",
      "#EXTINF:2.000,",
      "https://video-edge/seg0.ts",
    ].join("\n");

    const result = parseMediaPlaylist(m3u8);
    expect(result.mediaSequence).toBe(0);
    expect(result.segments).toEqual(["https://video-edge/seg0.ts"]);
  });

  it("returns empty segments for empty playlist", () => {
    const result = parseMediaPlaylist("#EXTM3U\n");
    expect(result.segments).toEqual([]);
    expect(result.mediaSequence).toBe(0);
  });
});

describe("escalation logic", () => {
  const defaults = {
    l1StaleChecks: 4,
    l2MatchChecks: 2,
    l3MatchChecks: 1,
    recoveryChecks: 3,
    ffmpegAvailable: true,
  };

  function makeState(overrides = {}) {
    return createEscalationState({ ...defaults, ...overrides });
  }

  it("stays NORMAL when segments change each cycle", () => {
    let state = makeState();
    state = runCheckCycle(state, { segments: ["a.ts", "b.ts"] });
    expect(state.level).toBe("NORMAL");
    state = runCheckCycle(state, { segments: ["c.ts", "d.ts"] });
    expect(state.level).toBe("NORMAL");
    expect(state.frozen).toBe(false);
  });

  it("escalates to L2_CHECK after L1 stale threshold", () => {
    let state = makeState();
    const segs = { segments: ["a.ts", "b.ts"] };
    state = runCheckCycle(state, segs); // first check sets baseline
    state = runCheckCycle(state, segs); // stale 1
    state = runCheckCycle(state, segs); // stale 2
    state = runCheckCycle(state, segs); // stale 3
    expect(state.level).toBe("NORMAL");
    state = runCheckCycle(state, segs); // stale 4 → escalate
    expect(state.level).toBe("L2_CHECK");
  });

  it("resets to NORMAL when segments change during L2", () => {
    let state = makeState({ l1StaleChecks: 1 });
    state = runCheckCycle(state, { segments: ["a.ts"] });
    state = runCheckCycle(state, { segments: ["a.ts"] }); // stale → L2
    expect(state.level).toBe("L2_CHECK");
    state = runCheckCycle(state, { segments: ["b.ts"] }); // changed → NORMAL
    expect(state.level).toBe("NORMAL");
  });

  it("escalates L2 → L3 after segment hash matches", () => {
    let state = makeState({ l1StaleChecks: 1, l2MatchChecks: 2 });
    state = runCheckCycle(state, { segments: ["a.ts"] });
    state = runCheckCycle(state, { segments: ["a.ts"] }); // → L2
    state = runCheckCycle(state, { segments: ["a.ts"], segmentHash: "abc123" }); // L2 match 1
    expect(state.level).toBe("L2_CHECK");
    state = runCheckCycle(state, { segments: ["a.ts"], segmentHash: "abc123" }); // L2 match 2 → L3
    expect(state.level).toBe("L3_CHECK");
  });

  it("declares freeze from L2 when ffmpeg unavailable", () => {
    let state = makeState({ l1StaleChecks: 1, l2MatchChecks: 1, ffmpegAvailable: false });
    const callbacks = { onFreeze: false };
    state = runCheckCycle(state, { segments: ["a.ts"] });
    state = runCheckCycle(state, { segments: ["a.ts"] }); // → L2
    state = runCheckCycle(state, { segments: ["a.ts"], segmentHash: "abc123" }, callbacks); // L2 match → FROZEN
    expect(state.frozen).toBe(true);
    expect(callbacks.onFreeze).toBe(true);
  });

  it("declares freeze from L3 after frame hash match", () => {
    let state = makeState({ l1StaleChecks: 1, l2MatchChecks: 1, l3MatchChecks: 1 });
    const callbacks = { onFreeze: false };
    state = runCheckCycle(state, { segments: ["a.ts"] });
    state = runCheckCycle(state, { segments: ["a.ts"] }); // → L2
    state = runCheckCycle(state, { segments: ["a.ts"], segmentHash: "abc" }); // → L3
    state = runCheckCycle(state, { segments: ["a.ts"], frameHash: "xyz" }, callbacks); // → FROZEN
    expect(state.frozen).toBe(true);
    expect(callbacks.onFreeze).toBe(true);
  });

  it("recovers after enough changed segments while frozen", () => {
    let state = makeState({
      l1StaleChecks: 1,
      l2MatchChecks: 1,
      ffmpegAvailable: false,
      recoveryChecks: 2,
    });
    const callbacks = { onFreeze: false, onRecover: false };
    state = runCheckCycle(state, { segments: ["a.ts"] });
    state = runCheckCycle(state, { segments: ["a.ts"] }); // → L2
    state = runCheckCycle(state, { segments: ["a.ts"], segmentHash: "x" }, callbacks); // → FROZEN
    expect(state.frozen).toBe(true);
    state = runCheckCycle(state, { segments: ["b.ts"] }, callbacks); // recovery 1
    expect(state.frozen).toBe(true);
    state = runCheckCycle(state, { segments: ["c.ts"] }, callbacks); // recovery 2 → recovered
    expect(state.frozen).toBe(false);
    expect(callbacks.onRecover).toBe(true);
  });

  it("resets recovery counter if segments go stale again while frozen", () => {
    let state = makeState({
      l1StaleChecks: 1,
      l2MatchChecks: 1,
      ffmpegAvailable: false,
      recoveryChecks: 3,
    });
    const callbacks = { onFreeze: false, onRecover: false };
    state = runCheckCycle(state, { segments: ["a.ts"] });
    state = runCheckCycle(state, { segments: ["a.ts"] });
    state = runCheckCycle(state, { segments: ["a.ts"], segmentHash: "x" }, callbacks);
    expect(state.frozen).toBe(true);
    state = runCheckCycle(state, { segments: ["b.ts"] }, callbacks); // recovery 1
    state = runCheckCycle(state, { segments: ["b.ts"] }, callbacks); // stale again → reset
    expect(state.motionChecks).toBe(0);
    expect(state.frozen).toBe(true);
  });
});
