// Lock bypass: people/roles that may keep talking in a channel while it is locked.
//
// A bypass is a channel permission override that explicitly allows "Send Messages" for one
// role or user. Channel overrides for a specific role/user beat the @everyone lock, so
// /lock keeps working for everyone else. We also remember who was added so /bypass list
// can show it and /lock can mention it.

import { getLockBypassKey } from '../utils/database/keys.js';

export const MAX_BYPASS_PER_CHANNEL = 25;

export async function getAllBypass(client, guildId) {
    const stored = await client.db?.get(getLockBypassKey(guildId), null);
    return stored?.channels && typeof stored.channels === 'object' ? stored.channels : {};
}

export async function getChannelBypass(client, guildId, channelId) {
    const all = await getAllBypass(client, guildId);
    return Array.isArray(all[channelId]) ? all[channelId] : [];
}

async function save(client, guildId, channels) {
    const ok = await client.db.set(getLockBypassKey(guildId), { channels });
    if (!ok) throw new Error('Could not save the bypass list.');
}

export async function addBypassEntry(client, guildId, channelId, entry) {
    const channels = { ...(await getAllBypass(client, guildId)) };
    const list = Array.isArray(channels[channelId]) ? [...channels[channelId]] : [];

    if (list.some((existing) => existing.id === entry.id)) return { added: false, list };
    if (list.length >= MAX_BYPASS_PER_CHANNEL) {
        throw new Error(`A channel can have at most ${MAX_BYPASS_PER_CHANNEL} bypass entries.`);
    }

    list.push({ id: entry.id, type: entry.type, addedBy: entry.addedBy, addedAt: new Date().toISOString() });
    channels[channelId] = list;
    await save(client, guildId, channels);
    return { added: true, list };
}

export async function removeBypassEntry(client, guildId, channelId, targetId) {
    const channels = { ...(await getAllBypass(client, guildId)) };
    const list = Array.isArray(channels[channelId]) ? channels[channelId] : [];
    const next = list.filter((entry) => entry.id !== targetId);
    if (next.length === list.length) return false;

    if (next.length === 0) delete channels[channelId];
    else channels[channelId] = next;
    await save(client, guildId, channels);
    return true;
}

export const mentionEntry = (entry) => (entry.type === 'role' ? `<@&${entry.id}>` : `<@${entry.id}>`);
