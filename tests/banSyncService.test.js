import { describe, it, expect, beforeEach, vi } from "vitest";
import botState from "../src/state/BotState.js";

// Keep the tracked-ban state file out of the tests
vi.mock("../src/banSyncStore.js", () => ({
  loadTrackedBans: vi.fn(async () => []),
  saveTrackedBans: vi.fn(async () => {})
}));

import { saveTrackedBans } from "../src/banSyncStore.js";
import {
  DEFAULT_BAN_REASON_TEMPLATE,
  planBanMirror,
  validateBanSyncConfig,
  renderBanReason,
  noteBanAttribution,
  takeBanAttribution,
  mirrorBan,
  mirrorUnban,
  hydrateTrackedBans,
  getTrackedBans,
  getTrackedBanCount,
  checkTrackedUnbans,
  createBanSyncPoller
} from "../src/services/banSyncService.js";

const KNOWN = ["#kandyland", "kandylandvods"];

function makeClient({
  banError = null,
  unbanError = null,
  bannedEntry = null,
  stillBannedIds = []
} = {}) {
  return {
    banUser: vi.fn(async () => {
      if (banError) throw new Error(banError);
    }),
    unbanUser: vi.fn(async () => {
      if (unbanError) throw new Error(unbanError);
    }),
    getBannedUser: vi.fn(async () => bannedEntry),
    getUserId: vi.fn(async (login) => `id-${login.toLowerCase()}`),
    getBannedUsersByIds: vi.fn(async (_channel, ids) => {
      const map = new Map();
      for (const id of ids) {
        if (stillBannedIds.includes(id)) map.set(id, { moderatorName: "x", reason: "" });
      }
      return map;
    })
  };
}

