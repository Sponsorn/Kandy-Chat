import botState from "../state/BotState.js";
import { handleSlashCommand } from "../commands/commandRegistry.js";
import { hasPrivilegedRole } from "../utils/permissions.js";
import { buildDisabledV2Message } from "../services/messageBuilder.js";

/**
 * Resolve which moderation action to take based on reaction emoji
 */
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

/**
 * Handle message reaction for moderation actions
 */
export async function handleReactionAdd(reaction, user, twitchAPIClient) {
  if (user.bot) return;

  // Fetch partial reactions
  try {
    if (reaction.partial) await reaction.fetch();
  } catch {
    return;
  }

  // Determine action from emoji
  const actionConfig = botState.config.reactionEmojis;
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

  // Check permissions
  if (!hasPrivilegedRole(member)) return;

  const relay = botState.getRelayByDiscordId(reaction.message.id);
  if (!relay || !botState.twitchClient) return;

  // Validate relay entry
  if (!relay.twitchMessageId || !relay.twitchUsername || !relay.twitchChannel) {
    console.warn("Invalid relay entry - missing required properties");
    return;
  }

  const channelName = relay.twitchChannel.startsWith("#")
    ? relay.twitchChannel
    : `#${relay.twitchChannel}`;

  // Extract original message content (prefer stored text, fall back to regex parsing)
  const twitchMessageText =
    relay.twitchMessage ||
    (() => {
      const match = reaction.message.content.match(/\*\*.*?\*\*: (.+?)(?:⚠️|$)/);
      return match ? match[1].trim() : "(message unavailable)";
    })();

  try {
    if (reactionAction === "delete") {
      await twitchAPIClient.deleteMessage(channelName, relay.twitchMessageId);
    } else if (reactionAction === "timeout") {
      const seconds = botState.config.reactionTimeoutSeconds;
      await twitchAPIClient.timeoutUser(channelName, relay.twitchUsername, seconds);
    } else if (reactionAction === "ban") {
      await twitchAPIClient.banUser(channelName, relay.twitchUsername);
    } else if (reactionAction === "warn") {
      await twitchAPIClient.warnUser(
        channelName,
        relay.twitchUsername,
        "Violating community guidelines"
      );
    }

    // Record moderation action (success)
    botState.recordModerationAction(
      reactionAction,
      user.username,
      relay.twitchUsername,
      { message: twitchMessageText, channel: channelName },
      "discord",
      "success"
    );

    // Remove other reactions, keep only the moderator's clicked reaction
    try {
      for (const [, r] of reaction.message.reactions.cache) {
        if (r.emoji.name !== reaction.emoji.name || r.emoji.id !== reaction.emoji.id) {
          await r.remove();
        } else {
          const botUser = reaction.message.client.user;
          if (botUser) await r.users.remove(botUser.id);
        }
      }
    } catch (removeError) {
      console.warn("Failed to remove reactions", removeError);
    }

    // Post action message
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

    // Record failed moderation action
    botState.recordModerationAction(
      reactionAction,
      user.username,
      relay.twitchUsername,
      { message: twitchMessageText, channel: channelName },
      "discord",
      "failed",
      error.message
    );
  }
}

/**
 * Map button custom ID to moderation action
 */
const BUTTON_ACTION_MAP = {
  "mod-delete": "delete",
  "mod-timeout": "timeout",
  "mod-ban": "ban",
  "mod-warn": "warn"
};

/**
 * Handle moderation button interaction
 */
