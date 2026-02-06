import { MessageFlags } from "discord.js";
import { hasPrivilegedRole, hasAdminRole } from "../utils/permissions.js";
import { checkRateLimit } from "../utils/rateLimit.js";
import {
  handleAddBlacklist,
  handleRemoveBlacklist,
  handleListBlacklist,
  handleImportBlacklist,
  handleExportBlacklist
} from "./blacklistCommands.js";
import { handleWarn, handleRestart, handleStop } from "./moderationCommands.js";

/**
 * Command registry - maps subcommand names to handlers
 */
const commands = {
  addblacklist: { handler: handleAddBlacklist, requiresPrivilege: true },
  removeblacklist: { handler: handleRemoveBlacklist, requiresPrivilege: true },
  listblacklist: { handler: handleListBlacklist, requiresPrivilege: true },
  importblacklist: { handler: handleImportBlacklist, requiresAdmin: true },
  exportblacklist: { handler: handleExportBlacklist, requiresAdmin: true },
  warn: { handler: handleWarn, requiresPrivilege: true },
  restart: { handler: handleRestart, requiresAdmin: true },
  stop: { handler: handleStop, requiresAdmin: true }
};

/**
 * Handle /klb slash command interactions
 * @param {CommandInteraction} interaction - Discord interaction
 * @param {Object} dependencies - Injected dependencies
 */
export async function handleSlashCommand(interaction, dependencies) {
  // Rate limiting - prevent command spam
  if (!checkRateLimit(interaction.user.id)) {
    await interaction.reply({
      content: "You're doing that too fast. Please wait a moment.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  const commandConfig = commands[subcommand];

  if (!commandConfig) {
    await interaction.reply({
      content: "Unknown command.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // Check permissions
  if (commandConfig.requiresAdmin) {
    if (!hasAdminRole(interaction.member)) {
      await interaction.reply({
        content: "This command requires admin permissions.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
  } else if (commandConfig.requiresPrivilege) {
    if (!hasPrivilegedRole(interaction.member)) {
      await interaction.reply({
        content: "You do not have permission to use this command.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
  }

  // Execute command handler with dependencies
  await commandConfig.handler(interaction, dependencies);
}
