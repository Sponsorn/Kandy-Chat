import {
  ContainerBuilder,
  TextDisplayBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags
} from "discord.js";

/**
 * Build a normal V2 message (no moderation buttons)
 */
export function buildNormalV2Message(formattedText) {
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(formattedText)
  );

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2
  };
}

/**
 * Build a suspicious V2 message with moderation buttons
 */
export function buildSuspiciousV2Message(formattedText, matchedWord) {
  const container = new ContainerBuilder()
    .setAccentColor(0xed4245)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(formattedText))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ⚠️ Suspicious message [${matchedWord}]`)
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("mod-delete")
          .setLabel("Delete")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("mod-timeout")
          .setLabel("Timeout")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("mod-ban").setLabel("Ban").setStyle(ButtonStyle.Danger)
        // new ButtonBuilder().setCustomId("mod-warn").setLabel("Warn").setStyle(ButtonStyle.Secondary)
      )
    );

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2
  };
}

/**
 * Build a disabled V2 message after a moderation action was taken
 */
export function buildDisabledV2Message(formattedText, matchedWord, actionLabel) {
  const container = new ContainerBuilder()
    .setAccentColor(0xed4245)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(formattedText))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ⚠️ Suspicious message [${matchedWord}]`)
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("mod-delete")
          .setLabel("Delete")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId("mod-timeout")
          .setLabel("Timeout")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId("mod-ban")
          .setLabel("Ban")
          .setStyle(ButtonStyle.Danger)
          .setDisabled(true)
        // new ButtonBuilder().setCustomId("mod-warn").setLabel("Warn").setStyle(ButtonStyle.Secondary).setDisabled(true)
      )
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ✅ ${actionLabel}`));

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2
  };
}

/**
 * Build a deleted V2 message (strikethrough text)
 */
export function buildDeletedV2Message(formattedText) {
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`~~${formattedText}~~ (deleted)`)
  );

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2
  };
}
