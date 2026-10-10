// "!perms" - lists the permissions the bot needs (so the server owner does not have to give Administrator)
// and shows which of them the bot currently has in this server.

import { Events, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { getCommandPrefix, isBotOwner } from '../config/bot.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { createEmbed } from '../utils/embeds.js';
import { logger } from '../utils/logger.js';

const F = PermissionFlagsBits;

// Based on the permissions the bot's commands and features actually use.
const GROUPS = [
    {
        title: 'Essential (the bot will not work properly without these)',
        items: [
            [F.ViewChannel, 'View Channels', 'see channels and messages'],
            [F.SendMessages, 'Send Messages', 'reply to commands'],
            [F.EmbedLinks, 'Embed Links', 'embeds and link previews'],
            [F.ReadMessageHistory, 'Read Message History', 'prefix commands, leveling, TTS'],
        ],
    },
    {
        title: 'Recommended',
        items: [
            [F.AttachFiles, 'Attach Files', 'images and exports'],
            [F.AddReactions, 'Add Reactions', 'polls and reaction features'],
            [F.UseExternalEmojis, 'Use External Emojis', 'custom emojis in messages'],
            [F.SendMessagesInThreads, 'Send Messages in Threads', 'replies inside threads'],
        ],
    },
    {
        title: 'Moderation',
        items: [
            [F.KickMembers, 'Kick Members', 'kick / masskick'],
            [F.BanMembers, 'Ban Members', 'ban / unban / massban'],
            [F.ModerateMembers, 'Moderate Members', 'timeout / untimeout'],
            [F.ManageMessages, 'Manage Messages', 'purge and message cleanup'],
        ],
    },
    {
        title: 'Channels, roles and tickets',
        items: [
            [F.ManageChannels, 'Manage Channels', 'tickets, lock/unlock, join-to-create, server stats'],
            [F.ManageRoles, 'Manage Roles', 'autorole, reaction roles, verification, level roles, ticket permissions'],
        ],
    },
    {
        title: 'Voice (music and TTS)',
        items: [
            [F.Connect, 'Connect', 'join voice channels'],
            [F.Speak, 'Speak', 'play music and text-to-speech'],
            [F.MoveMembers, 'Move Members', 'join-to-create channels'],
        ],
    },
    {
        title: 'Optional',
        items: [[F.MentionEveryone, 'Mention Everyone', 'YouTube notifications that ping a role that is not mentionable']],
    },
];

const ALL_BITS = GROUPS.flatMap((group) => group.items.map(([flag]) => flag)).reduce((total, flag) => total | flag, 0n);

export default {
    name: Events.MessageCreate,
    async execute(message, client) {
        try {
            if (message.author.bot || !message.guild || !message.content) return;

            const guildConfig = await getGuildConfig(client, message.guild.id).catch(() => null);
            const prefix = guildConfig?.prefix || getCommandPrefix();
            if (message.content.trim().toLowerCase() !== `${prefix}perms`) return;

            const member = message.member;
            const allowed = isBotOwner(message.author.id)
                || member?.permissions?.has(PermissionFlagsBits.ManageGuild)
                || member?.permissions?.has(PermissionFlagsBits.Administrator);
            if (!allowed) {
                await message.reply('You need the **Manage Server** permission to use this command.');
                return;
            }

            const me = message.guild.members.me || (await message.guild.members.fetchMe().catch(() => null));
            const botPermissions = me?.permissions ?? new PermissionsBitField();
            const isAdmin = botPermissions.has(PermissionFlagsBits.Administrator);

            let missing = 0;
            const fields = GROUPS.map((group) => {
                const lines = group.items.map(([flag, name, why]) => {
                    const has = isAdmin || botPermissions.has(flag);
                    if (!has) missing += 1;
                    return `${has ? '`OK`     ' : '`MISSING`'} **${name}** — ${why}`;
                });
                return { name: group.title, value: lines.join('\n'), inline: false };
            });

            const invite = `https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot%20applications.commands&permissions=${ALL_BITS}`;

            const status = isAdmin
                ? 'The bot currently has **Administrator**, so every permission below is covered. You can safely replace it with just these.'
                : missing === 0
                    ? 'The bot has every permission it needs in this server.'
                    : `The bot is missing **${missing}** permission${missing === 1 ? '' : 's'} (marked \`MISSING\`).`;

            fields.push(
                {
                    name: 'Invite without Administrator',
                    value: `[Re-invite with exactly these permissions](${invite})\nOr tick them yourself on the bot's role in **Server Settings → Roles**.`,
                    inline: false,
                },
                {
                    name: 'Also remember',
                    value: [
                        '• Put the bot\'s role **above** any role it should give or manage.',
                        '• Channel permission overrides can still block the bot in specific channels.',
                    ].join('\n'),
                    inline: false,
                },
            );

            await message.reply({
                embeds: [createEmbed({ title: 'Permissions the bot needs', description: status, color: missing === 0 ? 'success' : 'warning', fields })],
                allowedMentions: { repliedUser: false },
            });
        } catch (error) {
            logger.error('Error in !perms handler:', error);
        }
    },
};
