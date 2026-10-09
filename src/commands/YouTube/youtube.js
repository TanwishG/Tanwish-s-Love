/**
 * /youtube command
 *
 * Subcommands:
 *   - dashboard  — open the interactive YouTube notifier dashboard (ManageGuild)
 *   - add        — quick-add a subscription (ManageGuild)
 *   - remove     — quick-remove a subscription (ManageGuild)
 *   - list       — list current subscriptions (ManageGuild)
 */

import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
    EmbedBuilder,
} from 'discord.js';
import { getColor } from '../../config/bot.js';
import { successEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError, replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { isBotOwner } from '../../config/bot.js';
import {
    loadYouTubeConfig,
    saveYouTubeConfig,
    resolveYouTubeChannel,
} from '../../services/youtubeNotifierService.js';
import youtubeDashboard from './modules/youtube_dashboard.js';

export default {
    data: new SlashCommandBuilder()
        .setName('youtube')
        .setDescription('Manage YouTube upload notifications.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((sub) =>
            sub
                .setName('dashboard')
                .setDescription('Open the YouTube notifier dashboard.'),
        )
        .addSubcommand((sub) =>
            sub
                .setName('add')
                .setDescription('Add a YouTube channel subscription.')
                .addStringOption((opt) =>
                    opt
                        .setName('channel')
                        .setDescription('YouTube channel handle (@MrBeast), ID, or username.')
                        .setRequired(true),
                )
                .addChannelOption((opt) =>
                    opt
                        .setName('notify_channel')
                        .setDescription('Discord channel to send notifications to.')
                        .setRequired(true),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('remove')
                .setDescription('Remove a YouTube channel subscription.')
                .addStringOption((opt) =>
                    opt
                        .setName('channel_id')
                        .setDescription('YouTube channel ID to remove (UCxxxxxxxxxx).')
                        .setRequired(true),
                ),
        )
        .addSubcommand((sub) =>
            sub.setName('list').setDescription('List all current YouTube subscriptions.'),
        ),

    category: 'YouTube',

    async execute(interaction, config, client) {
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        // Permission check — bot owner bypasses
        if (
            !isBotOwner(interaction.user.id) &&
            !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)
        ) {
            return replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: 'You need the **Manage Server** permission to use this command.',
            });
        }

        const subcommand = interaction.options.getSubcommand();

        try {
            if (subcommand === 'dashboard') {
                return youtubeDashboard.execute(interaction, config, client);
            }

            if (subcommand === 'list') {
                return handleList(interaction, client);
            }

            if (subcommand === 'add') {
                return handleAdd(interaction, client);
            }

            if (subcommand === 'remove') {
                return handleRemove(interaction, client);
            }
        } catch (error) {
            logger.error('[YouTube Command] Error:', error);
            await handleInteractionError(interaction, error, {
                commandName: `youtube ${subcommand}`,
                source: 'youtube_command',
            });
        }
    },
};

// ─── Subcommand handlers ──────────────────────────────────────────────────────

async function handleList(interaction, client) {
    const ytConfig = await loadYouTubeConfig(client, interaction.guildId);
    const subs = ytConfig.subscriptions || [];

    if (!subs.length) {
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [
                new EmbedBuilder()
                    .setTitle('📺 YouTube Subscriptions')
                    .setDescription('No subscriptions set up yet.\nUse `/youtube add` or `/youtube dashboard` to get started.')
                    .setColor(0xFF0000),
            ],
        });
    }

    const lines = subs.map((s, i) => {
        const ch = s.notifyChannelId ? `<#${s.notifyChannelId}>` : '`None`';
        return `**${i + 1}.** [${s.channelTitle || s.channelId}](https://youtube.com/channel/${s.channelId}) → ${ch}`;
    });

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [
            new EmbedBuilder()
                .setTitle(`📺 YouTube Subscriptions (${subs.length})`)
                .setDescription(lines.join('\n'))
                .setColor(0xFF0000)
                .setFooter({ text: 'Use /youtube dashboard to manage subscriptions interactively.' }),
        ],
    });
}

async function handleAdd(interaction, client) {
    const channelInput = interaction.options.getString('channel');
    const notifyChannel = interaction.options.getChannel('notify_channel');
    const apiKey = process.env.YOUTUBE_API_KEY;

    if (!apiKey) {
        return replyUserError(interaction, {
            type: ErrorTypes.CONFIGURATION,
            message: '`YOUTUBE_API_KEY` is not set in the bot environment. Contact your bot host.',
        });
    }

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [
            new EmbedBuilder()
                .setDescription('🔍 Looking up YouTube channel…')
                .setColor(getColor('info')),
        ],
    });

    const channelInfo = await resolveYouTubeChannel(channelInput, apiKey);

    if (!channelInfo) {
        return replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: `Could not find a YouTube channel for **${channelInput}**.\nTry using the channel ID (starts with \`UC…\`) or handle (e.g. \`@MrBeast\`).`,
        });
    }

    const ytConfig = await loadYouTubeConfig(client, interaction.guildId);
    if (!ytConfig.subscriptions) ytConfig.subscriptions = [];

    const duplicate = ytConfig.subscriptions.find((s) => s.channelId === channelInfo.id);
    if (duplicate) {
        return replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: `**${channelInfo.title}** is already subscribed in this server.`,
        });
    }

    ytConfig.subscriptions.push({
        channelId: channelInfo.id,
        channelTitle: channelInfo.title,
        thumbnail: channelInfo.thumbnail,
        notifyChannelId: notifyChannel.id,
        customMessage: null,
    });

    await saveYouTubeConfig(client, interaction.guildId, ytConfig);

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [
            successEmbed(
                '✅ Subscription Added',
                `Now tracking **[${channelInfo.title}](https://youtube.com/channel/${channelInfo.id})**.\nNotifications → ${notifyChannel}`,
            ),
        ],
    });
}

async function handleRemove(interaction, client) {
    const channelId = interaction.options.getString('channel_id').trim();
    const ytConfig = await loadYouTubeConfig(client, interaction.guildId);
    const subs = ytConfig.subscriptions || [];
    const idx = subs.findIndex((s) => s.channelId === channelId || s.channelTitle?.toLowerCase() === channelId.toLowerCase());

    if (idx === -1) {
        return replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: `No subscription found for \`${channelId}\`. Use \`/youtube list\` to see your subscriptions.`,
        });
    }

    const removed = subs.splice(idx, 1)[0];
    ytConfig.subscriptions = subs;
    await saveYouTubeConfig(client, interaction.guildId, ytConfig);

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [
            successEmbed(
                '✅ Subscription Removed',
                `Removed **${removed.channelTitle || removed.channelId}** from the YouTube notifier.`,
            ),
        ],
    });
}
