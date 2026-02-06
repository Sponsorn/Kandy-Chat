/**
 * Simple rate limiter for slash commands
 */
const rateLimits = new Map();

/**
 * Check if user has exceeded rate limit
 * @param {string} userId - Discord user ID
 * @param {number} limit - Max requests per window (default 5)
 * @param {number} windowMs - Time window in milliseconds (default 60000)
 * @returns {boolean} True if request is allowed
 */
export function checkRateLimit(userId, limit = 5, windowMs = 60000) {
  const now = Date.now();
  const userRequests = rateLimits.get(userId) || [];

  // Filter to only recent requests
  const recentRequests = userRequests.filter((timestamp) => now - timestamp < windowMs);

  if (recentRequests.length >= limit) {
    return false; // Rate limit exceeded
  }

  // Add current request
  recentRequests.push(now);
  rateLimits.set(userId, recentRequests);

  return true; // Request allowed
}

/**
 * Clean up old rate limit entries (call periodically)
 */
export function cleanupRateLimits(windowMs = 60000) {
  const now = Date.now();
  let cleaned = 0;

  for (const [userId, timestamps] of rateLimits.entries()) {
    const recent = timestamps.filter((t) => now - t < windowMs);
    if (recent.length === 0) {
      rateLimits.delete(userId);
      cleaned++;
    } else {
      rateLimits.set(userId, recent);
    }
  }

  return cleaned;
}

// Auto-cleanup every 5 minutes
setInterval(() => cleanupRateLimits(), 5 * 60 * 1000);
