export function parseBool(value, fallback = false) {
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

export function parseIntEnv(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
