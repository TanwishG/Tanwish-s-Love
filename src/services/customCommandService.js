// Custom prefix commands: "!invite" -> a message chosen by the server.

import { getCustomCommandsKey } from '../utils/database/keys.js';
import { resolveCommandAlias } from '../config/commands/commandAliases.js';
import { logger } from '../utils/logger.js';

export const MAX_CUSTOM_COMMANDS = 50;
export const MAX_RESPONSE_LENGTH = 1800;
const NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;
const RESERVED = new Set(['perms', 'slashcheck', 'slashhere', 'help']);

const CACHE_TTL_MS = 30_000;
const cache = new Map();

export async function getCustomCommands(client, guildId) {
    const hit = cache.get(guildId);
    if (hit && hit.expires > Date.now()) return hit.commands;

    let commands = {};
    try {
        const stored = await client.db?.get(getCustomCommandsKey(guildId), null);
        if (stored?.commands && typeof stored.commands === 'object') commands = stored.commands;
    } catch (error) {
        logger.warn(`Custom commands: could not read guild ${guildId}: ${error.message}`);
    }
    cache.set(guildId, { commands, expires: Date.now() + CACHE_TTL_MS });
    return commands;
}

async function save(client, guildId, commands) {
    const ok = await client.db.set(getCustomCommandsKey(guildId), { commands });
    if (!ok) throw new Error('Could not save custom commands.');
    cache.set(guildId, { commands, expires: Date.now() + CACHE_TTL_MS });
}

/** Normalises the typed name (strips a leading prefix) and checks it is usable. */
export function validateCustomCommandName(client, rawName, prefix = '!') {
    let name = String(rawName || '').trim().toLowerCase();
    if (prefix && name.startsWith(prefix.toLowerCase())) name = name.slice(prefix.length);

    if (!NAME_PATTERN.test(name)) {
        return { ok: false, error: 'The name can only use letters, numbers, `-` and `_` (max 32 characters, no spaces).' };
    }
    if (RESERVED.has(name) || client.commands?.has(name) || resolveCommandAlias(name) !== name) {
        return { ok: false, error: `\`${name}\` is already used by a built-in command. Pick another name.` };
    }
    return { ok: true, name };
}

export async function addCustomCommand(client, guildId, name, response, userId) {
    const text = String(response || '').trim();
    if (!text) throw new Error('The reply cannot be empty.');
    if (text.length > MAX_RESPONSE_LENGTH) throw new Error(`The reply is too long (max ${MAX_RESPONSE_LENGTH} characters).`);

    const commands = { ...(await getCustomCommands(client, guildId)) };
    if (!commands[name] && Object.keys(commands).length >= MAX_CUSTOM_COMMANDS) {
        throw new Error(`This server already has ${MAX_CUSTOM_COMMANDS} custom commands. Remove one first.`);
    }
    commands[name] = { response: text, createdBy: userId, updatedAt: new Date().toISOString() };
    await save(client, guildId, commands);
    return commands[name];
}

export async function removeCustomCommand(client, guildId, name) {
    const commands = { ...(await getCustomCommands(client, guildId)) };
    if (!commands[name]) return false;
    delete commands[name];
    await save(client, guildId, commands);
    return true;
}

/** Fills {user}, {username}, {server}, {channel} in a reply. */
export function renderCustomResponse(template, message) {
    return String(template)
        .replaceAll('{user}', `<@${message.author.id}>`)
        .replaceAll('{username}', message.member?.displayName || message.author.username)
        .replaceAll('{server}', message.guild?.name || '')
        .replaceAll('{channel}', message.channel?.name ? `#${message.channel.name}` : '');
}
