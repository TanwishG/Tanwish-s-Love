import { Events } from 'discord.js';
import { getCommandPrefix } from '../config/bot.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { getCustomCommands, renderCustomResponse } from '../services/customCommandService.js';
import { logger } from '../utils/logger.js';

const COOLDOWN_MS = 4_000;
const lastUsed = new Map();

export default {
    name: Events.MessageCreate,
    async execute(message, client) {
        try {
            if (message.author.bot || message.webhookId || !message.guild || !message.content) return;

            const guildConfig = await getGuildConfig(client, message.guild.id).catch(() => null);
            const prefix = guildConfig?.prefix || getCommandPrefix();
            if (!prefix || !message.content.startsWith(prefix)) return;

            const name = message.content.slice(prefix.length).trim().split(/\s+/)[0]?.toLowerCase();
            if (!name || client.commands?.has(name)) return; // built-in commands always win

            const custom = (await getCustomCommands(client, message.guild.id))[name];
            if (!custom) return;

            // Light spam protection: one answer per command per channel every few seconds.
            const key = `${message.channelId}:${name}`;
            if (Date.now() - (lastUsed.get(key) || 0) < COOLDOWN_MS) return;
            lastUsed.set(key, Date.now());

            await message.reply({
                content: renderCustomResponse(custom.response, message),
                // Never ping @everyone/@here/roles from a custom reply.
                allowedMentions: { parse: [], repliedUser: false },
            });
        } catch (error) {
            logger.error('Error in custom command handler:', error);
        }
    },
};
