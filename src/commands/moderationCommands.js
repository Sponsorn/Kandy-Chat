import { MessageFlags } from "discord.js";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validateUsername } from "../utils/validation.js";

const STOP_FLAG_PATH = join(process.cwd(), "data", ".stopped");

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
  // Remove stop flag if it exists so bot can start
  try {
    if (existsSync(STOP_FLAG_PATH)) {
      unlinkSync(STOP_FLAG_PATH);
    }
  } catch (error) {
    console.warn("Failed to remove stop flag:", error.message);
  }

  await interaction.reply({
    content: "Restarting bot... (Docker will automatically restart the container)",
    flags: MessageFlags.Ephemeral
  });

  setTimeout(() => {
    console.log("Restart command received, exiting process...");
    process.exit(1);
  }, 1000);
}

/**
 * Handle /klb stop command
 */
export async function handleStop(interaction) {
  // Write stop flag to prevent restart
  try {
    writeFileSync(STOP_FLAG_PATH, new Date().toISOString(), "utf8");
  } catch (error) {
    console.error("Failed to write stop flag:", error.message);
    await interaction.reply({
      content: "Failed to write stop flag. Bot may restart automatically.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.reply({
    content: "Stopping bot... Use `/klb restart` to start it again.",
    flags: MessageFlags.Ephemeral
  });

  setTimeout(() => {
    console.log("Stop command received, exiting process...");
    process.exit(0);
  }, 1000);
}
