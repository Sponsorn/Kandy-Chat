import { PermissionsBitField } from "discord.js";

/**
 * Check if a Discord member has privileged role (admin or mod)
 * @param {GuildMember} member - Discord guild member
 * @returns {boolean} True if member has admin or mod role
 */
export function hasPrivilegedRole(member) {
  const adminRoleAllowed =
    process.env.ADMIN_ROLE_ID &&
    process.env.ADMIN_ROLE_ID.split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .some((id) => member?.roles?.cache?.has(id));

  const modRoleAllowed =
    process.env.MOD_ROLE_ID &&
    process.env.MOD_ROLE_ID.split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .some((id) => member?.roles?.cache?.has(id));

  const isAdmin = member?.permissions?.has(
    PermissionsBitField.Flags.Administrator
  );

  return Boolean(adminRoleAllowed || modRoleAllowed || isAdmin);
}

/**
 * Check if a Discord member has admin role
 * @param {GuildMember} member - Discord guild member
 * @returns {boolean} True if member has admin role
 */
export function hasAdminRole(member) {
  const adminRoleAllowed =
    process.env.ADMIN_ROLE_ID &&
    process.env.ADMIN_ROLE_ID.split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .some((id) => member?.roles?.cache?.has(id));

  const isAdmin = member?.permissions?.has(
    PermissionsBitField.Flags.Administrator
  );

  return Boolean(adminRoleAllowed || isAdmin);
}
