import { PermissionsBitField } from "discord.js";
import botState from "../state/BotState.js";
import { handleSlashCommand } from "../commands/commandRegistry.js";

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
  const adminRoleAllowed =
    process.env.ADMIN_ROLE_ID &&
    process.env.ADMIN_ROLE_ID.split(",")
      .map(id => id.trim())
      .filter(Boolean)
      .some(id => member.roles.cache.has(id));

  const modRoleAllowed =
    process.env.MOD_ROLE_ID &&
    process.env.MOD_ROLE_ID.split(",")
      .map(id => id.trim())
      .filter(Boolean)
      .some(id => member.roles.cache.has(id));

  const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);
  if (!adminRoleAllowed && !modRoleAllowed && !isAdmin) return;

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

  // Extract original message content
  const messageContent = reaction.message.content;
  const twitchMessageMatch = messageContent.match(/\*\*.*?\*\*: (.+?)(?:⚠️|$)/);
  const twitchMessageText = twitchMessageMatch ? twitchMessageMatch[1].trim() : "(message unavailable)";

  try {
    if (reactionAction === "delete") {
      await twitchAPIClient.deleteMessage(channelName, relay.twitchMessageId);
    } else if (reactionAction === "timeout") {
      const seconds = botState.config.reactionTimeoutSeconds;
      await twitchAPIClient.timeoutUser(channelName, relay.twitchUsername, seconds);
    } else if (reactionAction === "ban") {
      await twitchAPIClient.banUser(channelName, relay.twitchUsername);
    } else if (reactionAction === "warn") {
      await twitchAPIClient.warnUser(channelName, relay.twitchUsername, "Violating community guidelines");
    }

    // Record moderation action
    botState.recordModerationAction(reactionAction, user.username, relay.twitchUsername, {
      message: twitchMessageText,
      channel: channelName
    });

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
  }
}

/**
 * Handle slash command interaction
 */
export async function handleInteraction(interaction, dependencies) {
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
