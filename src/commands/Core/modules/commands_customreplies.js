// The "Custom replies" screen of /commands dashboard: "!invite" -> a message.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { createEmbed } from '../../../utils/embeds.js';
import { getCommandPrefix } from '../../../config/bot.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import { canManageAccessPolicy } from '../../../services/commandPermissionsService.js';
import {
  MAX_CUSTOM_COMMANDS,
  MAX_RESPONSE_LENGTH,
  addCustomCommand,
  getCustomCommands,
  removeCustomCommand,
  validateCustomCommandName,
} from '../../../services/customCommandService.js';

export const CC_OPEN = 'cmdaccess_cc_open';
export const CC_ADD = 'cmdaccess_cc_add';
export const CC_REMOVE = 'cmdaccess_cc_remove';

const cid = (base, guildId) => `${base}:${guildId}`;

async function getPrefix(client, guildId) {
  const config = await getGuildConfig(client, guildId).catch(() => null);
  return config?.prefix || getCommandPrefix();
}

export async function buildCustomRepliesView(client, guildId, homeCustomId) {
  const prefix = await getPrefix(client, guildId);
  const commands = await getCustomCommands(client, guildId);
  const names = Object.keys(commands).sort();

  const lines = names.map((name) => {
    const preview = commands[name].response.replace(/\s+/g, ' ');
    return `\`${prefix}${name}\` → ${preview.length > 70 ? `${preview.slice(0, 70)}…` : preview}`;
  });

  const embed = createEmbed({
    title: '💬 Custom replies',
    description: [
      `Make the bot answer a command with a message you choose — for example \`${prefix}invite\` → your invite link.`,
      '',
      names.length ? lines.join('\n').slice(0, 3500) : '_No custom replies yet. Press **Add reply** to create one._',
    ].join('\n'),
    color: 'info',
    fields: [
      {
        name: 'Tips',
        value: [
          '• Works with the prefix (not as a `/` command).',
          '• Placeholders: `{user}` `{username}` `{server}` `{channel}`',
          '• Replies never ping @everyone, @here or roles.',
          `• Up to ${MAX_CUSTOM_COMMANDS} per server. Built-in command names can\'t be used.`,
        ].join('\n'),
      },
    ],
    footer: `${names.length}/${MAX_CUSTOM_COMMANDS} used`,
  });

  const rows = [];
  if (names.length > 0) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(cid(CC_REMOVE, guildId))
          .setPlaceholder('🗑️ Remove a reply...')
          .addOptions(
            names.slice(0, 25).map((name) =>
              new StringSelectMenuOptionBuilder().setLabel(`${prefix}${name}`.slice(0, 100)).setValue(name),
            ),
          ),
      ),
    );
  }
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(homeCustomId).setLabel('Back').setEmoji('◀️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(cid(CC_ADD, guildId)).setLabel('Add reply').setEmoji('➕').setStyle(ButtonStyle.Success)
        .setDisabled(names.length >= MAX_CUSTOM_COMMANDS),
    ),
  );

  return { embed, components: rows };
}

const needManage = (interaction) =>
  interaction.reply({ content: 'You need the **Manage Server** permission to change custom replies.', flags: MessageFlags.Ephemeral });

export async function handleCustomReplyComponent(interaction, client, action, guildId, homeCustomId) {
  const refresh = async (target) => {
    const view = await buildCustomRepliesView(client, guildId, homeCustomId);
    return target.update({ embeds: [view.embed], components: view.components });
  };

  if (action === CC_OPEN) return refresh(interaction);

  if (!canManageAccessPolicy(interaction)) return needManage(interaction);

  if (action === CC_REMOVE) {
    await removeCustomCommand(client, guildId, interaction.values[0]);
    return refresh(interaction);
  }

  if (action === CC_ADD) {
    const prefix = await getPrefix(client, guildId);
    const modalId = `cmdaccess_modal_cc:${guildId}:${interaction.id}`;

    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(modalId)
        .setTitle('Add a custom reply')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('name')
              .setLabel(`Command name (without ${prefix})`)
              .setPlaceholder('invite')
              .setStyle(TextInputStyle.Short)
              .setMinLength(1)
              .setMaxLength(32)
              .setRequired(true),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('response')
              .setLabel('What should the bot reply?')
              .setPlaceholder('Join our server: https://discord.gg/yourlink')
              .setStyle(TextInputStyle.Paragraph)
              .setMinLength(1)
              .setMaxLength(MAX_RESPONSE_LENGTH)
              .setRequired(true),
          ),
        ),
    );

    const submitted = await interaction
      .awaitModalSubmit({ time: 5 * 60 * 1000, filter: (i) => i.customId === modalId && i.user.id === interaction.user.id })
      .catch(() => null);
    if (!submitted) return;

    const checked = validateCustomCommandName(client, submitted.fields.getTextInputValue('name'), prefix);
    if (!checked.ok) {
      return submitted.reply({ content: `❌ ${checked.error}`, flags: MessageFlags.Ephemeral });
    }

    try {
      await addCustomCommand(client, guildId, checked.name, submitted.fields.getTextInputValue('response'), interaction.user.id);
    } catch (error) {
      return submitted.reply({ content: `❌ ${error.message}`, flags: MessageFlags.Ephemeral });
    }
    return refresh(submitted);
  }
}
