import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { successEmbed, infoEmbed } from '../../utils/embeds.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { logEvent } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import {
    addBypassEntry,
    getAllBypass,
    mentionEntry,
    removeBypassEntry,
} from '../../services/lockBypassService.js';

const CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

function channelOption(option, required) {
    return option
        .setName('channel')
        .setDescription('The channel')
        .addChannelTypes(...CHANNEL_TYPES)
        .setRequired(required);
}

const targetOption = (option) =>
    option.setName('target').setDescription('The user or role').setRequired(true);

/** Works out whether the picked mentionable is a role or a user. */
function resolveTarget(interaction) {
    const picked = interaction.options.getMentionable('target', true);
    // The @everyone role always has the same id as the server.
    if (picked.id === interaction.guild.id) {
        return { id: picked.id, type: 'role', object: interaction.guild.roles.everyone, label: '@everyone' };
    }
    const role = interaction.guild.roles.cache.get(picked.id);
    if (role) return { id: role.id, type: 'role', object: role, label: role.toString() };

    const member = interaction.guild.members.cache.get(picked.id);
    const user = member?.user ?? picked.user ?? picked;
    return { id: picked.id, type: 'user', object: member ?? user, label: `<@${picked.id}>` };
}

function checkBotCanEdit(interaction, channel) {
    const me = interaction.guild.members.me;
    const needed = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageRoles,
    ];
    if (!channel.permissionsFor(me)?.has(needed)) {
        throw new TitanBotError(
            'Missing bot permissions',
            ErrorTypes.PERMISSION,
            `I need **View Channel, Send Messages, Manage Channels** and **Manage Roles** in ${channel} to change who can speak there.`,
        );
    }
}

export default {
    slashOnly: true,
    category: 'moderation',
    data: new SlashCommandBuilder()
        .setName('bypass')
        .setDescription('Let a user or role keep talking in a channel while it is locked')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
        .setDMPermission(false)
        .addSubcommand((sub) =>
            sub
                .setName('lock')
                .setDescription('Allow a user or role to speak in a channel even when it is locked')
                .addChannelOption((o) => channelOption(o, true))
                .addMentionableOption(targetOption),
        )
        .addSubcommand((sub) =>
            sub
                .setName('remove')
                .setDescription('Remove a lock bypass from a user or role')
                .addChannelOption((o) => channelOption(o, true))
                .addMentionableOption(targetOption),
        )
        .addSubcommand((sub) =>
            sub
                .setName('list')
                .setDescription('Show who can bypass the lock')
                .addChannelOption((o) => channelOption(o, false)),
        ),

    async execute(interaction, config, client) {
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guildId;
        const reply = (embed) => InteractionHelper.safeEditReply(interaction, { embeds: [embed] });

        if (sub === 'list') {
            const channel = interaction.options.getChannel('channel');
            const all = await getAllBypass(client, guildId);
            const channelIds = channel ? [channel.id] : Object.keys(all);

            const lines = [];
            for (const channelId of channelIds) {
                const entries = all[channelId] || [];
                if (entries.length === 0) continue;
                lines.push(`<#${channelId}>: ${entries.map(mentionEntry).join(', ')}`);
            }

            return reply(
                infoEmbed(
                    'Lock bypass',
                    lines.length
                        ? lines.join('\n').slice(0, 3900)
                        : channel
                            ? `Nobody can bypass the lock in ${channel}.`
                            : 'No lock bypasses are set in this server.',
                ),
            );
        }

        const channel = interaction.options.getChannel('channel', true);
        const target = resolveTarget(interaction);

        if (target.type === 'role' && target.id === interaction.guild.id) {
            throw new TitanBotError('Everyone role', ErrorTypes.USER_INPUT, 'That would unlock the channel for everyone. Use `/unlock` instead.');
        }
        if (target.type === 'user' && target.id === client.user.id) {
            throw new TitanBotError('Bot target', ErrorTypes.USER_INPUT, 'I don\'t need a bypass. Pick a person or a role.');
        }

        checkBotCanEdit(interaction, channel);

        try {
            if (sub === 'lock') {
                await channel.permissionOverwrites.edit(
                    target.object,
                    { SendMessages: true },
                    { reason: `Lock bypass added by ${interaction.user.tag}` },
                );
                const { added } = await addBypassEntry(client, guildId, channel.id, {
                    id: target.id,
                    type: target.type,
                    addedBy: interaction.user.id,
                });

                await logEvent({
                    client,
                    guild: interaction.guild,
                    event: {
                        action: 'Lock Bypass Added',
                        target: `${target.label} in ${channel}`,
                        executor: `${interaction.user.tag} (${interaction.user.id})`,
                        metadata: { channelId: channel.id, targetId: target.id, targetType: target.type },
                    },
                }).catch(() => {});

                const everyoneCanTalk = channel.permissionsFor(interaction.guild.roles.everyone)?.has(PermissionFlagsBits.SendMessages);
                return reply(
                    successEmbed(
                        added ? 'Lock bypass added' : 'Already set',
                        `${target.label} can speak in ${channel} even while it is locked.` +
                            (everyoneCanTalk ? '\nThe channel is not locked right now; this takes effect when you run `/lock`.' : ''),
                    ),
                );
            }

            // sub === 'remove'
            const wasListed = await removeBypassEntry(client, guildId, channel.id, target.id);

            await channel.permissionOverwrites.edit(
                target.object,
                { SendMessages: null },
                { reason: `Lock bypass removed by ${interaction.user.tag}` },
            );
            const overwrite = channel.permissionOverwrites.cache.get(target.id);
            if (overwrite && overwrite.allow.bitfield === 0n && overwrite.deny.bitfield === 0n) {
                await overwrite.delete(`Lock bypass removed by ${interaction.user.tag}`).catch(() => {});
            }

            await logEvent({
                client,
                guild: interaction.guild,
                event: {
                    action: 'Lock Bypass Removed',
                    target: `${target.label} in ${channel}`,
                    executor: `${interaction.user.tag} (${interaction.user.id})`,
                    metadata: { channelId: channel.id, targetId: target.id, targetType: target.type },
                },
            }).catch(() => {});

            return reply(
                successEmbed(
                    'Lock bypass removed',
                    wasListed
                        ? `${target.label} follows the normal rules in ${channel} again.`
                        : `${target.label} had no saved bypass in ${channel}, but I reset their "send messages" override anyway.`,
                ),
            );
        } catch (error) {
            if (error instanceof TitanBotError) throw error;
            logger.error('Bypass command error:', error);
            throw new TitanBotError(
                'Bypass failed',
                ErrorTypes.PERMISSION,
                'Discord refused that change. Make sure my role has Manage Channels and Manage Roles, and is not blocked in this channel.',
            );
        }

        throw new TitanBotError('Unknown subcommand', ErrorTypes.USER_INPUT, 'Unknown option.');
    },
};
