import { Events } from 'discord.js';
import { getCommandScope, registerCommandsForGuild } from '../handlers/loaders/commandLoader.js';
import { logger } from '../utils/logger.js';

// When the bot is added to a new server, give it the slash commands right away (scope "guild").
export default {
    name: Events.GuildCreate,
    async execute(guild, client) {
        // During startup the ready handler registers everything; only react to real joins.
        if (getCommandScope() !== 'guild' || !client.isReady?.()) return;
        try {
            const result = await registerCommandsForGuild(client, guild.id);
            logger.info(`Joined "${guild.name}": registered ${result.count} slash commands (${result.status})`);
        } catch (error) {
            logger.warn(`Could not register commands in new server "${guild.name}": ${error.message}`);
        }
    },
};
