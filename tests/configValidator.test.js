import { describe, it, expect } from "vitest";
import { validateConfig } from "../src/config/configValidator.js";

// Minimal valid config
function validEnv(overrides = {}) {
  return {
    DISCORD_TOKEN: "test-token",
    DISCORD_CHANNEL_ID: "12345678901234567",
    TWITCH_USERNAME: "testbot",
    TWITCH_CHANNEL: "testchannel",
    TWITCH_OAUTH: "oauth:abc123",
    ...overrides
  };
}

describe("validateConfig", () => {
  it("valid config passes", () => {
    const result = validateConfig(validEnv());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("detects missing DISCORD_TOKEN", () => {
    const result = validateConfig(validEnv({ DISCORD_TOKEN: "" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("DISCORD_TOKEN"))).toBe(true);
  });

  it("detects missing DISCORD_CHANNEL_ID", () => {
    const result = validateConfig(validEnv({ DISCORD_CHANNEL_ID: "" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("DISCORD_CHANNEL_ID"))).toBe(true);
  });

  it("detects missing TWITCH_USERNAME", () => {
    const result = validateConfig(validEnv({ TWITCH_USERNAME: "" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("TWITCH_USERNAME"))).toBe(true);
  });

  it("detects missing TWITCH_CHANNEL", () => {
    const result = validateConfig(validEnv({ TWITCH_CHANNEL: "" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("TWITCH_CHANNEL"))).toBe(true);
  });

  it("detects invalid Discord channel ID format", () => {
    const result = validateConfig(validEnv({ DISCORD_CHANNEL_ID: "not-a-number" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Discord") && e.includes("digit"))).toBe(true);
  });

  it("accepts valid comma-separated Discord IDs", () => {
    const result = validateConfig(
      validEnv({ ADMIN_ROLE_ID: "12345678901234567,98765432109876543" })
    );
    expect(result.valid).toBe(true);
  });

  it("rejects invalid admin role ID", () => {
    const result = validateConfig(validEnv({ ADMIN_ROLE_ID: "short" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("admin role ID"))).toBe(true);
  });

  describe("authentication validation", () => {
    it("accepts static OAuth token", () => {
      const result = validateConfig(validEnv());
      expect(result.valid).toBe(true);
    });

    it("accepts refresh credentials", () => {
      const result = validateConfig(
        validEnv({
          TWITCH_OAUTH: undefined,
          TWITCH_CLIENT_ID: "12345678901234567",
          TWITCH_CLIENT_SECRET: "secret",
          TWITCH_REFRESH_TOKEN: "refresh"
        })
      );
      expect(result.valid).toBe(true);
    });

    it("rejects missing both auth modes", () => {
      const result = validateConfig(
        validEnv({
          TWITCH_OAUTH: undefined,
          TWITCH_CLIENT_ID: undefined,
          TWITCH_CLIENT_SECRET: undefined,
          TWITCH_REFRESH_TOKEN: undefined
        })
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("authentication"))).toBe(true);
    });

    it("warns when both auth modes provided", () => {
      const result = validateConfig(
        validEnv({
          TWITCH_CLIENT_ID: "12345678901234567",
          TWITCH_CLIENT_SECRET: "secret",
          TWITCH_REFRESH_TOKEN: "refresh"
        })
      );
      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.includes("Both"))).toBe(true);
    });
  });

  describe("channel mapping validation", () => {
    it("accepts valid channel mapping", () => {
      const result = validateConfig(
        validEnv({ TWITCH_CHANNEL_MAPPING: "channel1:12345678901234567" })
      );
      expect(result.valid).toBe(true);
    });

    it("rejects invalid channel mapping format", () => {
      const result = validateConfig(validEnv({ TWITCH_CHANNEL_MAPPING: "invalid-no-colon" }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("TWITCH_CHANNEL_MAPPING"))).toBe(true);
    });

    it("rejects channel mapping with invalid Discord ID", () => {
      const result = validateConfig(validEnv({ TWITCH_CHANNEL_MAPPING: "channel1:abc" }));
      expect(result.valid).toBe(false);
    });
  });

  describe("EventSub validation", () => {
    it("skips when not enabled", () => {
      const result = validateConfig(validEnv());
      expect(result.valid).toBe(true);
    });

    it("requires secret when enabled", () => {
      const result = validateConfig(validEnv({ EVENTSUB_ENABLED: "true" }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("EVENTSUB_SECRET"))).toBe(true);
    });

    it("rejects short secret", () => {
      const result = validateConfig(
        validEnv({ EVENTSUB_ENABLED: "true", EVENTSUB_SECRET: "short" })
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("10 characters"))).toBe(true);
    });

    it("accepts valid EventSub config", () => {
      const result = validateConfig(
        validEnv({ EVENTSUB_ENABLED: "true", EVENTSUB_SECRET: "a-long-enough-secret" })
      );
      expect(result.valid).toBe(true);
    });
  });

  describe("freeze monitor validation", () => {
    it("skips when not enabled", () => {
      const result = validateConfig(validEnv());
      expect(result.valid).toBe(true);
    });

    it("requires HLS URL or channel when enabled", () => {
      const result = validateConfig(validEnv({ FREEZE_CHECK_ENABLED: "true" }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Freeze monitor"))).toBe(true);
    });

    it("accepts with FREEZE_CHANNEL", () => {
      const result = validateConfig(
        validEnv({ FREEZE_CHECK_ENABLED: "true", FREEZE_CHANNEL: "testchannel" })
      );
      expect(result.valid).toBe(true);
    });

    it("accepts with FREEZE_HLS_URL", () => {
      const result = validateConfig(
        validEnv({
          FREEZE_CHECK_ENABLED: "true",
          FREEZE_HLS_URL: "https://example.com/stream.m3u8"
        })
      );
      expect(result.valid).toBe(true);
    });
  });
});
