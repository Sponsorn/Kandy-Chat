/**
 * Configuration validation with helpful error messages
 * Validates all environment variables at startup
 */

const ERRORS = [];
const WARNINGS = [];

/**
 * Check if a value is defined and non-empty
 */
function isDefined(value) {
  return value !== undefined && value !== null && value !== "";
}

/**
 * Validate required string
 */
function requireString(env, key, description) {
  if (!isDefined(env[key])) {
    ERRORS.push(`Missing required ${description}: ${key}`);
    return false;
  }
  return true;
}

/**
 * Validate optional number
 */
function validateNumber(env, key, description, { min, max, fallback } = {}) {
  if (!isDefined(env[key])) return true;

  const value = parseInt(env[key], 10);
  if (isNaN(value)) {
    ERRORS.push(`Invalid ${description} (${key}): must be a number, got "${env[key]}"`);
    return false;
  }

  if (min !== undefined && value < min) {
    ERRORS.push(`Invalid ${description} (${key}): must be at least ${min}, got ${value}`);
    return false;
  }

  if (max !== undefined && value > max) {
    ERRORS.push(`Invalid ${description} (${key}): must be at most ${max}, got ${value}`);
    return false;
  }

  return true;
}

/**
 * Validate channel mapping format
 */
function validateChannelMapping(env) {
  const mapping = env.TWITCH_CHANNEL_MAPPING;
  if (!isDefined(mapping)) return true;

  const pairs = mapping.split(",");
  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(":");
    if (parts.length !== 2) {
      ERRORS.push(
        `Invalid TWITCH_CHANNEL_MAPPING entry: "${trimmed}"\n` +
          `  Expected format: twitchChannel:discordChannelId\n` +
          `  Example: kandyland:1234567890123456789`
      );
      return false;
    }

    const [twitchCh, discordCh] = parts.map((s) => s.trim());
    if (!twitchCh) {
      ERRORS.push(`Invalid TWITCH_CHANNEL_MAPPING: missing Twitch channel in "${trimmed}"`);
      return false;
    }
    if (!discordCh) {
      ERRORS.push(`Invalid TWITCH_CHANNEL_MAPPING: missing Discord channel ID in "${trimmed}"`);
      return false;
    }

    // Discord channel IDs are snowflakes (17-20 digit numbers)
    if (!/^\d{17,20}$/.test(discordCh)) {
      ERRORS.push(
        `Invalid Discord channel ID in TWITCH_CHANNEL_MAPPING: "${discordCh}"\n` +
          `  Discord channel IDs should be 17-20 digit numbers`
      );
      return false;
    }
  }

  return true;
}

/**
 * Validate OAuth token format
 */
function validateOAuthToken(env) {
  const token = env.TWITCH_OAUTH;
  if (!isDefined(token)) return true;

  if (!token.startsWith("oauth:")) {
    WARNINGS.push(
      `TWITCH_OAUTH should start with "oauth:" prefix\n` +
        `  Current: "${token.substring(0, 10)}..."\n` +
        `  Expected: "oauth:xxxxx..."`
    );
  }

  return true;
}

/**
 * Validate Discord IDs format
 */
function validateDiscordId(env, key, description) {
  const value = env[key];
  if (!isDefined(value)) return true;

  // Support comma-separated IDs
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  for (const id of ids) {
    if (!/^\d{17,20}$/.test(id)) {
      ERRORS.push(
        `Invalid ${description} (${key}): "${id}"\n` + `  Discord IDs should be 17-20 digit numbers`
      );
      return false;
    }
  }

  return true;
}

/**
 * Validate authentication configuration
 */
function validateAuth(env) {
  const hasStaticOAuth = isDefined(env.TWITCH_OAUTH);
  const hasRefreshCredentials =
    isDefined(env.TWITCH_CLIENT_ID) &&
    isDefined(env.TWITCH_CLIENT_SECRET) &&
    isDefined(env.TWITCH_REFRESH_TOKEN);

  if (!hasStaticOAuth && !hasRefreshCredentials) {
    ERRORS.push(
      `Missing Twitch authentication. Provide one of:\n` +
        `  1. TWITCH_OAUTH - Static OAuth token\n` +
        `  2. TWITCH_CLIENT_ID + TWITCH_CLIENT_SECRET + TWITCH_REFRESH_TOKEN - Auto-refresh credentials`
    );
    return false;
  }

  if (hasStaticOAuth && hasRefreshCredentials) {
    WARNINGS.push(
      `Both TWITCH_OAUTH and refresh credentials provided.\n` +
        `  Auto-refresh credentials will be used when TWITCH_OAUTH expires.`
    );
  }

  return true;
}

