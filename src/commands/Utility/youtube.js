import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { addSubscription, listSubscriptions, removeSubscription, setDestination } from '../../services/youtubeNotifierService.js';
import { isBotOwner } from '../../config/bot.js';

export default {
  data: new SlashCommandBuilder()
    .setName('youtube')
    .setDescription('Manage YouTube upload notifications for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName('set-channel').setDescription('Choose the Discord channel for all YouTube alerts').addChannelOption(o => o.setName('channel').setDescription('Discord channel for notifications').setRequired(true)))
    .addSubcommand(s => s.setName('add').setDescription('Subscribe to a YouTube channel').addStringOption(o => o.setName('channel').setDescription('YouTube channel URL or UC… channel ID').setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription('Unsubscribe from a YouTube channel').addStringOption(o => o.setName('channel_id').setDescription('UC… channel ID to remove').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('Show subscribed YouTube channels and alert destination')),

  async execute(interaction) {
    if (!interaction.guildId) return interaction.reply({ content: 'Use this command inside your Discord server.', ephemeral: true });
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) && !isBotOwner(interaction.user.id)) {
      return interaction.reply({ content: 'You need **Manage Server** permission to configure YouTube notifications.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();
    try {
      if (sub === 'set-channel') {
        const channel = interaction.options.getChannel('channel');
        if (!channel.isTextBased?.() || !channel.send) return interaction.editReply('Choose a text channel where the bot can send messages.');
        await setDestination(interaction.guildId, channel.id);
        return interaction.editReply(`YouTube notifications will be posted in ${channel}. Add channels with **/youtube add**.`);
      }
      if (sub === 'add') {
        const input = interaction.options.getString('channel', true);
        const { resolveYouTubeChannel } = await import('../../services/youtubeNotifierService.js');
        const channelId = await resolveYouTubeChannel(input);
        const result = await addSubscription(interaction.guildId, channelId);
        return interaction.editReply(result.added ? `Subscribed to **${result.channelTitle}** (\`${channelId}\`). New uploads will be checked automatically.` : `That channel is already subscribed (\`${channelId}\`).`);
      }
      if (sub === 'remove') {
        const channelId = interaction.options.getString('channel_id', true).trim();
        const removed = await removeSubscription(interaction.guildId, channelId);
        return interaction.editReply(removed ? `Removed YouTube channel \`${channelId}\`.` : `I couldn't find \`${channelId}\` in this server's subscriptions.`);
      }
      const data = listSubscriptions(interaction.guildId);
      const destination = data.destinationChannelId ? `<#${data.destinationChannelId}>` : '**not set** (use `/youtube set-channel`)';
      const list = data.subscriptions.length ? data.subscriptions.map(s => `• **${s.channelTitle || s.channelId}** — \`${s.channelId}\``).join('\n') : 'No channels subscribed yet.';
      return interaction.editReply(`**Alert destination:** ${destination}\n\n**Subscribed channels (${data.subscriptions.length}):**\n${list}`);
    } catch (error) {
      return interaction.editReply(`Couldn't complete that action: ${error.message}\n\nFor best results, use a YouTube channel URL or its channel ID beginning with \`UC\`.`);
    }
  }
};
