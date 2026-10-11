// The bot's online status (online / idle / dnd / invisible) and activity text.
// Chosen by the bot owner with !status and !activity, saved, and re-applied on every start.

import { ActivityType } from 'discord.js';
import { getBotPresenceKey } from '../utils/database/keys.js';
import { logger } from '../utils/logger.js';

export const MAX_ACTIVITY_LENGTH = 128;

export const STATUS_ALIASES = {
    online: 'online',
    active: 'online',
    idle: 'idle',
    sleep: 'idle',
    away: 'idle',
    dnd: 'dnd',
    busy: 'dnd',
    'do-not-disturb': 'dnd',
    invisible: 'invisible',
    offline: 'invisible',
    hidden: 'invisible',
};

export const STATUS_LABELS = {
    online: 'Online',
    idle: 'Idle (sleeping)',
    dnd: 'Do Not Disturb',
    invisible: 'Invisible (appears offline)',
};

export const ACTIVITY_TYPES = {
    playing: { type: ActivityType.Playing, label: 'Playing' },
    watching: { type: ActivityType.Watching, label: 'Watching' },
    listening: { type: ActivityType.Listening, label: 'Listening to' },
    competing: { type: ActivityType.Competing, label: 'Competing in' },
    custom: { type: ActivityType.Custom, label: '' },
};

export function resolveStatus(input) {
    return STATUS_ALIASES[String(input || '').trim().toLowerCase()] || null;
}

function toActivities(activity) {
    if (!activity?.text) return [];
    const info = ACTIVITY_TYPES[activity.kind];
    if (!info) return [];
    return info.type === ActivityType.Custom
        ? [{ name: 'Custom Status', state: activity.text, type: ActivityType.Custom }]
        : [{ name: activity.text, type: info.type }];
}

export async function getSavedPresence(client) {
    try {
        const stored = await client.db?.get(getBotPresenceKey(), null);
        return stored && typeof stored === 'object' ? stored : null;
    } catch (error) {
        logger.warn(`Presence: could not read saved presence: ${error.message}`);
        return null;
    }
}

async function save(client, presence) {
    const ok = await client.db.set(getBotPresenceKey(), presence);
    if (!ok) throw new Error('Could not save the presence.');
}

/** Applies a saved presence if there is one, otherwise the default from config. */
export async function applySavedPresence(client, defaultPresence) {
    const saved = await getSavedPresence(client);
    if (!saved || (!saved.status && !saved.activity && !saved.activityCleared)) {
        if (defaultPresence) client.user.setPresence(defaultPresence);
        return false;
    }

    client.user.setPresence({
        status: saved.status || defaultPresence?.status || 'online',
        activities: saved.activity
            ? toActivities(saved.activity)
            : (saved.activityCleared ? [] : (defaultPresence?.activities ?? [])),
    });
    return true;
}

export async function setBotStatus(client, status) {
    const saved = (await getSavedPresence(client)) || {};
    const next = { ...saved, status };
    await save(client, next);
    await applyNow(client, next);
    return next;
}

/** activity = { kind, text } or null to clear. */
export async function setBotActivity(client, activity) {
    const saved = (await getSavedPresence(client)) || {};
    const next = { ...saved, activity: activity?.text ? { kind: activity.kind, text: activity.text } : null, activityCleared: !activity?.text };
    await save(client, next);
    await applyNow(client, next);
    return next;
}

export async function resetBotPresence(client, defaultPresence) {
    await save(client, {});
    if (defaultPresence) client.user.setPresence(defaultPresence);
}

async function applyNow(client, presence) {
    client.user.setPresence({
        status: presence.status || client.user.presence?.status || 'online',
        activities: presence.activity ? toActivities(presence.activity) : [],
    });
}

export function describePresence(presence, defaultPresence) {
    const status = presence?.status || defaultPresence?.status || 'online';
    const activity = presence?.activity;
    const info = activity ? ACTIVITY_TYPES[activity.kind] : null;
    return {
        status: STATUS_LABELS[status] || status,
        activity: activity?.text
            ? `${info?.label ? `${info.label} ` : ''}${activity.text}`
            : (presence?.activityCleared ? 'None' : (defaultPresence?.activities?.[0]?.name ? `${defaultPresence.activities[0].name} (default)` : 'None')),
    };
}
