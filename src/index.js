import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  AttachmentBuilder
} from "discord.js";
import tmi from "tmi.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  buildFilters,
  normalizeMessage,
  shouldBlockMessage
} from "./filters.js";
import { startFreezeMonitor } from "./freezeMonitor.js";
import { refreshTwitchToken } from "./twitchAuth.js";
import { startEventSubServer } from "./eventsubServer.js";
import {
  addBlacklistWord,
  loadBlacklist,
  removeBlacklistWord
} from "./blacklistStore.js";

const {
  DISCORD_TOKEN,
  DISCORD_CHANNEL_ID,
  TWITCH_USERNAME,
  TWITCH_OAUTH,
  TWITCH_CHANNEL,
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_REFRESH_TOKEN,
  TWITCH_CHANNEL_MAPPING,
  FREEZE_ALERT_ROLE_ID,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,
  SUSPICIOUS_FLAG_ENABLED,
  REACTION_DELETE_EMOJI,
  REACTION_TIMEOUT_EMOJI,
  REACTION_BAN_EMOJI,
  REACTION_WARN_EMOJI,
  REACTION_TIMEOUT_SECONDS,
  SUB_THANK_YOU_ENABLED,
  RESUB_THANK_YOU_ENABLED,
  GIFT_SUB_THANK_YOU_ENABLED
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_CHANNEL_ID) {
  throw new Error("Missing DISCORD_TOKEN or DISCORD_CHANNEL_ID in environment");
}

if (!TWITCH_USERNAME || !TWITCH_CHANNEL) {
  throw new Error("Missing TWITCH_USERNAME or TWITCH_CHANNEL in environment");
}

if (!TWITCH_OAUTH && !(TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET && TWITCH_REFRESH_TOKEN)) {
  throw new Error("Missing TWITCH_OAUTH or refresh credentials in environment");
}

const filters = buildFilters(process.env);
const baseBlockedWords = [...filters.blockedWords];
const blacklistRegexMap = new Map();
const BOT_START_TIME = Date.now();

// Parse Twitch channels (comma-separated)
const TWITCH_CHANNELS = TWITCH_CHANNEL.split(",").map((ch) => ch.trim().toLowerCase()).filter(Boolean);

// Parse channel mapping (format: twitchChannel1:discordChannelId1,twitchChannel2:discordChannelId2)
// If no mapping provided, all Twitch channels relay to all Discord channels
const channelMapping = new Map();
if (TWITCH_CHANNEL_MAPPING) {
  TWITCH_CHANNEL_MAPPING.split(",").forEach((mapping) => {
    const [twitchCh, discordCh] = mapping.split(":").map((s) => s.trim());
    if (twitchCh && discordCh) {
      channelMapping.set(twitchCh.toLowerCase(), discordCh);
    }
  });
}

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User]
});

let twitchClient = null;
let currentRefreshToken = TWITCH_REFRESH_TOKEN;
let freezeAuthManaged = false;
const relayMessageMap = new Map();
const relayDiscordMap = new Map();
const RELAY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

async function deleteTwitchMessageViaAPI(channelName, messageId) {
  if (!TWITCH_CLIENT_ID || !currentRefreshToken) {
    throw new Error("Missing Twitch credentials");
  }

  // Get fresh access token
  const tokenInfo = await refreshAndApplyTwitchToken();
  const accessToken = tokenInfo?.oauthToken?.replace("oauth:", "") ?? process.env.TWITCH_OAUTH?.replace("oauth:", "");

  if (!accessToken) {
    throw new Error("No Twitch access token available");
  }

  // Get broadcaster user ID
  const broadcasterResponse = await fetch(
    `https://api.twitch.tv/helix/users?login=${channelName.replace("#", "")}`,
    {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Client-Id": TWITCH_CLIENT_ID
      }
    }
  );

  if (!broadcasterResponse.ok) {
    throw new Error(`Failed to get broadcaster ID: ${broadcasterResponse.status}`);
  }

  const broadcasterData = await broadcasterResponse.json();
  const broadcasterId = broadcasterData.data?.[0]?.id;

  if (!broadcasterId) {
    throw new Error("Broadcaster not found");
  }

  // Get moderator user ID (the bot itself)
  const modResponse = await fetch(
    `https://api.twitch.tv/helix/users?login=${TWITCH_USERNAME}`,
    {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Client-Id": TWITCH_CLIENT_ID
      }
    }
  );

  if (!modResponse.ok) {
    throw new Error(`Failed to get moderator ID: ${modResponse.status}`);
  }

  const modData = await modResponse.json();
  const moderatorId = modData.data?.[0]?.id;

  if (!moderatorId) {
    throw new Error("Moderator user not found");
  }

  // Delete the message using Helix API
  const deleteResponse = await fetch(
    `https://api.twitch.tv/helix/moderation/chat?broadcaster_id=${broadcasterId}&moderator_id=${moderatorId}&message_id=${messageId}`,
    {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Client-Id": TWITCH_CLIENT_ID
      }
    }
  );

  if (!deleteResponse.ok) {
    const errorText = await deleteResponse.text();
    throw new Error(`Failed to delete message: ${deleteResponse.status} - ${errorText}`);
  }
}

