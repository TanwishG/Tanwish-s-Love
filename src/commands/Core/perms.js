import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';

const PERMISSION_GUIDE = [
  { flag: 'ViewChannel', label: 'View Channels', why: 'See channels where the bot should work.' },
  { flag: 'SendMessages', label: 'Send Messages', why: 'Reply to commands and send bot messages.' },
  { flag: 'ReadMessageHistory', label: 'Read Message History', why: 'Read prior messages for supported features and context.' },
  { flag: 'EmbedLinks', label: 'Embed Links', why: 'Send rich embeds for command responses, logs, and dashboards.' },
  { flag: 'AttachFiles', label: 'Attach Files', why: 'Send generated or attached files when a feature uses them.' },
  { flag: 'ManageChannels', label: 'Manage Channels', why: 'Lock/unlock channels and create or manage channels for supported features such as tickets and voice-channel creation.' },
  { flag: 'ManageRoles', label: 'Manage Roles', why: 'Assign/remove roles for autorole, reaction roles, verification, QOTD winners, and similar features. The bot role must be above roles it manages.' },
  { flag: 'ManageMessages', label: 'Manage Messages', why: 'Delete messages for purge/moderation and manage message-based features.' },
  { flag: 'KickMembers', label: 'Kick Members', why: 'Use kick moderation commands.' },
  { flag: 'BanMembers', label: 'Ban Members', why: 'Use ban/unban moderation commands.' },
  { flag: 'ModerateMembers', label: 'Moderate Members', why: 'Timeout and remove timeouts from members.' },
  { flag: 'ManageGuild', label: 'Manage Server', why: 'Some server configuration features may require this permission.' },
  { flag: 'Connect', label: 'Connect', why: 'Join voice channels for voice-related features.' },
  { flag: 'Speak', label: 'Speak', why: 'Play audio or use voice output when supported.' },
  { flag: 'MoveMembers', label: 'Move Members', why: 'Move members for supported voice-channel tools.' },
  { flag: 'ManageWebhooks', label: 'Manage Webhooks', why: 'Only needed if you enable features that create or manage webhooks.' },
];

function buildReport(guild, botMember) {
  const current = botMember.permissions;
  const missing = PERMISSION_GUIDE.filter((item) => !current.has(PermissionFlagsBits[item.flag]));
  const present = PERMISSION_GUIDE.filter((item) => current.has(PermissionFlagsBits[item.flag]));
  const describe = (items) => items.length
    ? items.map((item) => `• **${item.label}** — ${item.why}`).join('\n').slice(0, 3900)
    : 'None from this checklist.';

  const embed = createEmbed({
    title: 'Bot Permission Check',
    description: `Permission status for **${guild.name}**. You do **not** need to grant Administrator just to run the bot. Grant only the permissions needed for the features you use, in the channels where they are needed.`,
  });

  embed.addFields(
    { name: 'Administrator', value: current.has(PermissionFlagsBits.Administrator) ? 'Currently granted (not recommended as a requirement).' : 'Not granted — this is fine.', inline: false },
    { name: `Checklist permissions granted (${present.length})`, value: describe(present), inline: false },
    { name: `Checklist permissions missing (${missing.length})`, value: describe(missing), inline: false },
    { name: 'Important', value: 'This is a practical feature checklist, not a claim that every listed permission is required for every server. Missing permissions only affect the features that use them. Channel-specific overwrites and the bot role hierarchy can still prevent an action even when a permission appears granted.', inline: false },
  );
  return embed;
}

export default {
  data: new SlashCommandBuilder()
    .setName('perms')
    .setDescription('Check the bot permissions needed for its features without granting Administrator'),

  async prefixExecute(interaction) {
    try {
      if (!interaction.guild) return interaction.reply('Use !perms in a server.');
      const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
      await interaction.reply({ embeds: [buildReport(interaction.guild, botMember)] });
    } catch (error) {
      logger.error('Prefix perms command error:', error);
      await interaction.channel.send('Could not check bot permissions. Make sure the bot can view this channel and send messages.').catch(() => {});
    }
  },

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        return InteractionHelper.safeReply(interaction, { content: 'Use this command inside a server.', flags: MessageFlags.Ephemeral });
      }
      const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
      return InteractionHelper.safeReply(interaction, { embeds: [buildReport(interaction.guild, botMember)], flags: MessageFlags.Ephemeral });
    } catch (error) {
      logger.error('Slash perms command error:', error);
      return InteractionHelper.safeReply(interaction, { content: 'Could not check bot permissions. Make sure the bot can view this channel and send messages.', flags: MessageFlags.Ephemeral });
    }
  },
};
