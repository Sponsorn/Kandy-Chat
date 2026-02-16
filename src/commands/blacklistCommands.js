import {
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  AttachmentBuilder
} from "discord.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { addBlacklistWord, loadBlacklist, removeBlacklistWord } from "../blacklistStore.js";

/**
 * Handle /klb addblacklist command
 */
export async function handleAddBlacklist(
  interaction,
  { updateBlacklistFromEntries, relaySystemMessage }
) {
  const word = interaction.options.getString("word", true).trim();
  if (!word) {
    await interaction.reply({
      content: "Word cannot be empty.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const result = await addBlacklistWord(word);
  if (result.added) {
    updateBlacklistFromEntries(result.words);
    await interaction.reply({
      content: `Added blacklist word: \`${word}\``,
      flags: MessageFlags.Ephemeral
    });
    relaySystemMessage(`${interaction.user.username} added ${word} to blacklist`).catch((error) => {
      console.error("Failed to send blacklist update message", error);
    });
  } else {
    await interaction.reply({
      content: `Word already in blacklist: \`${word}\``,
      flags: MessageFlags.Ephemeral
    });
  }
}

/**
 * Handle /klb removeblacklist command
 */
export async function handleRemoveBlacklist(
  interaction,
  { updateBlacklistFromEntries, relaySystemMessage }
) {
  const word = interaction.options.getString("word", true).trim();
  if (!word) {
    await interaction.reply({
      content: "Word cannot be empty.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const result = await removeBlacklistWord(word);
  if (result.removed) {
    updateBlacklistFromEntries(result.words);
    await interaction.reply({
      content: `Removed blacklist word: \`${word}\``,
      flags: MessageFlags.Ephemeral
    });
    relaySystemMessage(`${interaction.user.username} removed ${word} from blacklist`).catch(
      (error) => {
        console.error("Failed to send blacklist update message", error);
      }
    );
  } else {
    await interaction.reply({
      content: `Word not found: \`${word}\``,
      flags: MessageFlags.Ephemeral
    });
  }
}

/**
 * Handle /klb listblacklist command
 */
export async function handleListBlacklist(interaction, { parseRegexEntry }) {
  const words = await loadBlacklist();
  if (!words.length) {
    await interaction.reply({
      content: "Blacklist is empty.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const plain = [];
  const regexes = [];
  for (const entry of words) {
    if (parseRegexEntry(entry)) {
      regexes.push(entry);
    } else {
      plain.push(entry);
    }
  }

  // Create pages with 25 words per page
  const createPages = (items, type) => {
    const pages = [];
    const itemsPerPage = 25;

    for (let i = 0; i < items.length; i += itemsPerPage) {
      const pageItems = items.slice(i, i + itemsPerPage);
      pages.push({
        type,
        content: pageItems.join("\n")
      });
    }
    return pages;
  };

  const allPages = [...createPages(plain, "Words"), ...createPages(regexes, "Regex")];

  if (allPages.length === 0) {
    await interaction.reply({
      content: "Blacklist is empty.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  let currentPageIndex = 0;

  const generateEmbed = (pageIndex) => {
    const page = allPages[pageIndex];
    const embed = new EmbedBuilder()
      .setTitle(`Blacklist - ${page.type}`)
      .setDescription(`\`\`\`\n${page.content}\n\`\`\``)
      .setColor(0x5865f2)
      .setFooter({
        text: `Page ${pageIndex + 1} of ${allPages.length} • Total: ${plain.length} words, ${regexes.length} regex`
      });
    return embed;
  };

  const generateButtons = (pageIndex) => {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("prev")
        .setLabel("Previous")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(pageIndex === 0),
      new ButtonBuilder()
        .setCustomId("next")
        .setLabel("Next")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(pageIndex === allPages.length - 1),
      new ButtonBuilder()
        .setCustomId("download")
        .setLabel("Download as .txt")
        .setStyle(ButtonStyle.Secondary)
    );
    return row;
  };

  const response = await interaction.reply({
    embeds: [generateEmbed(currentPageIndex)],
    components: [generateButtons(currentPageIndex)],
    flags: MessageFlags.Ephemeral
  });

  const collector = response.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 300000 // 5 minutes
  });

  collector.on("collect", async (i) => {
    if (i.user.id !== interaction.user.id) {
      await i.reply({
        content: "These buttons aren't for you!",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (i.customId === "prev") {
      currentPageIndex = Math.max(0, currentPageIndex - 1);
      await i.update({
        embeds: [generateEmbed(currentPageIndex)],
        components: [generateButtons(currentPageIndex)]
      });
    } else if (i.customId === "next") {
      currentPageIndex = Math.min(allPages.length - 1, currentPageIndex + 1);
      await i.update({
        embeds: [generateEmbed(currentPageIndex)],
        components: [generateButtons(currentPageIndex)]
      });
    } else if (i.customId === "download") {
      // Create text file content
      let fileContent = "";
      if (plain.length > 0) {
        fileContent += "=== Plain Words ===\n" + plain.join("\n") + "\n\n";
      }
      if (regexes.length > 0) {
        fileContent += "=== Regex Patterns ===\n" + regexes.join("\n");
      }

      const attachment = new AttachmentBuilder(Buffer.from(fileContent, "utf-8"), {
        name: "blacklist.txt"
      });

      await i.reply({
        content: "Here's your blacklist file:",
        files: [attachment],
        flags: MessageFlags.Ephemeral
      });
    }
  });

  collector.on("end", () => {
    response
      .edit({
        components: []
      })
      .catch(() => {});
  });
}

/**
 * Handle /klb importblacklist command
 */
export async function handleImportBlacklist(
  interaction,
  { twitchAPIClient, updateBlacklistFromEntries, relaySystemMessage }
) {
  const channel = interaction.options.getString("channel", true).trim();
  if (!channel) {
    await interaction.reply({
      content: "Channel name cannot be empty.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const termObjects = await twitchAPIClient.getBlockedTerms(channel);

    if (!termObjects.length) {
      await interaction.editReply({
        content: `No blocked terms found in channel: ${channel}`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    // Save metadata to separate file
    const metadataPath = join(process.cwd(), "data", "blacklist-metadata.json");
    await fs.writeFile(metadataPath, JSON.stringify(termObjects, null, 2), "utf8");

    // Get current blacklist
    const currentWords = await loadBlacklist();
    const currentSet = new Set(currentWords);

    // Add new terms (text only)
    let addedCount = 0;
    for (const termObj of termObjects) {
      const text = termObj.text;
      if (!currentSet.has(text)) {
        await addBlacklistWord(text);
        addedCount++;
      }
    }

    // Reload and update filters
    const updatedWords = await loadBlacklist();
    updateBlacklistFromEntries(updatedWords);

    // Count terms with expiry
    const withExpiry = termObjects.filter((t) => t.expires_at !== null).length;

    await interaction.editReply({
      content: `Imported ${addedCount} new terms from **${channel}** (${termObjects.length} total found, ${termObjects.length - addedCount} already in blacklist${withExpiry > 0 ? `, ${withExpiry} have expiry dates` : ""})`,
      flags: MessageFlags.Ephemeral
    });

    if (addedCount > 0) {
      relaySystemMessage(
        `${interaction.user.username} imported ${addedCount} blocked terms from ${channel}`
      ).catch((error) => {
        console.error("Failed to send import message", error);
      });
    }
  } catch (error) {
    console.error("Failed to import blocked terms", error);
    await interaction.editReply({
      content: `Failed to import blocked terms: ${error.message}`,
      flags: MessageFlags.Ephemeral
    });
  }
}

/**
 * Handle /klb exportblacklist command
 */
export async function handleExportBlacklist(interaction, { twitchAPIClient, relaySystemMessage }) {
  const channel = interaction.options.getString("channel", true).trim();
  if (!channel) {
    await interaction.reply({
      content: "Channel name cannot be empty.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const words = await loadBlacklist();
    if (!words.length) {
      await interaction.editReply({
        content: "Local blacklist is empty - nothing to export.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    let addedCount = 0;
    const errors = [];

    for (const word of words) {
      try {
        await twitchAPIClient.addBlockedTerm(channel, word);
        addedCount++;
      } catch (error) {
        console.error(`Failed to add "${word}" to ${channel}`, error);
        errors.push(`${word}: ${error.message}`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    let message = `Exported ${addedCount} of ${words.length} blacklist words to channel **${channel}**`;
    if (errors.length > 0) {
      message += `\n\nErrors (${errors.length}):\n${errors.slice(0, 5).join("\n")}`;
      if (errors.length > 5) {
        message += `\n... and ${errors.length - 5} more`;
      }
    }

    await interaction.editReply({
      content: message,
      flags: MessageFlags.Ephemeral
    });

    if (addedCount > 0) {
      relaySystemMessage(
        `${interaction.user.username} exported ${addedCount} blocked terms to ${channel}`
      ).catch((error) => {
        console.error("Failed to send export message", error);
      });
    }
  } catch (error) {
    console.error("Failed to export blacklist", error);
    await interaction.editReply({
      content: `Failed to export blacklist: ${error.message}`,
      flags: MessageFlags.Ephemeral
    });
  }
}
