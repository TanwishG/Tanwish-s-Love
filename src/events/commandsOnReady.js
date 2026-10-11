import { Events } from 'discord.js';
import { getCommandScope, registerCommandsForAllGuilds } from '../handlers/loaders/commandLoader.js';
import { logger } from '../utils/logger.js';

// Registers the slash commands in every server once the bot is ready (scope "guild").
export default {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        if (getCommandScope() !== 'guild') return;
        try {
            await registerCommandsForAllGuilds(client);
        } catch (error) {
            logger.error('Per-server command registration failed:', error);
        }
    },
};