async function fetchBlockedTermsFromChannel(channelLogin) {
  if (!TWITCH_CLIENT_ID || !currentRefreshToken) {
    throw new Error("Missing Twitch credentials");
  }

  // Get fresh access token
  const tokenInfo = await refreshAndApplyTwitchToken();
  const accessToken = tokenInfo?.oauthToken?.replace("oauth:", "") ?? process.env.TWITCH_OAUTH?.replace("oauth:", "");

  if (!accessToken) {
    throw new Error("No Twitch access token available");
  }

  // Get broadcaster user ID
  const broadcasterResponse = await fetch(
    `https://api.twitch.tv/helix/users?login=${channelLogin}`,
    {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Client-Id": TWITCH_CLIENT_ID
      }
    }
  );

  if (!broadcasterResponse.ok) {
    throw new Error(`Failed to get broadcaster ID: ${broadcasterResponse.status}`);
  }

  const broadcasterData = await broadcasterResponse.json();
  const broadcasterId = broadcasterData.data?.[0]?.id;

  if (!broadcasterId) {
    throw new Error("Broadcaster not found");
  }

  // Get moderator user ID (the bot itself)
  const modResponse = await fetch(
    `https://api.twitch.tv/helix/users?login=${TWITCH_USERNAME}`,
    {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Client-Id": TWITCH_CLIENT_ID
      }
    }
  );

  if (!modResponse.ok) {
    throw new Error(`Failed to get moderator ID: ${modResponse.status}`);
  }

  const modData = await modResponse.json();
  const moderatorId = modData.data?.[0]?.id;

  if (!moderatorId) {
    throw new Error("Moderator user not found");
  }

  // Fetch blocked terms with pagination
  const allTerms = [];
  let cursor = null;

  do {
    const url = new URL("https://api.twitch.tv/helix/moderation/blocked_terms");
    url.searchParams.append("broadcaster_id", broadcasterId);
    url.searchParams.append("moderator_id", moderatorId);
    url.searchParams.append("first", "100");
    if (cursor) {
      url.searchParams.append("after", cursor);
    }

    const response = await fetch(url.toString(), {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Client-Id": TWITCH_CLIENT_ID
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch blocked terms: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    allTerms.push(...(data.data || []));
    cursor = data.pagination?.cursor || null;
  } while (cursor);

  // Return full term objects with metadata
  return allTerms;
}

async function addBlockedTermToChannel(channelLogin, term) {
  if (!TWITCH_CLIENT_ID || !currentRefreshToken) {
    throw new Error("Missing Twitch credentials");
  }

  const tokenInfo = await refreshAndApplyTwitchToken();
  const accessToken = tokenInfo?.oauthToken?.replace("oauth:", "") ?? process.env.TWITCH_OAUTH?.replace("oauth:", "");

  if (!accessToken) {
    throw new Error("Failed to get access token");
  }

  // Get broadcaster ID
  const userResponse = await fetch(
    `https://api.twitch.tv/helix/users?login=${encodeURIComponent(channelLogin)}`,
    {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Client-Id": TWITCH_CLIENT_ID
      }
    }
  );

  if (!userResponse.ok) {
    throw new Error(`Failed to fetch user info: ${userResponse.status}`);
  }

  const userData = await userResponse.json();
  if (!userData.data?.length) {
    throw new Error(`Channel not found: ${channelLogin}`);
  }

  const broadcasterId = userData.data[0].id;

  // Get moderator ID (the authenticated user making the request)
  const moderatorResponse = await fetch(
    "https://api.twitch.tv/helix/users",
    {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Client-Id": TWITCH_CLIENT_ID
      }
    }
  );

  if (!moderatorResponse.ok) {
    throw new Error(`Failed to fetch moderator info: ${moderatorResponse.status}`);
  }

  const moderatorData = await moderatorResponse.json();
  if (!moderatorData.data?.length) {
    throw new Error("Could not get authenticated user ID");
  }

  const moderatorId = moderatorData.data[0].id;

  // Add blocked term
  const addResponse = await fetch(
    `https://api.twitch.tv/helix/moderation/blocked_terms?broadcaster_id=${broadcasterId}&moderator_id=${moderatorId}`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Client-Id": TWITCH_CLIENT_ID,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text: term })
    }
  );

  if (!addResponse.ok) {
    const errorText = await addResponse.text();
    throw new Error(`Failed to add blocked term: ${addResponse.status} ${errorText}`);
  }

  return await addResponse.json();
}

