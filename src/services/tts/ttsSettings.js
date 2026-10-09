import { logger } from '../../utils/logger.js';
import { getTtsGuildKey, getTtsUserKey } from '../../utils/database/keys.js';
import { DEFAULT_TTS_LANGUAGE, isSupportedTtsLanguage } from './ttsLanguages.js';

export const DEFAULT_GUILD_TTS_SETTINGS = Object.freeze({
    language: DEFAULT_TTS_LANGUAGE,
    announceNames: true,
    announceJoinLeave: false,
});

const CACHE_TTL_MS = 30_000;
const guildCache = new Map();
const userCache = new Map();

function readCache(cache, key) {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    cache.delete(key);
    return undefined;
}

function writeCache(cache, key, value) {
    cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

export async function getGuildTtsSettings(client, guildId) {
    const cached = readCache(guildCache, guildId);
    if (cached) return cached;

    let stored = null;
    try {
        stored = await client.db?.get(getTtsGuildKey(guildId), null);
    } catch (error) {
        logger.warn(`TTS: could not read guild settings for ${guildId}: ${error.message}`);
    }

    const settings = { ...DEFAULT_GUILD_TTS_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) };
    if (!isSupportedTtsLanguage(settings.language)) settings.language = DEFAULT_TTS_LANGUAGE;
    writeCache(guildCache, guildId, settings);
    return settings;
}

export async function updateGuildTtsSettings(client, guildId, patch) {
    const current = await getGuildTtsSettings(client, guildId);
    const next = { ...current, ...patch };
    const saved = await client.db.set(getTtsGuildKey(guildId), next);
    if (!saved) throw new Error('Database rejected TTS settings write');
    writeCache(guildCache, guildId, next);
    return next;
}

export async function getUserTtsLanguage(client, userId) {
    const cached = readCache(userCache, userId);
    if (cached !== undefined) return cached;

    let language = null;
    try {
        const stored = await client.db?.get(getTtsUserKey(userId), null);
        language = stored?.language && isSupportedTtsLanguage(stored.language) ? stored.language : null;
    } catch (error) {
        logger.warn(`TTS: could not read user settings for ${userId}: ${error.message}`);
    }
    writeCache(userCache, userId, language);
    return language;
}

/** Pass null to go back to the server default. */
export async function setUserTtsLanguage(client, userId, language) {
    const saved = await client.db.set(getTtsUserKey(userId), { language });
    if (!saved) throw new Error('Database rejected TTS user settings write');
    writeCache(userCache, userId, language);
}

export async function getEffectiveTtsLanguage(client, userId, guildId) {
    const userLanguage = userId ? await getUserTtsLanguage(client, userId) : null;
    if (userLanguage) return userLanguage;
    return (await getGuildTtsSettings(client, guildId)).language;
}
