import "dotenv/config";
import { REST, Routes, SlashCommandBuilder } from "discord.js";

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID, ADMIN_ROLE_ID, MOD_ROLE_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !DISCORD_GUILD_ID) {
  throw new Error("Missing DISCORD_TOKEN, DISCORD_CLIENT_ID, or DISCORD_GUILD_ID");
}

const command = new SlashCommandBuilder()
  .setName("klb")
  .setDescription("Kandy Chat commands")
  .setDefaultMemberPermissions("0")
  .addSubcommand((sub) =>
    sub
      .setName("addblacklist")
      .setDescription("Add a word to the blacklist")
      .addStringOption((option) =>
        option
          .setName("word")
          .setDescription("Word to add")
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("removeblacklist")
      .setDescription("Remove a word from the blacklist")
      .addStringOption((option) =>
        option
          .setName("word")
          .setDescription("Word to remove")
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("listblacklist")
      .setDescription("List blacklist words")
  )
  .addSubcommand((sub) =>
    sub
      .setName("restart")
      .setDescription("Restart the bot (admin only)")
  );

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
const guildIds = DISCORD_GUILD_ID.split(",").map((id) => id.trim()).filter(Boolean);

if (!guildIds.length) {
  throw new Error("DISCORD_GUILD_ID must include at least one guild id");
}

for (const guildId of guildIds) {
  await rest.put(
    Routes.applicationGuildCommands(DISCORD_CLIENT_ID, guildId),
    { body: [command.toJSON()] }
  );
  console.log(`Slash commands deployed to guild ${guildId}`);
}
