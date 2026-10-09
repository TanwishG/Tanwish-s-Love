/**
 * YouTube Notifier Dashboard module.
 * Handles the interactive dashboard for /youtube dashboard subcommand.
 */

import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ChannelSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    MessageFlags,
    ComponentType,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { getColor } from '../../../config/bot.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { successEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { TitanBotError, ErrorTypes, replyUserError } from '../../../utils/errorHandler.js';
import { startDashboardSession } from '../../../utils/dashboardSession.js';
import {
    loadYouTubeConfig,
    saveYouTubeConfig,
    resolveYouTubeChannel,
} from '../../../services/youtubeNotifierService.js';

// ─── Embed builders ───────────────────────────────────────────────────────────

function buildDashboardEmbed(config, guild) {
    const subs = config.subscriptions || [];
    const apiKeySet = Boolean(process.env.YOUTUBE_API_KEY);

    const subLines = subs.length
        ? subs.map((s, i) => {
            const ch = s.notifyChannelId ? `<#${s.notifyChannelId}>` : '`Not set`';
            return `**${i + 1}.** ${s.channelTitle || s.channelId} → ${ch}`;
        }).join('\n')
        : '`No subscriptions set up yet.`';

    return new EmbedBuilder()
        .setTitle('📺 YouTube Notifier Dashboard')
        .setDescription(`Manage YouTube upload notifications for **${guild.name}**.\n\nWhen a subscribed channel uploads a video, a notification is sent to the configured channel.`)
        .setColor(0xFF0000)
        .addFields(
            {
                name: 'API Key Status',
                value: apiKeySet ? '✅ `YOUTUBE_API_KEY` is set' : '❌ `YOUTUBE_API_KEY` not set in environment',
                inline: false,
            },
            {
                name: `Subscriptions (${subs.length})`,
                value: subLines,
                inline: false,
            },
        )
        .setFooter({ text: 'Dashboard closes after 10 minutes of inactivity' })
        .setTimestamp();
}

