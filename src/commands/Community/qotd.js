import { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { setupQotd, postQotdNow, getQotdStatus } from '../../services/qotdService.js';

export default {
  category: 'Community',
  data: new SlashCommandBuilder()
    .setName('qotd')
    .setDescription('Configure and manage the family-friendly Question of the Day')
    .addSubcommand((sub) => sub.setName('setup').setDescription('Set the daily question channel, winner role and time')
      .addChannelOption((option) => option.setName('channel').setDescription('Where daily questions should be posted').addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addRoleOption((option) => option.setName('winner_role').setDescription('Role given to the first correct answer for 24 hours').setRequired(true))
      .addStringOption((option) => option.setName('time').setDescription('Daily time in 24-hour IST, for example 18:30').setRequired(true))
      .addIntegerOption((option) => option.setName('max_difficulty').setDescription('Maximum difficulty from 1 to 4; source limits actual questions to easy/medium').setMinValue(1).setMaxValue(4).setRequired(false)))
    .addSubcommand((sub) => sub.setName('status').setDescription('Show the current QOTD settings'))
    .addSubcommand((sub) => sub.setName('post').setDescription('Post a fresh question now (admin only)')),

  async execute(interaction) {
    if (!interaction.guild) return interaction.reply({ content: 'QOTD can only be used in a server.', flags: MessageFlags.Ephemeral });
    const subcommand = interaction.options.getSubcommand();
    const admin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
      || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (subcommand !== 'status' && !admin) return interaction.reply({ content: 'You need Manage Server or Administrator permission to change QOTD settings.', flags: MessageFlags.Ephemeral });

    try {
      if (subcommand === 'setup') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await setupQotd(interaction.client, interaction.guildId, {
          channelId: interaction.options.getChannel('channel').id,
          roleId: interaction.options.getRole('winner_role').id,
          time: interaction.options.getString('time'),
          maxDifficulty: interaction.options.getInteger('max_difficulty') ?? 2,
        });
        return interaction.editReply(`✅ QOTD enabled. Daily questions will post at **${result.time} IST** in <#${interaction.options.getChannel('channel').id}>. Winner role: <@&${interaction.options.getRole('winner_role').id}>. Questions are limited to easy/medium (actual difficulty 1–2/4) for an all-ages server.`);
      }
      if (subcommand === 'post') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await postQotdNow(interaction.client, interaction.guild);
        return interaction.editReply('✅ Posted a fresh QOTD question.');
      }
      const status = await getQotdStatus(interaction.client, interaction.guildId);
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: [
        `**QOTD:** ${status.enabled ? 'Enabled' : 'Not configured'}`,
        `**Channel:** ${status.channelId ? `<#${status.channelId}>` : 'Not set'}`,
        `**Winner role:** ${status.roleId ? `<@&${status.roleId}>` : 'Not set'}`,
        `**Daily time:** ${status.time} ${status.timeZone}`,
        '**Difficulty:** Easy to medium only (1–2/4)',
        `**Question active:** ${status.hasActiveQuestion ? 'Yes' : 'No'}`,
        `**Last posted:** ${status.lastPostedDate || 'Never'}`,
      ].join('\n') });
    } catch (error) {
      const message = `❌ ${error.message || 'Could not complete the QOTD action.'}`;
      if (interaction.deferred || interaction.replied) return interaction.editReply(message);
      return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
  },
};
