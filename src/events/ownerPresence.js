// Bot-owner chat commands to change the bot's status and activity.
//
//   !status online | idle (or sleep) | dnd (or busy) | invisible
//   !activity playing|watching|listening|competing|custom <text>
//   !activity clear
//   !presence            -> show the current status/activity
//   !presence reset      -> go back to the default from the config file
//
// Only IDs listed in OWNER_IDS can use these. (Replace "!" with your server's prefix.)

import { Events } from 'discord.js';
import config from '../config/application.js';
import { getCommandPrefix, isBotOwner } from '../config/bot.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import {
    ACTIVITY_TYPES,
    MAX_ACTIVITY_LENGTH,
    STATUS_LABELS,
    describePresence,
    getSavedPresence,
    resetBotPresence,
    resolveStatus,
    setBotActivity,
    setBotStatus,
} from '../services/botPresenceService.js';
import { logger } from '../utils/logger.js';

const COMMANDS = new Set(['status', 'activity', 'presence']);

export default {
    name: Events.MessageCreate,
    async execute(message, client) {
        try {
            if (message.author.bot || !message.guild || !message.content) return;

            const guildConfig = await getGuildConfig(client, message.guild.id).catch(() => null);
            const prefix = guildConfig?.prefix || getCommandPrefix();
            if (!prefix || !message.content.startsWith(prefix)) return;

            const body = message.content.slice(prefix.length).trim();
            const [rawName, ...args] = body.split(/\s+/);
            const name = (rawName || '').toLowerCase();
            if (!COMMANDS.has(name) || client.commands?.has(name)) return;

            if (!isBotOwner(message.author.id)) return; // silently ignore everyone else

            const reply = (text) => message.reply({ content: text, allowedMentions: { parse: [], repliedUser: false } });
            const defaults = config.bot.presence;

            if (name === 'status') {
                const status = resolveStatus(args[0]);
                if (!status) {
                    return reply(`Usage: \`${prefix}status online | idle | dnd | invisible\`\n(\`sleep\` = idle, \`busy\` = dnd)`);
                }
                await setBotStatus(client, status);
                return reply(`Status set to **${STATUS_LABELS[status]}**.`);
            }

            if (name === 'activity') {
                const kind = (args[0] || '').toLowerCase();

                if (kind === 'clear' || kind === 'off' || kind === 'none') {
                    await setBotActivity(client, null);
                    return reply('Activity cleared.');
                }

                const text = args.slice(1).join(' ').trim();
                if (!ACTIVITY_TYPES[kind] || !text) {
                    return reply(
                        `Usage: \`${prefix}activity playing|watching|listening|competing|custom <text>\`\n` +
                        `Example: \`${prefix}activity watching over the server\`\nTo remove it: \`${prefix}activity clear\``,
                    );
                }
                if (text.length > MAX_ACTIVITY_LENGTH) {
                    return reply(`That text is too long (max ${MAX_ACTIVITY_LENGTH} characters).`);
                }

                await setBotActivity(client, { kind, text });
                const info = ACTIVITY_TYPES[kind];
                return reply(`Activity set to **${info.label ? `${info.label} ` : ''}${text}**.`);
            }

            // !presence
            if ((args[0] || '').toLowerCase() === 'reset') {
                await resetBotPresence(client, defaults);
                return reply('Status and activity reset to the defaults from the config file.');
            }
            const current = describePresence(await getSavedPresence(client), defaults);
            return reply(`**Status:** ${current.status}\n**Activity:** ${current.activity}`);
        } catch (error) {
            logger.error('Error in owner presence handler:', error);
        }
    },
};
