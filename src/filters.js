import { parseBool } from "./envUtils.js";

function parseList(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeMessage(message) {
  return message.replace(/\s+/g, " ").trim();
}

function isEmoteOnly(message, emotes) {
  if (!emotes) return false;
  const emoteRanges = Object.values(emotes).flat();
  if (emoteRanges.length === 0) return false;

  const emoteSpans = emoteRanges.map((range) => {
    const [start, end] = range.split("-").map(Number);
    return [start, end];
  });

  const stripped = message
    .split("")
    .map((char, index) => {
      const isEmoteChar = emoteSpans.some(([start, end]) => index >= start && index <= end);
      return isEmoteChar ? "" : char;
    })
    .join("")
    .trim();

  return stripped.length === 0;
}

function buildFilters(env) {
  return {
    blockCommands: parseBool(env.FILTER_BLOCK_COMMANDS, true),
    blockEmotes: parseBool(env.FILTER_BLOCK_EMOTES, false),
    blockedWords: parseList(env.FILTER_BLOCKED_WORDS),
    blockedRegexes: [],
    onlyBlockedWords: parseBool(env.FILTER_ONLY_BLOCKED_WORDS, false),
    allowedUsers: parseList(env.FILTER_ALLOWED_USERS).map((user) => user.toLowerCase()),
    blockedUsers: parseList(env.FILTER_BLOCKED_USERS).map((user) => user.toLowerCase())
  };
}

function shouldBlockMessage({ username, message, rawMessage, tags, filters }) {
  const lowerUser = username.toLowerCase();
  if (filters.allowedUsers.length && !filters.allowedUsers.includes(lowerUser)) {
    return true;
  }

  if (filters.blockedUsers.includes(lowerUser)) {
    return true;
  }

  if (filters.blockCommands && message.startsWith("!")) {
    return true;
  }

  if (filters.blockEmotes && isEmoteOnly(rawMessage, tags?.emotes)) {
    return true;
  }

  const regexMatches = (regex) => {
    if (regex.global || regex.sticky) {
      regex.lastIndex = 0;
    }
    return regex.test(message);
  };

  const lowerMessage = message.toLowerCase();
  const wordHit = filters.blockedWords.length
    ? filters.blockedWords.some((word) => word && lowerMessage.includes(word.toLowerCase()))
    : false;
  const regexHit = filters.blockedRegexes?.length
    ? filters.blockedRegexes.some((regex) => regexMatches(regex))
    : false;
  const hit = wordHit || regexHit;

  if (filters.onlyBlockedWords && (filters.blockedWords.length || filters.blockedRegexes?.length)) {
    if (!hit) return true;
  }
  return false;
}

export { buildFilters, normalizeMessage, shouldBlockMessage };