async function warnTwitchUser(username, reason) {
  if (!TWITCH_CLIENT_ID || !currentRefreshToken) {
    throw new Error("Missing Twitch credentials");
  }

  const tokenInfo = await refreshAndApplyTwitchToken();
  const accessToken = tokenInfo?.oauthToken?.replace("oauth:", "") ?? process.env.TWITCH_OAUTH?.replace("oauth:", "");

  if (!accessToken) {
    throw new Error("No Twitch access token available");
  }

  // Get broadcaster user ID
  const broadcasterResponse = await fetch(
    `https://api.twitch.tv/helix/users?login=${TWITCH_CHANNEL.replace("#", "")}`,
    {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Client-Id": TWITCH_CLIENT_ID
      }
    }
  );

  if (!broadcasterResponse.ok) {
    throw new Error(`Failed to get broadcaster ID: ${broadcasterResponse.status}`);
  }

  const broadcasterData = await broadcasterResponse.json();
  const broadcasterId = broadcasterData.data?.[0]?.id;

  if (!broadcasterId) {
    throw new Error("Broadcaster not found");
  }

  // Get user ID to warn
  const userResponse = await fetch(
    `https://api.twitch.tv/helix/users?login=${username}`,
    {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Client-Id": TWITCH_CLIENT_ID
      }
    }
  );

  if (!userResponse.ok) {
    throw new Error(`Failed to get user ID: ${userResponse.status}`);
  }

  const userData = await userResponse.json();
  const userId = userData.data?.[0]?.id;

  if (!userId) {
    throw new Error("User not found");
  }

  // Get moderator user ID (the bot itself)
  const modResponse = await fetch(
    `https://api.twitch.tv/helix/users?login=${TWITCH_USERNAME}`,
    {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Client-Id": TWITCH_CLIENT_ID
      }
    }
  );

  if (!modResponse.ok) {
    throw new Error(`Failed to get moderator ID: ${modResponse.status}`);
  }

  const modData = await modResponse.json();
  const moderatorId = modData.data?.[0]?.id;

  if (!moderatorId) {
    throw new Error("Moderator user not found");
  }

  // Send warning
  const warnResponse = await fetch(
    `https://api.twitch.tv/helix/moderation/warnings?broadcaster_id=${broadcasterId}&moderator_id=${moderatorId}`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Client-Id": TWITCH_CLIENT_ID,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        user_id: userId,
        reason: reason || "Violating community guidelines"
      })
    }
  );

  if (!warnResponse.ok) {
    const errorText = await warnResponse.text();
    throw new Error(`Failed to warn user: ${warnResponse.status} - ${errorText}`);
  }
}


function createTwitchClient(oauthToken) {
  return new tmi.Client({
    options: { debug: false },
    identity: {
      username: TWITCH_USERNAME,
      password: oauthToken
    },
    channels: TWITCH_CHANNELS
  });
}

let discordChannels = [];
const runtimeBlacklist = new Set();

discordClient.once("clientReady", async () => {
  try {
    const channelIds = DISCORD_CHANNEL_ID.split(",").map((id) => id.trim()).filter(Boolean);
    const resolved = await Promise.all(
      channelIds.map(async (id) => {
        try {
          return await discordClient.channels.fetch(id);
        } catch (error) {
          console.error(`Failed to fetch Discord channel ${id}`, error);
          return null;
        }
      })
    );
    discordChannels = resolved.filter(Boolean);
  } catch (error) {
    console.error("Failed to fetch Discord channel on startup", error);
  }
  console.log(`Discord connected as ${discordClient.user?.tag ?? "unknown"}`);
});