function buildSelectMenu(guildId, hasSubs) {
    const options = [
        new StringSelectMenuOptionBuilder()
            .setLabel('Add Subscription')
            .setDescription('Subscribe to a YouTube channel and pick a notification channel')
            .setValue('add_sub')
            .setEmoji('➕'),
    ];

    if (hasSubs) {
        options.push(
            new StringSelectMenuOptionBuilder()
                .setLabel('Remove Subscription')
                .setDescription('Remove a YouTube channel subscription')
                .setValue('remove_sub')
                .setEmoji('🗑️'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Edit Custom Message')
                .setDescription('Customise the notification message for a subscription')
                .setValue('edit_message')
                .setEmoji('✏️'),
        );
    }

    return new StringSelectMenuBuilder()
        .setCustomId(`yt_dash_${guildId}`)
        .setPlaceholder('Select an action…')
        .addOptions(options);
}

async function refreshDashboard(rootInteraction, config, guildId) {
    const embed = buildDashboardEmbed(config, rootInteraction.guild);
    const hasSubs = (config.subscriptions || []).length > 0;
    const selectRow = new ActionRowBuilder().addComponents(buildSelectMenu(guildId, hasSubs));
    await InteractionHelper.safeEditReply(rootInteraction, {
        embeds: [embed],
        components: [selectRow],
    }).catch(() => {});
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleAddSub(selectInteraction, rootInteraction, config, guildId, client) {
    // Step 1 — ask for YT channel via modal
    const modal = new ModalBuilder()
        .setCustomId('yt_add_sub_modal')
        .setTitle('📺 Add YouTube Subscription')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('yt_channel_input')
                    .setLabel('YouTube Channel (handle, ID, or username)')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('@MrBeast  or  UCX6OQ3DkcsbYNE6H8uQQuVA')
                    .setRequired(true)
                    .setMaxLength(100),
            ),
        );

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: (i) => i.customId === 'yt_add_sub_modal' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    await submitted.deferReply({ flags: MessageFlags.Ephemeral });

    const rawInput = submitted.fields.getTextInputValue('yt_channel_input').trim();
    const apiKey = process.env.YOUTUBE_API_KEY;

    if (!apiKey) {
        await replyUserError(submitted, {
            type: ErrorTypes.CONFIGURATION,
            message: '`YOUTUBE_API_KEY` is not set in the environment. Ask your bot host to add it.',
        });
        return;
    }

    const channelInfo = await resolveYouTubeChannel(rawInput, apiKey);

    if (!channelInfo) {
        await replyUserError(submitted, {
            type: ErrorTypes.VALIDATION,
            message: `Could not find a YouTube channel for **${rawInput}**. Try using the channel ID (starts with \`UC…\`) or the handle (e.g. \`@MrBeast\`).`,
        });
        return;
    }

    // Check for duplicate
    const existing = (config.subscriptions || []).find((s) => s.channelId === channelInfo.id);
    if (existing) {
        await replyUserError(submitted, {
            type: ErrorTypes.VALIDATION,
            message: `**${channelInfo.title}** is already subscribed in this server.`,
        });
        return;
    }

    // Step 2 — pick Discord notification channel
    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('yt_notify_channel_select')
        .setPlaceholder('Select the Discord channel to send notifications to…')
        .addChannelTypes(ChannelType.GuildText)
        .setMaxValues(1);

    await submitted.editReply({
        embeds: [
            new EmbedBuilder()
                .setTitle('📺 Select Notification Channel')
                .setDescription(`Found **${channelInfo.title}**!\n\nNow pick the Discord channel where upload notifications will be posted.`)
                .setThumbnail(channelInfo.thumbnail)
                .setColor(0xFF0000),
        ],
        components: [new ActionRowBuilder().addComponents(channelSelect)],
    });

    const collector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.ChannelSelect,
        filter: (i) => i.user.id === selectInteraction.user.id && i.customId === 'yt_notify_channel_select',
        time: 60_000,
        max: 1,
    });

    collector.on('collect', async (channelInteraction) => {
        await channelInteraction.deferUpdate();
        const discordChannel = channelInteraction.channels.first();

        if (!config.subscriptions) config.subscriptions = [];
        config.subscriptions.push({
            channelId: channelInfo.id,
            channelTitle: channelInfo.title,
            thumbnail: channelInfo.thumbnail,
            notifyChannelId: discordChannel.id,
            customMessage: null,
        });

        await saveYouTubeConfig(client, guildId, config);

        await submitted.editReply({
            embeds: [
                successEmbed(
                    '✅ Subscription Added',
                    `Now tracking **${channelInfo.title}** — notifications will go to ${discordChannel}.`,
                ),
            ],
            components: [],
        });

        await refreshDashboard(rootInteraction, config, guildId);
    });

    collector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            submitted.editReply({ content: 'Timed out. No channel was selected.', components: [] }).catch(() => {});
        }
    });
}

async function handleRemoveSub(selectInteraction, rootInteraction, config, guildId, client) {
    const subs = config.subscriptions || [];
    if (!subs.length) {
        await replyUserError(selectInteraction, { type: ErrorTypes.VALIDATION, message: 'No subscriptions to remove.' });
        return;
    }

    await selectInteraction.deferUpdate();

    const removeSelect = new StringSelectMenuBuilder()
        .setCustomId('yt_remove_select')
        .setPlaceholder('Select a subscription to remove…')
        .addOptions(
            subs.slice(0, 25).map((s, i) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(`${i + 1}. ${s.channelTitle || s.channelId}`)
                    .setDescription(s.notifyChannelId ? `Notify: #${s.notifyChannelId}` : 'No notify channel')
                    .setValue(s.channelId)
                    .setEmoji('🗑️'),
            ),
        );

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('🗑️ Remove Subscription')
                .setDescription('Select the YouTube channel subscription to remove.')
                .setColor(getColor('error')),
        ],
        components: [new ActionRowBuilder().addComponents(removeSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const collector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: (i) => i.user.id === selectInteraction.user.id && i.customId === 'yt_remove_select',
        time: 60_000,
        max: 1,
    });

    collector.on('collect', async (removeInteraction) => {
        await removeInteraction.deferUpdate();
        const targetId = removeInteraction.values[0];
        const removed = config.subscriptions.find((s) => s.channelId === targetId);
        config.subscriptions = config.subscriptions.filter((s) => s.channelId !== targetId);
        await saveYouTubeConfig(client, guildId, config);

        await removeInteraction.followUp({
            embeds: [successEmbed('✅ Subscription Removed', `Removed **${removed?.channelTitle || targetId}** from the notifier.`)],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, config, guildId);
    });
}

