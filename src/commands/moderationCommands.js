import { MessageFlags } from "discord.js";
import { validateUsername } from "../utils/validation.js";

/**
 * Handle /klb warn command
 */
export async function handleWarn(interaction, { twitchAPIClient, TWITCH_CHANNEL }) {
  const username = interaction.options.getString("username", true).trim();
  const reason = interaction.options.getString("reason") || "Violating community guidelines";

  if (!validateUsername(username)) {
    await interaction.reply({
      content: "Invalid username format.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    await twitchAPIClient.warnUser(TWITCH_CHANNEL, username, reason);
    await interaction.editReply({
      content: `Warned user **${username}** (Reason: ${reason})`,
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.error("Failed to warn user", error);
    await interaction.editReply({
      content: `Failed to warn user: ${error.message}`,
      flags: MessageFlags.Ephemeral
    });
  }
}

/**
 * Handle /klb restart command
 */
export async function handleRestart(interaction) {
  await interaction.reply({
    content: "Restarting bot... (Docker will automatically restart the container)",
    flags: MessageFlags.Ephemeral
  });

  setTimeout(() => {
    console.log("Restart command received, exiting process...");
    process.exit(0);
  }, 1000);
}

/**
 * Handle /klb stop command
 */
export async function handleStop(interaction) {
  await interaction.reply({
    content: "Stopping bot... (Container will stop but not restart automatically)",
    flags: MessageFlags.Ephemeral
  });

  setTimeout(() => {
    console.log("Stop command received, exiting process with error code...");
    process.exit(1);
  }, 1000);
}
