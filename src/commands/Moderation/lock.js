import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { logEvent } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

export default {
  data: new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Locks this channel. Configure who may use this command in /commands dashboard.')
    // Runtime access is controlled by the command-permissions dashboard.
    .setDefaultMemberPermissions(null),

  category: 'moderation',

  async execute(interaction, config, client) {
    if (!interaction.inGuild() || !interaction.guild || !interaction.channel) {
      return interaction.reply({
        content: 'This command can only be used in a server channel.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const deferSuccess = await InteractionHelper.safeDefer(interaction);
    if (!deferSuccess) {
      logger.warn('Lock interaction defer failed', {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        commandName: 'lock',
      });
      return;
    }

    const channel = interaction.channel;
    const everyoneRole = interaction.guild.roles.everyone;

    try {
      if (!channel.permissionOverwrites?.edit) {
        return await InteractionHelper.safeEditReply(interaction, {
          content: 'This channel type does not support permission overwrites.',
        });
      }


      const currentPermissions = channel.permissionsFor(everyoneRole);
      const alreadyLocked = currentPermissions?.has(PermissionFlagsBits.SendMessages) === false;

      if (alreadyLocked) {
        return await replyUserError(interaction, {
          type: ErrorTypes.UNKNOWN,
          message: `${channel} is already locked. Use the owner-only /bypass lock command to allow a specific user or role.`,
        });
      }

      // Deny @everyone; owner-only /bypass lock can add explicit user/role exceptions.
      await channel.permissionOverwrites.edit(
        everyoneRole,
        { SendMessages: false },
        { reason: `Channel locked by ${interaction.user.tag} (${interaction.user.id})` },
      );

      await logEvent({
        client,
        guild: interaction.guild,
        event: {
          action: 'Channel Locked',
          target: channel.toString(),
          executor: `${interaction.user.tag} (${interaction.user.id})`,
          metadata: {
            channelId: channel.id,
            category: channel.parent?.name || 'None',
            moderatorId: interaction.user.id,
          },
        },
      });

      await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(
          '🔒 Channel Locked',
          `${channel} is locked. Use the owner-only /bypass lock command to allow a specific user or role to send messages while the lock is active.`,
        )],
      });
    } catch (error) {
      logger.error('Lock command error:', error);
      await replyUserError(interaction, {
        type: ErrorTypes.PERMISSION,
        message: 'Could not lock this channel or configure the bypass. Check that the bot has Manage Channels permission.',
      });
    }
  },
};