async function handleEditMessage(selectInteraction, rootInteraction, config, guildId, client) {
    const subs = config.subscriptions || [];
    if (!subs.length) {
        await replyUserError(selectInteraction, { type: ErrorTypes.VALIDATION, message: 'No subscriptions to edit.' });
        return;
    }

    await selectInteraction.deferUpdate();

    const editSelect = new StringSelectMenuBuilder()
        .setCustomId('yt_edit_msg_select')
        .setPlaceholder('Pick a subscription to customise…')
        .addOptions(
            subs.slice(0, 25).map((s) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(s.channelTitle || s.channelId)
                    .setValue(s.channelId)
                    .setEmoji('✏️'),
            ),
        );

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('✏️ Edit Notification Message')
                .setDescription('Select which subscription\'s message you want to customise.\n\nAvailable placeholders: `{channel}` `{title}` `{url}`')
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(editSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const pickCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: (i) => i.user.id === selectInteraction.user.id && i.customId === 'yt_edit_msg_select',
        time: 60_000,
        max: 1,
    });

    pickCollector.on('collect', async (pickInteraction) => {
        const targetId = pickInteraction.values[0];
        const sub = config.subscriptions.find((s) => s.channelId === targetId);

        const modal = new ModalBuilder()
            .setCustomId('yt_edit_msg_modal')
            .setTitle(`✏️ Edit Message for ${sub.channelTitle || targetId}`)
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('yt_msg_input')
                        .setLabel('Notification Message (leave blank for default)')
                        .setStyle(TextInputStyle.Paragraph)
                        .setValue(sub.customMessage || '')
                        .setMaxLength(1000)
                        .setRequired(false)
                        .setPlaceholder('{channel} just uploaded: {title}\n{url}'),
                ),
            );

        await pickInteraction.showModal(modal);

        const submitted = await pickInteraction
            .awaitModalSubmit({
                filter: (i) => i.customId === 'yt_edit_msg_modal' && i.user.id === selectInteraction.user.id,
                time: 120_000,
            })
            .catch(() => null);

        if (!submitted) return;

        const newMsg = submitted.fields.getTextInputValue('yt_msg_input').trim() || null;
        sub.customMessage = newMsg;
        await saveYouTubeConfig(client, guildId, config);

        await submitted.reply({
            embeds: [
                successEmbed(
                    '✅ Message Updated',
                    newMsg
                        ? `Custom message for **${sub.channelTitle}** set to:\n\`\`\`${newMsg}\`\`\``
                        : `Custom message for **${sub.channelTitle}** cleared — default will be used.`,
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, config, guildId);
    });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export default {
    async execute(interaction, _config, client) {
        try {
            const guildId = interaction.guild.id;
            const youtubeConfig = await loadYouTubeConfig(client, guildId);
            const hasSubs = (youtubeConfig.subscriptions || []).length > 0;

            const embed = buildDashboardEmbed(youtubeConfig, interaction.guild);
            const selectRow = new ActionRowBuilder().addComponents(buildSelectMenu(guildId, hasSubs));

            await startDashboardSession({
                interaction,
                embeds: [embed],
                components: [selectRow],
                selectMenuId: `yt_dash_${guildId}`,
                onSelect: async (selectInteraction) => {
                    const val = selectInteraction.values[0];
                    if (val === 'add_sub') {
                        await handleAddSub(selectInteraction, interaction, youtubeConfig, guildId, client);
                    } else if (val === 'remove_sub') {
                        await handleRemoveSub(selectInteraction, interaction, youtubeConfig, guildId, client);
                    } else if (val === 'edit_message') {
                        await handleEditMessage(selectInteraction, interaction, youtubeConfig, guildId, client);
                    }
                },
            });
        } catch (error) {
            if (error instanceof TitanBotError) throw error;
            logger.error('[YouTube] Dashboard error:', error);
            throw new TitanBotError(
                `YouTube dashboard failed: ${error.message}`,
                ErrorTypes.UNKNOWN,
                'Failed to open the YouTube notifier dashboard.',
            );
        }
    },
};
