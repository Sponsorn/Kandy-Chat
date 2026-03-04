import { describe, it, expect } from "vitest";
import { parseMasterPlaylist, parseMediaPlaylist } from "../src/freezeMonitor.js";

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