beforeEach(() => {
  hydrateTrackedBans([]);
  saveTrackedBans.mockClear();
  botState.runtimeConfig.banSync = {};
  botState.modActions = [];
  botState.discordChannels = [];
  botState.channelMapping = new Map();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("planBanMirror", () => {
  const config = { enabled: true, sourceChannel: "kandyland", targetChannels: ["kandylandvods"] };

  it("mirrors a ban in the source channel to every target", () => {
    expect(planBanMirror(config, "#kandyland")).toEqual(["kandylandvods"]);
    expect(planBanMirror(config, "KandyLand")).toEqual(["kandylandvods"]);
  });

  it("never mirrors a ban that happened in a target channel", () => {
    expect(planBanMirror(config, "#kandylandvods")).toEqual([]);
  });

  it("does nothing when disabled or unconfigured", () => {
    expect(planBanMirror({ ...config, enabled: false }, "#kandyland")).toEqual([]);
    expect(planBanMirror({ ...config, sourceChannel: null }, "#kandyland")).toEqual([]);
    expect(planBanMirror(null, "#kandyland")).toEqual([]);
  });

  it("drops the source, duplicates and blanks from the target list", () => {
    const messy = {
      ...config,
      targetChannels: ["#KandylandVods", "kandylandvods", "kandyland", "", null]
    };
    expect(planBanMirror(messy, "#kandyland")).toEqual(["kandylandvods"]);
  });
});

describe("validateBanSyncConfig", () => {
  it("accepts a full valid config and normalizes channel names", () => {
    const { config, errors } = validateBanSyncConfig(
      {
        enabled: true,
        sourceChannel: "#Kandyland",
        targetChannels: ["KandylandVods"],
        mirrorUnbans: false,
        announceInDiscord: true,
        reasonTemplate: "Banned in main channel by {moderator}"
      },
      KNOWN
    );
    expect(errors).toEqual([]);
    expect(config).toEqual({
      enabled: true,
      sourceChannel: "kandyland",
      targetChannels: ["kandylandvods"],
      mirrorUnbans: false,
      announceInDiscord: true,
      reasonTemplate: "Banned in main channel by {moderator}"
    });
  });

  it("applies defaults for omitted fields", () => {
    const { config, errors } = validateBanSyncConfig({ enabled: false }, KNOWN);
    expect(errors).toEqual([]);
    expect(config.mirrorUnbans).toBe(true);
    expect(config.announceInDiscord).toBe(true);
    expect(config.reasonTemplate).toBe(DEFAULT_BAN_REASON_TEMPLATE);
    expect(config.sourceChannel).toBeNull();
    expect(config.targetChannels).toEqual([]);
  });

  it("requires a source and at least one target when enabled", () => {
    const { config, errors } = validateBanSyncConfig({ enabled: true }, KNOWN);
    expect(config).toBeNull();
    expect(errors.join(" ")).toMatch(/sourceChannel is required/);
    expect(errors.join(" ")).toMatch(/targetChannel is required/);
  });

  it("rejects channels the bot has not joined", () => {
    const { errors } = validateBanSyncConfig(
      { enabled: true, sourceChannel: "someoneelse", targetChannels: ["kandylandvods"] },
      KNOWN
    );
    expect(errors.join(" ")).toMatch(/not a channel the bot has joined/);
  });

  it("rejects a target equal to the source", () => {
    const { errors } = validateBanSyncConfig(
      { enabled: true, sourceChannel: "kandyland", targetChannels: ["kandyland"] },
      KNOWN
    );
    expect(errors.join(" ")).toMatch(/cannot be the same as sourceChannel/);
  });

  it("rejects wrong types", () => {
    const { errors } = validateBanSyncConfig(
      { enabled: "yes", targetChannels: "kandylandvods", reasonTemplate: 5 },
      KNOWN
    );
    expect(errors).toContain("enabled must be a boolean");
    expect(errors).toContain("targetChannels must be an array");
    expect(errors).toContain("reasonTemplate must be a string");
  });
});

describe("renderBanReason", () => {
  const vars = {
    source: "kandyland",
    target: "kandylandvods",
    moderator: "Anton",
    user: "spammer",
    reason: "spam"
  };

  it("fills every tag", () => {
    expect(
      renderBanReason("Banned in {source} by {moderator} ({reason}) -> {target} {user}", vars)
    ).toBe("Banned in kandyland by Anton (spam) -> kandylandvods spammer");
  });

  it("falls back to the default template when empty", () => {
    expect(renderBanReason("", vars)).toBe("Banned in kandyland by Anton");
    expect(renderBanReason(null, vars)).toBe("Banned in kandyland by Anton");
  });

  it("collapses whitespace left by empty tags and caps the length", () => {
    expect(renderBanReason("Banned by {moderator} {reason} .", { ...vars, reason: "" })).toBe(
      "Banned by Anton ."
    );
    expect(renderBanReason("x".repeat(600), vars)).toHaveLength(500);
  });
});

describe("ban attribution", () => {
  it("remembers who asked for a ban once, case-insensitively", () => {
    noteBanAttribution("#Kandyland", "Spammer", "Anton");
    expect(takeBanAttribution("kandyland", "spammer")).toBe("Anton");
    expect(takeBanAttribution("kandyland", "spammer")).toBeNull();
  });

  it("ignores empty moderators", () => {
    noteBanAttribution("kandyland", "spammer", "");
    expect(takeBanAttribution("kandyland", "spammer")).toBeNull();
  });
});

describe("mirrorBan", () => {
  beforeEach(() => {
    botState.runtimeConfig.banSync = {
      enabled: true,
      sourceChannel: "kandyland",
      targetChannels: ["kandylandvods"],
      mirrorUnbans: true,
      announceInDiscord: true,
      reasonTemplate: "Banned in main channel by {moderator}"
    };
  });

  it("bans the user in the target with the rendered reason, crediting a bot-issued ban", async () => {
    const client = makeClient();
    noteBanAttribution("#kandyland", "spammer", "Anton");

    const result = await mirrorBan("#kandyland", "spammer", client);

    expect(result.mirrored).toEqual(["kandylandvods"]);
    expect(result.moderator).toBe("Anton");
    expect(client.banUser).toHaveBeenCalledWith(
      "#kandylandvods",
      "spammer",
      "Banned in main channel by Anton"
    );
    expect(client.getBannedUser).not.toHaveBeenCalled();
    expect(botState.modActions[0]).toMatchObject({
      action: "ban",
      moderator: "BanSync",
      target: "spammer",
      source: "auto",
      status: "success",
      details: { channel: "#kandylandvods", sourceChannel: "#kandyland" }
    });
  });

  it("looks up the Twitch moderator via Helix for bans the bot did not issue", async () => {
    const client = makeClient({
      bannedEntry: { moderatorLogin: "modname", moderatorName: "ModName", reason: "rude" }
    });

    const result = await mirrorBan("#kandyland", "spammer", client);

    expect(result.moderator).toBe("ModName");
    expect(client.getBannedUser).toHaveBeenCalledWith("#kandyland", "spammer");
    expect(client.banUser).toHaveBeenCalledWith(
      "#kandylandvods",
      "spammer",
      "Banned in main channel by ModName"
    );
  });

  it("falls back to a generic moderator when the lookup fails", async () => {
    const client = makeClient();
    client.getBannedUser = vi.fn(async () => {
      throw new Error("Failed to look up ban: 401 - missing scope");
    });

    const result = await mirrorBan("#kandyland", "spammer", client);

    expect(result.mirrored).toEqual(["kandylandvods"]);
    expect(client.banUser).toHaveBeenCalledWith(
      "#kandylandvods",
      "spammer",
      "Banned in main channel by a moderator"
    );
  });

  it("does nothing for bans in a target channel", async () => {
    const client = makeClient();
    const result = await mirrorBan("#kandylandvods", "spammer", client);
    expect(result.mirrored).toEqual([]);
    expect(client.banUser).not.toHaveBeenCalled();
    expect(client.getBannedUser).not.toHaveBeenCalled();
  });

  it("does nothing when disabled", async () => {
    botState.runtimeConfig.banSync.enabled = false;
    const client = makeClient();
    await mirrorBan("#kandyland", "spammer", client);
    expect(client.banUser).not.toHaveBeenCalled();
  });

  it("treats an already-banned response as skipped, not failed", async () => {
    const client = makeClient({
      banError:
        "Failed to ban user: 400 - The user specified in the user_id field is already banned."
    });
    const result = await mirrorBan("#kandyland", "spammer", client);
    expect(result.skipped).toEqual(["kandylandvods"]);
    expect(result.failed).toEqual([]);
    expect(botState.modActions).toHaveLength(0);
  });

  it("records a failed mod action when the ban call fails", async () => {
    const client = makeClient({ banError: "Failed to ban user: 500 - boom" });
    const result = await mirrorBan("#kandyland", "spammer", client);
    expect(result.failed).toEqual(["kandylandvods"]);
    expect(botState.modActions[0]).toMatchObject({ action: "ban", status: "failed" });
  });

  it("posts a notice to the Discord channel mapped to the source channel", async () => {
    const sourceDiscord = { id: "111", isTextBased: () => true, send: vi.fn(async () => ({})) };
    const targetDiscord = { id: "222", isTextBased: () => true, send: vi.fn(async () => ({})) };
    botState.discordChannels = [sourceDiscord, targetDiscord];
    botState.channelMapping = new Map([
      ["kandyland", "111"],
      ["kandylandvods", "222"]
    ]);
    noteBanAttribution("kandyland", "spammer", "Anton");

    await mirrorBan("#kandyland", "spammer", makeClient());

    expect(sourceDiscord.send).toHaveBeenCalledTimes(1);
    expect(sourceDiscord.send.mock.calls[0][0]).toContain("**spammer**");
    expect(sourceDiscord.send.mock.calls[0][0]).toContain("by Anton");
    expect(sourceDiscord.send.mock.calls[0][0]).toContain("#kandylandvods");
    expect(targetDiscord.send).not.toHaveBeenCalled();
  });

  it("stays quiet in Discord when announcements are off", async () => {
    botState.runtimeConfig.banSync.announceInDiscord = false;
    const discord = { id: "111", isTextBased: () => true, send: vi.fn(async () => ({})) };
    botState.discordChannels = [discord];

    await mirrorBan("#kandyland", "spammer", makeClient());
    expect(discord.send).not.toHaveBeenCalled();
  });
});

describe("mirrorUnban", () => {
  beforeEach(() => {
    botState.runtimeConfig.banSync = {
      enabled: true,
      sourceChannel: "kandyland",
      targetChannels: ["kandylandvods"],
      mirrorUnbans: true,
      announceInDiscord: false
    };
  });

  it("unbans the user in the target", async () => {
    const client = makeClient();
    const result = await mirrorUnban("#kandyland", "Spammer", client);
    expect(result.mirrored).toEqual(["kandylandvods"]);
    expect(client.unbanUser).toHaveBeenCalledWith("#kandylandvods", "spammer");
    expect(botState.modActions[0]).toMatchObject({ action: "unban", moderator: "BanSync" });
  });

  it("respects the mirrorUnbans switch", async () => {
    botState.runtimeConfig.banSync.mirrorUnbans = false;
    const client = makeClient();
    await mirrorUnban("#kandyland", "spammer", client);
    expect(client.unbanUser).not.toHaveBeenCalled();
  });

  it("treats a not-banned response as skipped", async () => {
    const client = makeClient({
      unbanError:
        "Failed to unban user: 400 - The user specified in the user_id query parameter is not banned."
    });
    const result = await mirrorUnban("#kandyland", "spammer", client);
    expect(result.skipped).toEqual(["kandylandvods"]);
    expect(result.failed).toEqual([]);
  });
});

describe("mirrored ban tracking", () => {
  beforeEach(() => {
    botState.runtimeConfig.banSync = {
      enabled: true,
      sourceChannel: "kandyland",
      targetChannels: ["kandylandvods"],
      mirrorUnbans: true,
      announceInDiscord: false
    };
  });

  it("remembers a mirrored ban with the user id and persists it", async () => {
    await mirrorBan("#kandyland", "Spammer", makeClient());

    expect(getTrackedBans()).toEqual([
      expect.objectContaining({
        login: "spammer",
        userId: "id-spammer",
        source: "kandyland",
        targets: ["kandylandvods"]
      })
    ]);
    expect(saveTrackedBans).toHaveBeenCalledTimes(1);
    expect(saveTrackedBans.mock.calls[0][0][0]).toMatchObject({ login: "spammer" });
  });

  it("does not track a target that was already banned independently", async () => {
    const client = makeClient({
      banError:
        "Failed to ban user: 400 - The user specified in the user_id field is already banned."
    });
    await mirrorBan("#kandyland", "spammer", client);
    expect(getTrackedBanCount()).toBe(0);
  });

  it("forgets the entry once the mirrored unban went through", async () => {
    await mirrorBan("#kandyland", "spammer", makeClient());
    expect(getTrackedBanCount()).toBe(1);

    await mirrorUnban("#kandyland", "spammer", makeClient());
    expect(getTrackedBanCount()).toBe(0);
  });

  it("keeps the entry when the mirrored unban failed so the poller retries", async () => {
    await mirrorBan("#kandyland", "spammer", makeClient());
    await mirrorUnban("#kandyland", "spammer", makeClient({ unbanError: "500 boom" }));
    expect(getTrackedBanCount()).toBe(1);
  });

  it("hydrates persisted entries and normalizes them", () => {
    hydrateTrackedBans([
      { login: "Spammer", userId: "1", source: "#Kandyland", targets: ["#KandylandVods"] },
      { login: "", targets: ["x"] },
      { login: "notargets", targets: [] }
    ]);
    expect(getTrackedBans()).toEqual([
      expect.objectContaining({
        login: "spammer",
        userId: "1",
        source: "kandyland",
        targets: ["kandylandvods"]
      })
    ]);
  });
});

describe("checkTrackedUnbans", () => {
  beforeEach(() => {
    botState.runtimeConfig.banSync = {
      enabled: true,
      sourceChannel: "kandyland",
      targetChannels: ["kandylandvods"],
      mirrorUnbans: true,
      announceInDiscord: false
    };
    hydrateTrackedBans([
      { login: "gone", userId: "id-gone", source: "kandyland", targets: ["kandylandvods"] },
      {
        login: "stillbanned",
        userId: "id-stillbanned",
        source: "kandyland",
        targets: ["kandylandvods"]
      }
    ]);
  });

  it("unbans tracked users who are no longer banned in the source and leaves the rest", async () => {
    const client = makeClient({ stillBannedIds: ["id-stillbanned"] });

    const summary = await checkTrackedUnbans(client);

    expect(client.getBannedUsersByIds).toHaveBeenCalledWith("#kandyland", [
      "id-gone",
      "id-stillbanned"
    ]);
    expect(summary).toEqual({ checked: 2, unbanned: ["gone"], failed: [] });
    expect(client.unbanUser).toHaveBeenCalledTimes(1);
    expect(client.unbanUser).toHaveBeenCalledWith("#kandylandvods", "gone");
    expect(getTrackedBans().map((e) => e.login)).toEqual(["stillbanned"]);
    expect(botState.modActions[0]).toMatchObject({
      action: "unban",
      moderator: "BanSync",
      target: "gone",
      details: { channel: "#kandylandvods", sourceChannel: "#kandyland" }
    });
  });

  it("resolves missing user ids before checking", async () => {
    hydrateTrackedBans([
      { login: "noid", userId: null, source: "kandyland", targets: ["kandylandvods"] }
    ]);
    const client = makeClient({ stillBannedIds: ["id-noid"] });

    const summary = await checkTrackedUnbans(client);

    expect(client.getUserId).toHaveBeenCalledWith("noid");
    expect(summary.checked).toBe(1);
    expect(client.unbanUser).not.toHaveBeenCalled();
    expect(getTrackedBans()[0].userId).toBe("id-noid");
  });

  it("does nothing when mirrorUnbans is off or the sync is disabled", async () => {
    botState.runtimeConfig.banSync.mirrorUnbans = false;
    const client = makeClient();
    expect(await checkTrackedUnbans(client)).toEqual({ checked: 0, unbanned: [], failed: [] });
    expect(client.getBannedUsersByIds).not.toHaveBeenCalled();

    botState.runtimeConfig.banSync = {
      ...botState.runtimeConfig.banSync,
      mirrorUnbans: true,
      enabled: false
    };
    expect(await checkTrackedUnbans(client)).toEqual({ checked: 0, unbanned: [], failed: [] });
  });

  it("ignores tracked entries from a different source channel", async () => {
    hydrateTrackedBans([
      { login: "other", userId: "id-other", source: "elsewhere", targets: ["kandylandvods"] }
    ]);
    const client = makeClient();
    expect(await checkTrackedUnbans(client)).toEqual({ checked: 0, unbanned: [], failed: [] });
    expect(client.getBannedUsersByIds).not.toHaveBeenCalled();
  });

  it("keeps everything tracked when the Helix lookup fails", async () => {
    const client = makeClient();
    client.getBannedUsersByIds = vi.fn(async () => {
      throw new Error("Failed to look up bans: 401 - missing scope");
    });

    const summary = await checkTrackedUnbans(client);

    expect(summary).toEqual({ checked: 0, unbanned: [], failed: [] });
    expect(client.unbanUser).not.toHaveBeenCalled();
    expect(getTrackedBanCount()).toBe(2);
  });
});

describe("createBanSyncPoller", () => {
  it("starts and stops an interval and runs the check", async () => {
    vi.useFakeTimers();
    botState.runtimeConfig.banSync = {
      enabled: true,
      sourceChannel: "kandyland",
      targetChannels: ["kandylandvods"],
      mirrorUnbans: true,
      announceInDiscord: false
    };
    hydrateTrackedBans([
      { login: "gone", userId: "id-gone", source: "kandyland", targets: ["kandylandvods"] }
    ]);
    const client = makeClient();
    const poller = createBanSyncPoller({
      twitchAPIClient: client,
      intervalMs: 1000,
      logger: { log: () => {}, error: () => {} }
    });

    poller.start();
    expect(poller.running).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.getBannedUsersByIds).toHaveBeenCalledTimes(1);
    expect(client.unbanUser).toHaveBeenCalledWith("#kandylandvods", "gone");

    poller.stop();
    expect(poller.running).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.getBannedUsersByIds).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
