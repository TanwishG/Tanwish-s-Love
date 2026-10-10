import {
  SlashCommandBuilder,
  MessageFlags,
} from 'discord.js';
import { isBotOwner } from '../../config/bot.js';
import { successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { logEvent } from '../../utils/moderation.js';

export default {
  data: new SlashCommandBuilder()
    .setName('bypass')
    .setDescription('Bot-owner-only moderation bypass controls')
    .setDefaultMemberPermissions(null)
    .addSubcommand((subcommand) => subcommand
      .setName('lock')
      .setDescription('Allow a specific user or role to send messages in a locked channel')
      .addChannelOption((option) => option
        .setName('channel')
        .setDescription('The locked channel to configure')
        .setRequired(true))
      .addUserOption((option) => option
        .setName('user')
        .setDescription('User allowed to send messages')
        .setRequired(false))
      .addRoleOption((option) => option
        .setName('role')
        .setDescription('Role allowed to send messages')
        .setRequired(false))),
  category: 'moderation',

  async execute(interaction, config, client) {
    if (!isBotOwner(interaction.user.id)) {
      return interaction.reply({
        content: '⛔ `/bypass` is restricted to the bot owner(s) configured in `OWNER_IDS`.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!interaction.inGuild() || !interaction.guild) {
      return interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand !== 'lock') {
      return interaction.reply({ content: 'Unknown bypass action.', flags: MessageFlags.Ephemeral });
    }

    const channel = interaction.options.getChannel('channel');
    const user = interaction.options.getUser('user');
    const role = interaction.options.getRole('role');

    if (Boolean(user) === Boolean(role)) {
      return interaction.reply({
        content: 'Choose exactly one target: either `user` or `role`.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!channel?.permissionOverwrites?.edit) {
      return interaction.reply({ content: 'That channel does not support permission overwrites.', flags: MessageFlags.Ephemeral });
    }
    if (role && role.id === interaction.guild.roles.everyone.id) {
      return interaction.reply({ content: 'The @everyone role cannot be used as a lock bypass.', flags: MessageFlags.Ephemeral });
    }

    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    try {
      const target = role || user;
      await channel.permissionOverwrites.edit(
        target,
        { SendMessages: true },
        { reason: `Lock bypass configured by bot owner ${interaction.user.tag} (${interaction.user.id})` },
      );
      await logEvent({
        client,
        guild: interaction.guild,
        event: {
          action: 'Channel Lock Bypass Added',
          target: channel.toString(),
          executor: `${interaction.user.tag} (${interaction.user.id})`,
          metadata: {
            channelId: channel.id,
            bypassUserId: user?.id || null,
            bypassRoleId: role?.id || null,
          },
        },
      });
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('🔓 Lock Bypass Added', `${target} can now send messages in ${channel} while the channel is locked. Remove the overwrite manually or use channel permission settings to revoke it.`)],
      });
    } catch (error) {
      logger.error('Bypass lock command error:', error);
      await replyUserError(interaction, {
        type: ErrorTypes.PERMISSION,
        message: `Could not configure the bypass. Check that I have Manage Channels permission in ${channel}.`,
      });
    }
  },
};
