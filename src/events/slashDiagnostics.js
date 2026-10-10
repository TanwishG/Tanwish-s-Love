// Owner-only chat commands to diagnose and repair slash commands without reading console logs.
//
//   !slashcheck   -> shows what Discord actually knows about this bot's slash commands
//   !slashhere    -> registers all slash commands in THIS server only (appears instantly)
//   !slashhere off-> removes the server-only copy again (use once global commands work)
//
// (Replace "!" with your server's prefix.)

import { Events, Routes } from 'discord.js';
import { getCommandPrefix, isBotOwner } from '../config/bot.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { getRegistrationPayload } from '../handlers/loaders/commandLoader.js';
import { logger } from '../utils/logger.js';

const TIMEOUT_MS = 20_000;

function withTimeout(promise, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label}: Discord did not answer within ${TIMEOUT_MS / 1000}s (probably rate limited)`)), TIMEOUT_MS),
        ),
    ]);
}

function describeError(error) {
    if (error?.status === 403 || error?.code === 50001) {
        return 'MISSING ACCESS (403) - the bot was invited to this server without the "applications.commands" permission';
    }
    return `${error?.message || error}${error?.code ? ` (code ${error.code})` : ''}`;
}

const inviteLink = (id) => `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot%20applications.commands&permissions=8`;

export default {
    name: Events.MessageCreate,
    async execute(message, client) {
        try {
            if (message.author.bot || !message.guild || !message.content) return;

            const guildConfig = await getGuildConfig(client, message.guild.id).catch(() => null);
            const prefix = guildConfig?.prefix || getCommandPrefix();
            const text = message.content.trim().toLowerCase();
            const isCheck = text === `${prefix}slashcheck`;
            const isHere = text === `${prefix}slashhere` || text === `${prefix}slashhere off`;
            if (!isCheck && !isHere) return;

            if (!isBotOwner(message.author.id)) {
                await message.reply('Only the bot owner can use this command (set OWNER_IDS).');
                return;
            }

            const botId = client.user.id;
            const guildId = message.guild.id;
            const reply = (lines) => message.reply('```\n' + lines.join('\n') + '\n```').catch(() => {});

            if (isCheck) {
                const lines = [`Bot: ${client.user.tag} (${botId})`];
                const configured = process.env.CLIENT_ID;
                lines.push(`CLIENT_ID setting: ${configured || '(not set)'}${configured && configured !== botId ? '  <-- DOES NOT MATCH the bot id!' : ''}`);
                lines.push(`Commands the bot has loaded: ${client.commands.size}`);

                try {
                    const global = await withTimeout(client.rest.get(Routes.applicationCommands(botId)), 'Global commands');
                    const names = new Set(global.map((c) => c.name));
                    lines.push(`Discord GLOBAL commands: ${global.length} (/commands: ${names.has('commands') ? 'yes' : 'NO'}, /tts: ${names.has('tts') ? 'yes' : 'NO'})`);
                } catch (error) {
                    lines.push(`Discord GLOBAL commands: could not read -> ${describeError(error)}`);
                }

                try {
                    const local = await withTimeout(client.rest.get(Routes.applicationGuildCommands(botId, guildId)), 'Server commands');
                    lines.push(`Commands registered for THIS server only: ${local.length}`);
                    lines.push('This server permission check: OK (bot can use slash commands here)');
                } catch (error) {
                    lines.push(`This server permission check: FAILED -> ${describeError(error)}`);
                    lines.push(`Fix: open ${inviteLink(botId)}`);
                }

                lines.push('');
                lines.push(`Next: "${prefix}slashhere" makes the commands appear in this server instantly.`);
                await reply(lines);
                return;
            }

            // !slashhere / !slashhere off
            const remove = text.endsWith(' off');
            try {
                const body = remove ? [] : getRegistrationPayload(client);
                await message.reply(remove ? 'Removing the server-only commands...' : `Registering ${body.length} commands in this server...`);
                await withTimeout(client.rest.put(Routes.applicationGuildCommands(botId, guildId), { body }), 'Registration');
                await reply(remove
                    ? ['Done. Server-only commands removed.']
                    : [`Done. ${body.length} slash commands registered for this server.`, 'Press Ctrl+R in Discord, then type / to see them.', `Later, when global commands work, run "${prefix}slashhere off" to avoid duplicates.`]);
            } catch (error) {
                logger.warn(`slashhere failed: ${describeError(error)}`);
                const lines = [`Failed: ${describeError(error)}`];
                if (error?.status === 403 || error?.code === 50001) lines.push(`Fix: open ${inviteLink(botId)} and authorize this server again.`);
                await reply(lines);
            }
        } catch (error) {
            logger.error('Slash diagnostics error:', error);
        }
    },
};
