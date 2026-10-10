import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { logEvent } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { isBotOwner } from '../../config/bot.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

export default {
  data: new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Locks this channel; optionally lets a role or member continue sending messages.')
    // Discord cannot represent the bot's OWNER_IDS list as command visibility permissions.
    // The execute() guard below is the authoritative access check.
    .setDefaultMemberPermissions(null)
    .addRoleOption((option) => option
      .setName('bypass_role')
      .setDescription('Optional role allowed to send messages while the channel is locked')
      .setRequired(false))
    .addUserOption((option) => option
      .setName('bypass_member')
      .setDescription('Optional member allowed to send messages while the channel is locked')
      .setRequired(false)),

  category: 'moderation',

  async execute(interaction, config, client) {
    // Only IDs listed in OWNER_IDS (loaded by isBotOwner) may execute /lock.
    // Server administrators and the server owner do not bypass this guard unless listed.
    if (!isBotOwner(interaction.user.id)) {
      return interaction.reply({
        content: '⛔ Only the bot owner(s) configured in `OWNER_IDS` can use `/lock`.',
        flags: MessageFlags.Ephemeral,
      });
    }

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
    const bypassRole = interaction.options.getRole('bypass_role');
    const bypassMember = interaction.options.getMember('bypass_member');
    const bypassDescriptions = [];

    try {
      if (!channel.permissionOverwrites?.edit) {
        return await InteractionHelper.safeEditReply(interaction, {
          content: 'This channel type does not support permission overwrites.',
        });
      }

      if (bypassRole && bypassRole.id === everyoneRole.id) {
        return await InteractionHelper.safeEditReply(interaction, {
          content: 'The @everyone role cannot be used as a bypass role. Choose a specific role.',
        });
      }

      const currentPermissions = channel.permissionsFor(everyoneRole);
      const alreadyLocked = currentPermissions?.has(PermissionFlagsBits.SendMessages) === false;

      if (alreadyLocked && !bypassRole && !bypassMember) {
        return await replyUserError(interaction, {
          type: ErrorTypes.UNKNOWN,
          message: `${channel} is already locked. You can run /lock again with a bypass role or member to update its exceptions.`,
        });
      }

      // Deny @everyone first, then add explicit allow overwrites for the selected exceptions.
      if (!alreadyLocked) {
        await channel.permissionOverwrites.edit(
          everyoneRole,
          { SendMessages: false },
          { reason: `Channel locked by bot owner ${interaction.user.tag} (${interaction.user.id})` },
        );
      }

      if (bypassRole) {
        await channel.permissionOverwrites.edit(
          bypassRole,
          { SendMessages: true },
          { reason: `Lock bypass role configured by bot owner ${interaction.user.tag} (${interaction.user.id})` },
        );
        bypassDescriptions.push(`${bypassRole} (role)`);
      }

      if (bypassMember) {
        await channel.permissionOverwrites.edit(
          bypassMember,
          { SendMessages: true },
          { reason: `Lock bypass member configured by bot owner ${interaction.user.tag} (${interaction.user.id})` },
        );
        bypassDescriptions.push(`${bypassMember} (member)`);
      }

      await logEvent({
        client,
        guild: interaction.guild,
        event: {
          action: alreadyLocked ? 'Channel Lock Bypass Updated' : 'Channel Locked',
          target: channel.toString(),
          executor: `${interaction.user.tag} (${interaction.user.id})`,
          metadata: {
            channelId: channel.id,
            category: channel.parent?.name || 'None',
            moderatorId: interaction.user.id,
            bypassRoleId: bypassRole?.id || null,
            bypassMemberId: bypassMember?.id || null,
          },
        },
      });

      const bypassText = bypassDescriptions.length
        ? `\n\n**Can still send messages:** ${bypassDescriptions.join(', ')}`
        : '\n\nNo bypass role or member was selected; @everyone is denied permission to send messages.';
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(
          '🔒 Channel Locked',
          `${channel} is locked. Only members with an explicit allow overwrite (including any selected bypass) can send messages.${bypassText}`,
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
