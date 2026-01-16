/**
 * Validate Twitch channel name
 * @param {string} name - Channel name to validate
 * @returns {boolean} True if valid
 */
export function validateChannelName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.length > 25) return false;
  return /^#?[a-zA-Z0-9_]+$/.test(name);
}

/**
 * Validate Twitch message ID
 * @param {string} id - Message ID to validate
 * @returns {boolean} True if valid
 */
export function validateMessageId(id) {
  if (!id || typeof id !== 'string') return false;
  // Twitch message IDs are UUIDs with hyphens
  return /^[a-f0-9-]+$/i.test(id);
}

/**
 * Validate Twitch username
 * @param {string} username - Username to validate
 * @returns {boolean} True if valid
 */
export function validateUsername(username) {
  if (!username || typeof username !== 'string') return false;
  if (username.length > 25 || username.length < 1) return false;
  return /^[a-zA-Z0-9_]+$/.test(username);
}

/**
 * Validate Discord snowflake ID
 * @param {string} id - Discord ID to validate
 * @returns {boolean} True if valid
 */
export function validateDiscordId(id) {
  if (!id || typeof id !== 'string') return false;
  return /^\d+$/.test(id);
}
