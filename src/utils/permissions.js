import { PermissionsBitField } from "discord.js";

// Parse role IDs once at module level
export const ADMIN_ROLE_IDS = (process.env.ADMIN_ROLE_ID || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
export const MOD_ROLE_IDS = (process.env.MOD_ROLE_ID || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

/**
 * Check if a Discord member has privileged role (admin or mod)
 * @param {GuildMember} member - Discord guild member
 * @returns {boolean} True if member has admin or mod role
 */
export function hasPrivilegedRole(member) {
  const adminRoleAllowed =
    ADMIN_ROLE_IDS.length > 0 && ADMIN_ROLE_IDS.some((id) => member?.roles?.cache?.has(id));

  const modRoleAllowed =
    MOD_ROLE_IDS.length > 0 && MOD_ROLE_IDS.some((id) => member?.roles?.cache?.has(id));

  const isAdmin = member?.permissions?.has(PermissionsBitField.Flags.Administrator);

  return Boolean(adminRoleAllowed || modRoleAllowed || isAdmin);
}

/**
 * Check if a Discord member has admin role
 * @param {GuildMember} member - Discord guild member
 * @returns {boolean} True if member has admin role
 */
export function hasAdminRole(member) {
  const adminRoleAllowed =
    ADMIN_ROLE_IDS.length > 0 && ADMIN_ROLE_IDS.some((id) => member?.roles?.cache?.has(id));

  const isAdmin = member?.permissions?.has(PermissionsBitField.Flags.Administrator);

  return Boolean(adminRoleAllowed || isAdmin);
}