async function handleButtonInteraction(interaction, twitchAPIClient) {
  const action = BUTTON_ACTION_MAP[interaction.customId];
  if (!action) return;

  const guild = interaction.guild;
  if (!guild) return;

  let member;
  try {
    member = await guild.members.fetch(interaction.user.id);
  } catch {
    return;
  }

  if (!hasPrivilegedRole(member)) {
    await interaction.reply({ content: "You don't have permission to do that.", ephemeral: true });
    return;
  }

  const relay = botState.getRelayByDiscordId(interaction.message.id);
  if (!relay || !botState.twitchClient) {
    await interaction.reply({
      content: "This message is no longer tracked (relay entry expired).",
      ephemeral: true
    });
    return;
  }

  if (!relay.twitchMessageId || !relay.twitchUsername || !relay.twitchChannel) {
    await interaction.reply({
      content: "Invalid relay entry — missing required data.",
      ephemeral: true
    });
    return;
  }

  const channelName = relay.twitchChannel.startsWith("#")
    ? relay.twitchChannel
    : `#${relay.twitchChannel}`;
  const twitchMessageText = relay.twitchMessage || "(message unavailable)";

  await interaction.deferUpdate();

  try {
    if (action === "delete") {
      await twitchAPIClient.deleteMessage(channelName, relay.twitchMessageId);
    } else if (action === "timeout") {
      const seconds = botState.config.reactionTimeoutSeconds;
      await twitchAPIClient.timeoutUser(channelName, relay.twitchUsername, seconds);
    } else if (action === "ban") {
      await twitchAPIClient.banUser(channelName, relay.twitchUsername);
    } else if (action === "warn") {
      await twitchAPIClient.warnUser(
        channelName,
        relay.twitchUsername,
        "Violating community guidelines"
      );
    }

    botState.recordModerationAction(
      action,
      interaction.user.username,
      relay.twitchUsername,
      { message: twitchMessageText, channel: channelName },
      "discord",
      "success"
    );

    // Reconstruct matched word from the original message's warning text
    const matchedWord = (() => {
      const components = interaction.message.components;
      if (!components?.length) return "flagged";
      const json = components[0]?.data || components[0];
      const textComponents = (json.components || []).filter((c) => c.type === 10);
      for (const td of textComponents) {
        const match = td.content?.match(/⚠️ Suspicious message \[(.+?)\]/);
        if (match) return match[1];
      }
      return "flagged";
    })();

    const actionLabels = {
      delete: `Deleted by ${interaction.user.username}`,
      timeout: `Timed out by ${interaction.user.username}`,
      ban: `Banned by ${interaction.user.username}`,
      warn: `Warned by ${interaction.user.username}`
    };

    await interaction.editReply(
      buildDisabledV2Message(
        relay.formattedText || twitchMessageText,
        matchedWord,
        actionLabels[action]
      )
    );

    // Post action summary to channel
    const actionMessages = {
      delete: `**${interaction.user.username}** removed **${relay.twitchUsername}**'s message: "${twitchMessageText}"`,
      timeout: `**${interaction.user.username}** timed out **${relay.twitchUsername}**, message: "${twitchMessageText}"`,
      ban: `**${interaction.user.username}** banned **${relay.twitchUsername}**, message: "${twitchMessageText}"`,
      warn: `**${interaction.user.username}** warned **${relay.twitchUsername}**, message: "${twitchMessageText}"`
    };

    try {
      await interaction.channel.send(actionMessages[action]);
    } catch (sendError) {
      console.warn("Failed to send action message", sendError);
    }
  } catch (error) {
    console.warn("Failed to moderate Twitch message via button", error);

    botState.recordModerationAction(
      action,
      interaction.user.username,
      relay.twitchUsername,
      { message: twitchMessageText, channel: channelName },
      "discord",
      "failed",
      error.message
    );

    try {
      await interaction.followUp({
        content: `Failed to ${action}: ${error.message}`,
        ephemeral: true
      });
    } catch {
      // ignore follow-up failure
    }
  }
}

/**
 * Handle slash command interaction
 */
export async function handleInteraction(interaction, dependencies) {
  if (interaction.isButton() && interaction.customId.startsWith("mod-")) {
    await handleButtonInteraction(interaction, dependencies.twitchAPIClient);
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "klb") return;

  await handleSlashCommand(interaction, dependencies);
}

/**
 * Setup Discord event handlers
 */
export function setupDiscordHandlers(client, twitchAPIClient, dependencies) {
  client.on("messageReactionAdd", (reaction, user) => {
    handleReactionAdd(reaction, user, twitchAPIClient);
  });

  client.on("interactionCreate", (interaction) => {
    handleInteraction(interaction, dependencies);
  });
}
