import { promises as fs } from "node:fs";
import { join } from "node:path";

const storeDir = join(process.cwd(), "data");
const storePath = join(storeDir, "config.json");

/**
 * Default configuration structure
 */
const DEFAULT_CONFIG = {
  filters: {
    blockCommands: null, // null means use env default
    blockEmotes: null,
    suspiciousFlagEnabled: null
  },
  subscriptionMessages: {
    sub: {
      enabled: null,
      message: "hype Welcome to Kandyland, {user}! kandyKiss"
    },
    resub: {
      enabled: null,
      message: "hype Welcome back to Kandyland, {user}! kandyKiss"
    },
    giftSub: {
      enabled: null,
      messageSingle: "Thank you for gifting to {recipient}, {user}! kandyHype",
      messageMultiple: "Thank you for gifting to {recipient_count} users, {user}! kandyHype"
    }
  },
  chatFeed: {
    ignoredUsers: [],
    retentionDays: 3,
    debug: false
  }
};

/**
 * Load configuration from storage
 * @returns {Promise<Object>} Configuration object
 */
async function loadConfig() {
  try {
    const data = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(data);
    // Merge with defaults to ensure all keys exist
    return mergeWithDefaults(parsed);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { ...DEFAULT_CONFIG };
    }
    throw error;
  }
}

/**
 * Save configuration to storage
 * @param {Object} config - Configuration object to save
 */
async function saveConfig(config) {
  await fs.mkdir(storeDir, { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(config, null, 2), "utf8");
}

/**
 * Update a specific section of the configuration
 * @param {string} section - Section name (e.g., 'filters', 'subscriptionMessages')
 * @param {Object} updates - Updates to apply to the section
 * @returns {Promise<Object>} Updated configuration
 */
async function updateConfigSection(section, updates) {
  const config = await loadConfig();

  if (!config[section]) {
    config[section] = {};
  }

  // Deep merge the updates
  config[section] = deepMerge(config[section], updates);

  await saveConfig(config);
  return config;
}

/**
 * Deep merge two objects
 * @param {Object} target - Target object
 * @param {Object} source - Source object
 * @returns {Object} Merged object
 */
function deepMerge(target, source) {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    if (source[key] !== null && typeof source[key] === "object" && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

/**
 * Merge loaded config with defaults to ensure all keys exist
 * @param {Object} loaded - Loaded configuration
 * @returns {Object} Merged configuration
 */
function mergeWithDefaults(loaded) {
  return deepMerge(DEFAULT_CONFIG, loaded);
}

/**
 * Get the default configuration
 * @returns {Object} Default configuration
 */
function getDefaults() {
  return { ...DEFAULT_CONFIG };
}

export {
  loadConfig,
  saveConfig,
  updateConfigSection,
  getDefaults,
  DEFAULT_CONFIG
};