/**
 * Validate EventSub configuration
 */
function validateEventSub(env) {
  if (env.EVENTSUB_ENABLED?.toLowerCase() !== "true") return true;

  if (!isDefined(env.EVENTSUB_SECRET)) {
    ERRORS.push("EVENTSUB_SECRET is required when EVENTSUB_ENABLED=true");
    return false;
  }

  if (env.EVENTSUB_SECRET.length < 10) {
    ERRORS.push("EVENTSUB_SECRET should be at least 10 characters for security");
    return false;
  }

  validateNumber(env, "EVENTSUB_PORT", "EventSub port", { min: 1, max: 65535 });

  return ERRORS.length === 0;
}

/**
 * Validate freeze monitor configuration
 */
function validateFreezeMonitor(env) {
  if (env.FREEZE_CHECK_ENABLED?.toLowerCase() !== "true") return true;

  const hasHlsUrl = isDefined(env.FREEZE_HLS_URL);
  const hasChannel = isDefined(env.FREEZE_CHANNEL);

  if (!hasHlsUrl && !hasChannel) {
    ERRORS.push(
      `Freeze monitor requires either:\n` +
        `  1. FREEZE_HLS_URL - Direct HLS stream URL\n` +
        `  2. FREEZE_CHANNEL - Twitch channel name (auto-fetches HLS URL)`
    );
    return false;
  }

  validateNumber(env, "FREEZE_SAMPLE_SECONDS", "freeze sample interval", { min: 1, max: 60 });
  validateNumber(env, "FREEZE_THRESHOLD_SECONDS", "freeze threshold", { min: 5, max: 300 });
  validateNumber(env, "FREEZE_OFFLINE_FAILS", "offline failure threshold", { min: 1, max: 20 });

  return ERRORS.length === 0;
}

/**
 * Main validation function
 * Call at startup to validate all configuration
 * @param {Object} env - Environment variables (usually process.env)
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateConfig(env) {
  // Clear previous errors/warnings
  ERRORS.length = 0;
  WARNINGS.length = 0;

  // Required Discord configuration
  requireString(env, "DISCORD_TOKEN", "Discord bot token");
  requireString(env, "DISCORD_CHANNEL_ID", "Discord channel ID");
  validateDiscordId(env, "DISCORD_CHANNEL_ID", "Discord channel ID");

  // Required Twitch configuration
  requireString(env, "TWITCH_USERNAME", "Twitch bot username");
  requireString(env, "TWITCH_CHANNEL", "Twitch channel(s)");

  // Authentication
  validateAuth(env);
  validateOAuthToken(env);

  // Optional Discord IDs
  validateDiscordId(env, "DISCORD_CLIENT_ID", "Discord client ID");
  validateDiscordId(env, "DISCORD_GUILD_ID", "Discord guild ID");
  validateDiscordId(env, "ADMIN_ROLE_ID", "admin role ID");
  validateDiscordId(env, "MOD_ROLE_ID", "moderator role ID");
  validateDiscordId(env, "FREEZE_ALERT_ROLE_ID", "freeze alert role ID");
  validateDiscordId(env, "STREAM_ALERT_ROLE_ID", "stream alert role ID");

  // Channel mapping
  validateChannelMapping(env);

  // Optional numbers
  validateNumber(env, "REACTION_TIMEOUT_SECONDS", "reaction timeout", { min: 1, max: 1209600 });
  validateNumber(env, "RAID_SUPPRESS_WINDOW_SECONDS", "raid suppress window", {
    min: 0,
    max: 3600
  });

  // Subsystems
  validateEventSub(env);
  validateFreezeMonitor(env);

  return {
    valid: ERRORS.length === 0,
    errors: [...ERRORS],
    warnings: [...WARNINGS]
  };
}

/**
 * Validate and fail fast if configuration is invalid
 * @param {Object} env - Environment variables
 * @throws {Error} If configuration is invalid
 */
export function validateConfigOrThrow(env) {
  const result = validateConfig(env);

  if (result.warnings.length > 0) {
    console.warn("Configuration warnings:");
    for (const warning of result.warnings) {
      console.warn(`  ⚠️  ${warning.replace(/\n/g, "\n      ")}`);
    }
  }

  if (!result.valid) {
    console.error("Configuration errors:");
    for (const error of result.errors) {
      console.error(`  ❌ ${error.replace(/\n/g, "\n      ")}`);
    }
    throw new Error(`Invalid configuration: ${result.errors.length} error(s) found`);
  }

  return result;
}