discordClient.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "klb") return;

  const isAllowed = hasPrivilegedRole(interaction.member);
  if (!isAllowed) {
    await interaction.reply({
      content: "You do not have permission to use this command.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "addblacklist") {
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
      relaySystemMessage(
        `${interaction.user.username} added ${word} to blacklist`
      ).catch((error) => {
        console.error("Failed to send blacklist update message", error);
      });
    } else {
      await interaction.reply({
        content: `Word already in blacklist: \`${word}\``,
        flags: MessageFlags.Ephemeral
      });
    }
  } else if (subcommand === "removeblacklist") {
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
      relaySystemMessage(
        `${interaction.user.username} removed ${word} from blacklist`
      ).catch((error) => {
        console.error("Failed to send blacklist update message", error);
      });
    } else {
      await interaction.reply({
        content: `Word not found: \`${word}\``,
        flags: MessageFlags.Ephemeral
      });
    }
  } else if (subcommand === "listblacklist") {
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

    const allPages = [
      ...createPages(plain, "Words"),
      ...createPages(regexes, "Regex")
    ];

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
        .setColor(0x5865F2)
        .setFooter({ text: `Page ${pageIndex + 1} of ${allPages.length} • Total: ${plain.length} words, ${regexes.length} regex` });
      return embed;
    };

    const generateButtons = (pageIndex) => {
      const row = new ActionRowBuilder()
        .addComponents(
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

        const attachment = new AttachmentBuilder(
          Buffer.from(fileContent, "utf-8"),
          { name: "blacklist.txt" }
        );

        await i.reply({
          content: "Here's your blacklist file:",
          files: [attachment],
          flags: MessageFlags.Ephemeral
        });
      }
    });

    collector.on("end", () => {
      response.edit({
        components: []
      }).catch(() => {});
    });
  } else if (subcommand === "restart") {
    if (!hasAdminRole(interaction.member)) {
      await interaction.reply({
        content: "This command requires admin permissions.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.reply({
      content: "Restarting bot... (Docker will automatically restart the container)",
      flags: MessageFlags.Ephemeral
    });

    setTimeout(() => {
      console.log("Restart command received, exiting process...");
      process.exit(0);
    }, 1000);
  } else if (subcommand === "stop") {
    if (!hasAdminRole(interaction.member)) {
      await interaction.reply({
        content: "This command requires admin permissions.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.reply({
      content: "Stopping bot... (Container will stop but not restart automatically)",
      flags: MessageFlags.Ephemeral
    });

    setTimeout(() => {
      console.log("Stop command received, exiting process with error code...");
      process.exit(1);
    }, 1000);
  } else if (subcommand === "importblacklist") {
    if (!hasAdminRole(interaction.member)) {
      await interaction.reply({
        content: "This command requires admin permissions.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

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
      const termObjects = await fetchBlockedTermsFromChannel(channel);

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
      const withExpiry = termObjects.filter(t => t.expires_at !== null).length;

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
  } else if (subcommand === "exportblacklist") {
    if (!hasAdminRole(interaction.member)) {
      await interaction.reply({
        content: "This command requires admin permissions.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

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
      // Get current blacklist
      const localTerms = await loadBlacklist();

      if (!localTerms.length) {
        await interaction.editReply({
          content: "Your blacklist is empty. Nothing to export.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      // Get existing terms from target channel
      const existingTerms = await fetchBlockedTermsFromChannel(channel);
      const existingSet = new Set(existingTerms);

      // Add terms that don't already exist
      let addedCount = 0;
      let errorCount = 0;

      for (const term of localTerms) {
        if (!existingSet.has(term)) {
          try {
            await addBlockedTermToChannel(channel, term);
            addedCount++;
          } catch (error) {
            console.error(`Failed to add term "${term}":`, error.message);
            errorCount++;
          }
        }
      }

      await interaction.editReply({
        content: `Exported ${addedCount} new terms to **${channel}** (${localTerms.length} total in blacklist, ${localTerms.length - addedCount - errorCount} already in channel${errorCount > 0 ? `, ${errorCount} failed` : ""})`,
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
      console.error("Failed to export blocked terms", error);
      await interaction.editReply({
        content: `Failed to export blocked terms: ${error.message}`,
        flags: MessageFlags.Ephemeral
      });
    }
  } else if (subcommand === "warn") {
    const username = interaction.options.getString("username", true).trim();
    const reason = interaction.options.getString("reason", false);

    if (!username) {
      await interaction.reply({
        content: "Username cannot be empty.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    try {
      await warnTwitchUser(username, reason || "Violating community guidelines");
      await interaction.reply({
        content: `Warned **${username}** on Twitch${reason ? `: ${reason}` : ""}`,
        flags: MessageFlags.Ephemeral
      });

      relaySystemMessage(
        `${interaction.user.username} warned ${username}${reason ? `: ${reason}` : ""}`
      ).catch((error) => {
        console.error("Failed to send warn message", error);
      });
    } catch (error) {
      console.error("Failed to warn user", error);
      await interaction.reply({
        content: `Failed to warn user: ${error.message}`,
        flags: MessageFlags.Ephemeral
      });
    }
  }
});

function hasPrivilegedRole(member) {
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

function hasAdminRole(member) {
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

discordClient.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;
  const allowedChannelIds = DISCORD_CHANNEL_ID.split(",").map((id) => id.trim());
  if (!allowedChannelIds.includes(reaction.message.channelId)) return;

  try {
    if (reaction.partial) {
      await reaction.fetch();
    }
    if (reaction.message.partial) {
      await reaction.message.fetch();
    }
  } catch {
    return;
  }

  const actionConfig = {
    delete: REACTION_DELETE_EMOJI,
    timeout: REACTION_TIMEOUT_EMOJI,
    ban: REACTION_BAN_EMOJI,
    warn: REACTION_WARN_EMOJI
  };
  const hasAnyAction = Object.values(actionConfig).some(Boolean);
  const reactionAction = resolveReactionAction(reaction, actionConfig, hasAnyAction);
  if (!reactionAction) return;

  const guild = reaction.message.guild;
  if (!guild) return;

  let member;
  try {
    member = await guild.members.fetch(user.id);
  } catch {
    return;
  }

    const adminRoleAllowed =
      process.env.ADMIN_ROLE_ID &&
      process.env.ADMIN_ROLE_ID.split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .some((id) => member.roles.cache.has(id));
    const modRoleAllowed =
      process.env.MOD_ROLE_ID &&
      process.env.MOD_ROLE_ID.split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .some((id) => member.roles.cache.has(id));
  const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);
  if (!adminRoleAllowed && !modRoleAllowed && !isAdmin) return;

  const relay = relayDiscordMap.get(reaction.message.id);
  if (!relay || !twitchClient) return;

  const channelName = relay.twitchChannel.startsWith("#")
    ? relay.twitchChannel
    : `#${relay.twitchChannel}`;

  // Extract the original message content from the Discord message
  const messageContent = reaction.message.content;
  const twitchMessageMatch = messageContent.match(/\*\*.*?\*\*: (.+?)(?:⚠️|$)/);
  const twitchMessageText = twitchMessageMatch ? twitchMessageMatch[1].trim() : "(message unavailable)";

  try {
    if (reactionAction === "delete") {
      await deleteTwitchMessageViaAPI(channelName, relay.twitchMessageId);
    } else if (reactionAction === "timeout") {
      const seconds = parseInt(REACTION_TIMEOUT_SECONDS, 10) || 60;
      await twitchClient.timeout(channelName, relay.twitchUsername, seconds);
    } else if (reactionAction === "ban") {
      await twitchClient.ban(channelName, relay.twitchUsername);
    } else if (reactionAction === "warn") {
      await warnTwitchUser(relay.twitchUsername, "Violating community guidelines");
    }

    // Remove all reactions from the message
    try {
      await reaction.message.reactions.removeAll();
    } catch (removeError) {
      console.warn("Failed to remove reactions", removeError);
    }

    // Post action message to the channel
    const actionMessages = {
      delete: `**${user.username}** removed **${relay.twitchUsername}**'s message: "${twitchMessageText}"`,
      timeout: `**${user.username}** timed out **${relay.twitchUsername}**, message: "${twitchMessageText}"`,
      ban: `**${user.username}** banned **${relay.twitchUsername}**, message: "${twitchMessageText}"`,
      warn: `**${user.username}** warned **${relay.twitchUsername}**, message: "${twitchMessageText}"`
    };

    const actionMessage = actionMessages[reactionAction];
    if (actionMessage) {
      try {
        await reaction.message.channel.send(actionMessage);
      } catch (sendError) {
        console.warn("Failed to send action message", sendError);
      }
    }
  } catch (error) {
    console.warn("Failed to moderate Twitch message", error);
  }
});

// Subscription thank you helper
function getTierName(tier) {
  switch (tier) {
    case "1000":
      return "Tier 1";
    case "2000":
      return "Tier 2";
    case "3000":
      return "Tier 3";
    case "Prime":
    case "prime":
      return "Prime";
    default:
      return tier;
  }
}

async function sendTwitchMessage(message, targetChannel = null) {
  if (!twitchClient) {
    console.warn("Cannot send Twitch message: client not connected");
    return;
  }

  // Use provided channel or default to first channel (or single channel for backwards compat)
  const channel = targetChannel || TWITCH_CHANNELS[0] || TWITCH_CHANNEL;

  try {
    await twitchClient.say(channel, message);
  } catch (error) {
    console.error("Failed to send Twitch message:", error);
  }
}

// Subscription event handlers
function handleTwitchSubscription(channel, username, method, message, userstate) {
  const tier = getTierName(method.plan);

  // Check if sub thank you messages are enabled (default: true)
  const enabled = SUB_THANK_YOU_ENABLED !== "false";
  if (enabled) {
    const thankYouMessage = `hype Welcome to Kandyland, ${username}! kandyKiss`;
    sendTwitchMessage(thankYouMessage, channel);
  }

  console.log(`[${channel}] New subscription: ${username} (${tier})`);
}

function handleTwitchResub(channel, username, months, message, userstate, methods) {
  const tier = getTierName(methods.plan);

  // Check if resub thank you messages are enabled (default: true)
  const enabled = RESUB_THANK_YOU_ENABLED !== "false";
  if (enabled) {
    const thankYouMessage = `hype Welcome back to Kandyland, ${username}! kandyKiss`;
    sendTwitchMessage(thankYouMessage, channel);
  }

  console.log(`[${channel}] Resub: ${username} (${tier}, ${months} months)`);
}

function handleTwitchSubGift(channel, username, streakMonths, recipient, methods, userstate) {
  const tier = getTierName(methods.plan);
  const giftCount = userstate["msg-param-sender-count"] || 1;

  // Check if gift sub thank you messages are enabled (default: true)
  const enabled = GIFT_SUB_THANK_YOU_ENABLED !== "false";
  if (enabled) {
    // Determine if single or multiple gifts
    const recipientText = giftCount === 1 ? recipient : `${giftCount} users`;
    const thankYouMessage = `Thank you for gifting to ${recipientText}, ${username}! kandyHype`;
    sendTwitchMessage(thankYouMessage, channel);
  }

  console.log(`[${channel}] Gift sub: ${username} -> ${recipient} (${tier}, ${giftCount} total gifts)`);
}

function attachTwitchHandlers(client) {
  client.on("message", handleTwitchMessage);
  client.on("messagedeleted", handleTwitchMessageDeleted);
  client.on("subscription", handleTwitchSubscription);
  client.on("resub", handleTwitchResub);
  client.on("subgift", handleTwitchSubGift);
  client.on("connected", (address, port) => {
    console.log(`Twitch connected to ${address}:${port}`);
  });
  client.on("disconnected", (reason) => {
    console.warn(`Twitch disconnected: ${reason}`);
  });
}

async function connectTwitch(oauthToken) {
  if (twitchClient) {
    try {
      await twitchClient.disconnect();
    } catch {
      // ignore disconnect errors
    }
  }
  twitchClient = createTwitchClient(oauthToken);
  attachTwitchHandlers(twitchClient);
  await twitchClient.connect();
}

function formatRelayMessage(username, message) {
  const timestamp = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date());
  return `[${timestamp}] **${username}**: ${message}`;
}

function isSuspiciousMessage(message) {
  if (SUSPICIOUS_FLAG_ENABLED?.toLowerCase() === "false") {
    return false;
  }
  if (!filters.blockedWords.length && !filters.blockedRegexes?.length) return false;
  const lowerMessage = message.toLowerCase();
  const wordHit = filters.blockedWords.some((word) =>
    word && lowerMessage.includes(word.toLowerCase())
  );
  const regexHit = filters.blockedRegexes?.some((regex) => {
    if (regex.global || regex.sticky) {
      regex.lastIndex = 0;
    }
    return regex.test(message);
  });
  return wordHit || regexHit;
}

function resolveReactionAction(reaction, actionConfig, requireMatch) {
  const name = reaction.emoji?.name ?? "";
  const id = reaction.emoji?.id ?? "";
  const matches = (config) => config && (config === name || config === id);

  if (matches(actionConfig.timeout)) return "timeout";
  if (matches(actionConfig.ban)) return "ban";
  if (matches(actionConfig.warn)) return "warn";
  if (matches(actionConfig.delete)) return "delete";

  return requireMatch ? null : "delete";
}

async function relayToDiscord(username, message, twitchChannel = null) {
  if (!discordChannels.length) {
    const channelIds = DISCORD_CHANNEL_ID.split(",").map((id) => id.trim()).filter(Boolean);
    discordChannels = await Promise.all(
      channelIds.map((id) => discordClient.channels.fetch(id).catch(() => null))
    );
    discordChannels = discordChannels.filter(Boolean);
  }

  // Determine which Discord channels to relay to
  let targetChannels = discordChannels;
  if (twitchChannel && channelMapping.size > 0) {
    const normalizedTwitchCh = twitchChannel.toLowerCase().replace(/^#/, "");
    const mappedDiscordId = channelMapping.get(normalizedTwitchCh);

    if (mappedDiscordId) {
      // Only relay to the mapped channel
      targetChannels = discordChannels.filter((ch) => ch.id === mappedDiscordId);
    }
    // If no mapping found, fall back to all channels
  }

  const suspicious = isSuspiciousMessage(message);
  const suffix = suspicious ? " ⚠️ Suspicious message" : "";

  // Add channel prefix if multi-channel mode
  const channelPrefix = TWITCH_CHANNELS.length > 1 && twitchChannel ? `[${twitchChannel.replace(/^#/, "")}] ` : "";

  let sent = null;
  for (const channel of targetChannels) {
    if (!channel?.isTextBased()) continue;
    const result = await channel.send(`${channelPrefix}${formatRelayMessage(username, message)}${suffix}`);
    if (suspicious) {
      addModerationReactions(result).catch((error) => {
        console.warn("Failed to add moderation reactions", error);
      });
    }
    if (!sent) sent = result;
  }
  console.log(`Relayed [${twitchChannel || "unknown"}]: ${username}: ${message}`);
  return sent;
}

function handleTwitchMessage(channel, tags, message, self) {
  if (self) return;

  const username = tags["display-name"] || tags.username || "unknown";

  // Handle !klbping command (mods/broadcaster only)
  if (message.trim() === "!klbping") {
    const isMod = tags.mod || false;
    const isBroadcaster = tags.badges?.broadcaster === "1";

    if (isMod || isBroadcaster) {
      const uptimeMs = Date.now() - BOT_START_TIME;
      const uptimeSeconds = Math.floor(uptimeMs / 1000);
      const hours = Math.floor(uptimeSeconds / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const seconds = uptimeSeconds % 60;

      let uptimeStr = "";
      if (hours > 0) uptimeStr += `${hours}h `;
      if (minutes > 0 || hours > 0) uptimeStr += `${minutes}m `;
      uptimeStr += `${seconds}s`;

      sendTwitchMessage(`pong, uptime: ${uptimeStr.trim()}`, channel);
    }
    return;
  }

  const normalized = normalizeMessage(message);

  if (shouldBlockMessage({
    username,
    message: normalized,
    rawMessage: message,
    tags,
    filters
  })) {
    return;
  }

  relayToDiscord(username, normalized, channel)
    .then((sent) => {
      const msgId = tags?.id;
      if (!msgId || !sent) return;
      relayMessageMap.set(msgId, {
        discordMessageId: sent.id,
        discordChannelId: sent.channelId
      });
      relayDiscordMap.set(sent.id, {
        twitchMessageId: msgId,
        twitchChannel: channel,
        twitchUsername: tags?.username ?? username
      });
      setTimeout(() => {
        relayMessageMap.delete(msgId);
        relayDiscordMap.delete(sent.id);
      }, RELAY_CACHE_TTL_MS);
    })
    .catch((error) => {
      console.error("Failed to relay message", error);
    });
}

async function handleTwitchMessageDeleted(channel, username, deletedMessage, userstate) {
  const targetId = userstate?.["target-msg-id"];
  if (!targetId) return;
  const record = relayMessageMap.get(targetId);
  if (!record) return;

  const discordChannelResolved = discordChannels.find(
    (item) => item?.id === record.discordChannelId
  );
  if (!discordChannelResolved || !discordChannelResolved.isTextBased()) {
    return;
  }

  try {
    const message = await discordChannelResolved.messages.fetch(record.discordMessageId);
    if (!message) return;
    if (message.content.includes("(deleted")) return;
    await message.edit(`${message.content} (deleted)`);
  } catch (error) {
    console.warn("Failed to update deleted message", error);
  }
}

async function start() {
  await discordClient.login(DISCORD_TOKEN);
  await hydrateBlacklist();
  const tokenInfo = await refreshAndApplyTwitchToken();
  const oauthToken = tokenInfo?.oauthToken ?? TWITCH_OAUTH;
  if (!oauthToken) {
    throw new Error("Missing TWITCH_OAUTH or refresh credentials");
  }
  await connectTwitch(oauthToken);

  console.log("Relay online: Twitch chat -> Discord channel");

  await startEventSubServer(process.env, {
    logger: console,
    onEvent: (payload) => {
      const type = payload?.subscription?.type || "unknown";
      console.log(`EventSub notification: ${type}`);
      if (type === "stream.online") {
        relaySystemMessage("EventSub: stream online").catch((error) => {
          console.error("Failed to send EventSub online message", error);
        });
      } else if (type === "stream.offline") {
        relaySystemMessage("EventSub: stream offline").catch((error) => {
          console.error("Failed to send EventSub offline message", error);
        });
      }
    }
  });

  startFreezeMonitor(process.env, {
    logger: console,
    onFreeze: () => {
      const mention = FREEZE_ALERT_ROLE_ID ? `<@&${FREEZE_ALERT_ROLE_ID}> ` : "";
      relaySystemMessage(`${mention}Stream appears frozen`).catch((error) => {
        console.error("Failed to send freeze alert", error);
      });
    },
    onRecover: () => {
      relaySystemMessage("Stream motion detected again").catch((error) => {
        console.error("Failed to send recovery alert", error);
      });
    },
    onOffline: () => {
      relaySystemMessage("Stream appears offline").catch((error) => {
        console.error("Failed to send offline alert", error);
      });
    },
    onOnline: () => {
      relaySystemMessage("Stream appears online").catch((error) => {
        console.error("Failed to send online alert", error);
      });
    }
  });

  if (tokenInfo?.expiresIn) {
    scheduleTokenRefresh(tokenInfo.expiresIn);
  }
}

async function relaySystemMessage(message) {
  if (!discordChannels.length) {
    const channelIds = DISCORD_CHANNEL_ID.split(",").map((id) => id.trim()).filter(Boolean);
    discordChannels = await Promise.all(
      channelIds.map((id) => discordClient.channels.fetch(id).catch(() => null))
    );
    discordChannels = discordChannels.filter(Boolean);
  }

  const payload = `[SYSTEM] ${message}`;
  await Promise.all(
    discordChannels
      .filter((channel) => channel?.isTextBased())
      .map((channel) => channel.send(payload))
  );
}

async function hydrateBlacklist() {
  try {
    const words = await loadBlacklist();
    updateBlacklistFromEntries(words);
  } catch (error) {
    console.warn("Failed to load blacklist file", error);
  }
}

// Slash command registration moved to deploy-commands.js

function updateBlacklistFromEntries(entries) {
  runtimeBlacklist.clear();
  blacklistRegexMap.clear();
  filters.blockedWords = [...baseBlockedWords];
  filters.blockedRegexes = [];

  for (const entry of entries) {
    const trimmed = (entry ?? "").toString().trim();
    if (!trimmed) continue;
    runtimeBlacklist.add(trimmed);
    const regex = parseRegexEntry(trimmed);
    if (regex) {
      blacklistRegexMap.set(trimmed, regex);
      filters.blockedRegexes.push(regex);
    } else {
      filters.blockedWords.push(trimmed);
    }
  }
}

function parseRegexEntry(value) {
  if (!value.startsWith("/")) return null;
  const lastSlash = value.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  const pattern = value.slice(1, lastSlash);
  const flags = value.slice(lastSlash + 1);
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    console.warn(`Invalid blacklist regex "${value}": ${error.message}`);
    return null;
  }
}

async function persistRefreshToken(refreshToken) {
  const envPath = join(process.cwd(), ".env");
  let content;
  try {
    content = await fs.readFile(envPath, "utf8");
  } catch (error) {
    console.warn("Failed to read .env for refresh token update", error);
    return;
  }

  const line = `TWITCH_REFRESH_TOKEN=${refreshToken}`;
  if (content.includes("TWITCH_REFRESH_TOKEN=")) {
    const updated = content.replace(
      /^TWITCH_REFRESH_TOKEN=.*$/m,
      line
    );
    if (updated !== content) {
      await fs.writeFile(envPath, updated, "utf8");
    }
    return;
  }

  await fs.writeFile(envPath, `${content}\n${line}\n`, "utf8");
}

async function refreshAndApplyTwitchToken() {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET || !currentRefreshToken) {
    return null;
  }

  const previousRefreshToken = currentRefreshToken;
  const refreshed = await refreshTwitchToken({
    clientId: TWITCH_CLIENT_ID,
    clientSecret: TWITCH_CLIENT_SECRET,
    refreshToken: currentRefreshToken
  });

  const oauthToken = `oauth:${refreshed.accessToken}`;
  currentRefreshToken = refreshed.refreshToken;
  process.env.TWITCH_OAUTH = oauthToken;
  if (!process.env.FREEZE_OAUTH_BEARER || freezeAuthManaged) {
    process.env.FREEZE_OAUTH_BEARER = refreshed.accessToken;
    freezeAuthManaged = true;
  }

  if (refreshed.refreshToken !== previousRefreshToken) {
    persistRefreshToken(refreshed.refreshToken).catch((error) => {
      console.warn("Failed to persist Twitch refresh token", error);
    });
  }

  return {
    oauthToken,
    expiresIn: refreshed.expiresIn
  };
}

function scheduleTokenRefresh(expiresInSeconds) {
  if (!expiresInSeconds) return;
  const refreshIn = Math.max(60, Math.floor(expiresInSeconds * 0.8));
  setTimeout(async () => {
    try {
      const tokenInfo = await refreshAndApplyTwitchToken();
      if (tokenInfo?.oauthToken) {
        await connectTwitch(tokenInfo.oauthToken);
      }
      if (tokenInfo?.expiresIn) {
        scheduleTokenRefresh(tokenInfo.expiresIn);
      }
    } catch (error) {
      console.error("Failed to refresh Twitch token", error);
      scheduleTokenRefresh(Math.max(60, expiresInSeconds));
    }
  }, refreshIn * 1000);
}

async function addModerationReactions(message) {
  const emojis = [REACTION_DELETE_EMOJI, REACTION_TIMEOUT_EMOJI, REACTION_BAN_EMOJI, REACTION_WARN_EMOJI]
    .map((emoji) => (emoji ?? "").trim())
    .filter(Boolean);
  if (!emojis.length) return;

  for (const emoji of emojis) {
    await message.react(emoji);
  }
}

start().catch((error) => {
  console.error("Startup failed", error);
  process.exit(1);
});
