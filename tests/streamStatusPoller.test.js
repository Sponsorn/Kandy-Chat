import { describe, it, expect, vi } from "vitest";
import { createStreamStatusPoller } from "../src/services/streamStatusPoller.js";

const silentLogger = { log: () => {}, error: () => {} };

function makeClient(liveByChannel) {
  return {
    getStreamStatus: vi.fn(async (logins) => {
      const result = new Map();
      for (const login of logins) {
        result.set(login, { live: Boolean(liveByChannel[login]) });
      }
      return result;
    })
  };
}

describe("createStreamStatusPoller", () => {
  it("normalizes channel names (strips # and lowercases)", () => {
    const poller = createStreamStatusPoller({
      twitchAPIClient: makeClient({}),
      channels: ["#Kandyland", " KandylandVods "],
      getKnownLive: () => false,
      onChange: () => {},
      logger: silentLogger
    });
    expect(poller.channels).toEqual(["kandyland", "kandylandvods"]);
  });

  it("does nothing when Helix agrees with the known state", async () => {
    const onChange = vi.fn();
    const poller = createStreamStatusPoller({
      twitchAPIClient: makeClient({ kandyland: true }),
      channels: ["kandyland"],
      getKnownLive: () => true,
      onChange,
      logger: silentLogger
    });

    await poller.pollOnce();
    await poller.pollOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("requires consecutive disagreeing polls before reporting a change", async () => {
    const onChange = vi.fn();
    const poller = createStreamStatusPoller({
      twitchAPIClient: makeClient({ kandyland: true }),
      channels: ["kandyland"],
      getKnownLive: () => false, // bot thinks offline, Helix says online
      onChange,
      confirmations: 2,
      logger: silentLogger
    });

    await poller.pollOnce();
    expect(onChange).not.toHaveBeenCalled();

    await poller.pollOnce();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("kandyland", true);
  });

  it("resets the disagreement counter when a poll agrees again", async () => {
    const onChange = vi.fn();
    const live = { kandyland: true };
    const poller = createStreamStatusPoller({
      twitchAPIClient: makeClient(live),
      channels: ["kandyland"],
      getKnownLive: () => false,
      onChange,
      confirmations: 2,
      logger: silentLogger
    });

    await poller.pollOnce(); // disagree 1
    live.kandyland = false;
    await poller.pollOnce(); // agrees, resets
    live.kandyland = true;
    await poller.pollOnce(); // disagree 1 again
    expect(onChange).not.toHaveBeenCalled();

    await poller.pollOnce(); // disagree 2
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("reports offline transitions too", async () => {
    const onChange = vi.fn();
    const poller = createStreamStatusPoller({
      twitchAPIClient: makeClient({ kandyland: false }),
      channels: ["kandyland"],
      getKnownLive: () => true,
      onChange,
      confirmations: 1,
      logger: silentLogger
    });

    await poller.pollOnce();
    expect(onChange).toHaveBeenCalledWith("kandyland", false);
  });

  it("adopts the Helix state immediately when the bot has no opinion yet", async () => {
    const onChange = vi.fn();
    const poller = createStreamStatusPoller({
      twitchAPIClient: makeClient({ kandyland: true }),
      channels: ["kandyland"],
      getKnownLive: () => null,
      onChange,
      confirmations: 3,
      logger: silentLogger
    });

    await poller.pollOnce();
    expect(onChange).toHaveBeenCalledWith("kandyland", true);
  });

  it("handles channels independently", async () => {
    const onChange = vi.fn();
    const known = { kandyland: false, kandylandvods: true };
    const poller = createStreamStatusPoller({
      twitchAPIClient: makeClient({ kandyland: true, kandylandvods: true }),
      channels: ["kandyland", "kandylandvods"],
      getKnownLive: (c) => known[c],
      onChange,
      confirmations: 1,
      logger: silentLogger
    });

    await poller.pollOnce();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("kandyland", true);
  });

  it("swallows Helix errors and keeps going", async () => {
    const error = vi.fn();
    const client = { getStreamStatus: vi.fn().mockRejectedValue(new Error("boom")) };
    const poller = createStreamStatusPoller({
      twitchAPIClient: client,
      channels: ["kandyland"],
      getKnownLive: () => false,
      onChange: () => {},
      logger: { log: () => {}, error }
    });

    await expect(poller.pollOnce()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("start/stop drive pollOnce on a timer", async () => {
    vi.useFakeTimers();
    try {
      const client = makeClient({ kandyland: false });
      const poller = createStreamStatusPoller({
        twitchAPIClient: client,
        channels: ["kandyland"],
        getKnownLive: () => false,
        onChange: () => {},
        intervalMs: 1000,
        logger: silentLogger
      });

      poller.start();
      await vi.advanceTimersByTimeAsync(3500);
      expect(client.getStreamStatus).toHaveBeenCalledTimes(3);

      poller.stop();
      await vi.advanceTimersByTimeAsync(3000);
      expect(client.getStreamStatus).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start when there are no channels or the interval is disabled", () => {
    const client = makeClient({});
    const none = createStreamStatusPoller({
      twitchAPIClient: client,
      channels: [],
      getKnownLive: () => false,
      onChange: () => {},
      logger: silentLogger
    });
    none.start();

    const disabled = createStreamStatusPoller({
      twitchAPIClient: client,
      channels: ["kandyland"],
      getKnownLive: () => false,
      onChange: () => {},
      intervalMs: 0,
      logger: silentLogger
    });
    disabled.start();

    expect(client.getStreamStatus).not.toHaveBeenCalled();
  });
});
