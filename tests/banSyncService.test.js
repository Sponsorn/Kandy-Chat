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
  handleModerationEvent,
  setAttributionWaitMs
} from "../src/services/banSyncService.js";

const KNOWN = ["#kandyland", "kandylandvods"];

function makeClient({ banError = null, unbanError = null } = {}) {
  return {
    banUser: vi.fn(async () => {
      if (banError) throw new Error(banError);
    }),
    unbanUser: vi.fn(async () => {
      if (unbanError) throw new Error(unbanError);
    })
  };
}

const tracked = (login, targets = ["kandylandvods"], source = "kandyland") => ({
  login,
  source,
  targets
});

beforeEach(() => {
  setAttributionWaitMs(0);
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
  it("remembers who banned once, case-insensitively, with the reason", () => {
    noteBanAttribution("#Kandyland", "Spammer", "Anton", "spam");
    expect(takeBanAttribution("kandyland", "spammer")).toEqual({
      moderator: "Anton",
      reason: "spam"
    });
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
    expect(botState.modActions[0]).toMatchObject({
      action: "ban",
      moderator: "BanSync",
      target: "spammer",
      source: "auto",
      status: "success",
      details: { channel: "#kandylandvods", sourceChannel: "#kandyland" }
    });
  });

  it("credits the Twitch moderator from a channel.moderate notice that arrives after IRC", async () => {
    setAttributionWaitMs(2000);
    botState.runtimeConfig.banSync.reasonTemplate = "{moderator}: {reason}";
    const client = makeClient();

    const pending = mirrorBan("#kandyland", "spammer", client);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await handleModerationEvent(
      {
        action: "ban",
        broadcaster_user_login: "kandyland",
        moderator_user_login: "modname",
        moderator_user_name: "ModName",
        ban: { user_login: "spammer", reason: "rude" }
      },
      client,
      { botLogin: "kandybot" }
    );
    const result = await pending;

    expect(result.moderator).toBe("ModName");
    expect(client.banUser).toHaveBeenCalledWith("#kandylandvods", "spammer", "ModName: rude");
  });

  it("falls back to a generic moderator when no attribution arrives", async () => {
    const client = makeClient();
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
      targetChannels: ["kandylandvods", "kandyclips"],
      mirrorUnbans: true,
      announceInDiscord: false
    };
    hydrateTrackedBans([tracked("spammer")]);
  });

  it("unbans the user only in the targets the sync banned them in", async () => {
    const client = makeClient();
    const result = await mirrorUnban("#kandyland", "Spammer", client);
    expect(result.mirrored).toEqual(["kandylandvods"]);
    expect(client.unbanUser).toHaveBeenCalledTimes(1);
    expect(client.unbanUser).toHaveBeenCalledWith("#kandylandvods", "spammer");
    expect(botState.modActions[0]).toMatchObject({ action: "unban", moderator: "BanSync" });
  });

  it("leaves bans the sync did not place alone", async () => {
    const client = makeClient();
    const result = await mirrorUnban("#kandyland", "someoneelse", client);
    expect(result.mirrored).toEqual([]);
    expect(client.unbanUser).not.toHaveBeenCalled();
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

  it("names the moderator who lifted the source ban in Discord", async () => {
    botState.runtimeConfig.banSync.announceInDiscord = true;
    const discord = { id: "111", isTextBased: () => true, send: vi.fn(async () => ({})) };
    botState.discordChannels = [discord];

    await mirrorUnban("#kandyland", "spammer", makeClient(), { moderator: "ModName" });

    expect(discord.send.mock.calls[0][0]).toContain(
      "**spammer** was unbanned in #kandyland by ModName, also unbanned in #kandylandvods"
    );
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

  it("remembers a mirrored ban and persists it", async () => {
    await mirrorBan("#kandyland", "Spammer", makeClient());

    expect(getTrackedBans()).toEqual([
      expect.objectContaining({
        login: "spammer",
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

  it("keeps the entry when the mirrored unban failed so a later unban can retry", async () => {
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

describe("handleModerationEvent", () => {
  const event = (action, extra = {}) => ({
    action,
    broadcaster_user_login: "kandyland",
    moderator_user_login: "modname",
    moderator_user_name: "ModName",
    source_broadcaster_user_login: null,
    ...extra
  });

  beforeEach(() => {
    botState.runtimeConfig.banSync = {
      enabled: true,
      sourceChannel: "kandyland",
      targetChannels: ["kandylandvods"],
      mirrorUnbans: true,
      announceInDiscord: false
    };
    hydrateTrackedBans([tracked("spammer")]);
  });

  it("mirrors an unban done in Twitch chat", async () => {
    const client = makeClient();
    const result = await handleModerationEvent(
      event("unban", { unban: { user_login: "Spammer" } }),
      client,
      { botLogin: "kandybot" }
    );
    expect(result).toEqual({ action: "unban", handled: true });
    expect(client.unbanUser).toHaveBeenCalledWith("#kandylandvods", "spammer");
    expect(getTrackedBanCount()).toBe(0);
  });

  it("does not lift anything for an unban in a target channel", async () => {
    const client = makeClient();
    await handleModerationEvent(
      event("unban", { broadcaster_user_login: "kandylandvods", unban: { user_login: "spammer" } }),
      client
    );
    expect(client.unbanUser).not.toHaveBeenCalled();
  });

  it("does nothing on the second notice of an unban the bot already mirrored", async () => {
    const client = makeClient();
    await mirrorUnban("#kandyland", "spammer", client);
    await handleModerationEvent(
      event("unban", { moderator_user_login: "kandybot", unban: { user_login: "spammer" } }),
      client,
      { botLogin: "kandybot" }
    );
    expect(client.unbanUser).toHaveBeenCalledTimes(1);
  });

  it("remembers the Twitch moderator of a ban, but not the bot's own bans", async () => {
    await handleModerationEvent(
      event("ban", { ban: { user_login: "spammer", reason: "rude" } }),
      makeClient(),
      { botLogin: "kandybot" }
    );
    expect(takeBanAttribution("kandyland", "spammer")).toEqual({
      moderator: "ModName",
      reason: "rude"
    });

    noteBanAttribution("kandyland", "other", "Anton");
    await handleModerationEvent(
      event("ban", { moderator_user_login: "kandybot", ban: { user_login: "other" } }),
      makeClient(),
      { botLogin: "kandybot" }
    );
    expect(takeBanAttribution("kandyland", "other")).toMatchObject({ moderator: "Anton" });
  });

  it("ignores actions from another channel in a shared chat session and other actions", async () => {
    const client = makeClient();
    await handleModerationEvent(
      event("unban", {
        source_broadcaster_user_login: "otherchannel",
        unban: { user_login: "spammer" }
      }),
      client
    );
    expect(client.unbanUser).not.toHaveBeenCalled();
    expect(await handleModerationEvent(event("timeout"), client)).toEqual({
      action: "timeout",
      handled: false
    });
  });
});
