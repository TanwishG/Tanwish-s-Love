/**
 * YouTube Notifier Service
 *
 * Polls the YouTube Data API v3 for new videos from subscribed channels.
 * Stores state per-guild in the database under guild:${guildId}:youtube config.
 * Runs on a configurable interval (default: 5 minutes).
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';

/** In-memory store: Map<guildId, Map<channelId, lastVideoId>> */
const lastVideoIdCache = new Map();

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let _client = null;
let _pollTimer = null;

// ─── YouTube API helpers ──────────────────────────────────────────────────────

/**
 * Resolve a YouTube channel ID from a handle, custom URL, or raw ID.
 * @param {string} input  e.g. "@MrBeast", "UCX6OQ3DkcsbYNE6H8uQQuVA", "MrBeast"
 * @param {string} apiKey
 * @returns {Promise<{id:string, title:string, thumbnail:string}|null>}
 */
export async function resolveYouTubeChannel(input, apiKey) {
    if (!apiKey) return null;

    const cleaned = input.trim();

    // Direct channel-ID format (UCxxxxxxxxxxxxxxxxxxxxxxxx)
    const idMatch = cleaned.match(/^UC[\w-]{22}$/);
    if (idMatch) {
        return fetchChannelById(cleaned, apiKey);
    }

    // Handle format  @handle
    const handleMatch = cleaned.match(/^@(.+)$/);
    if (handleMatch) {
        return fetchChannelByHandle(handleMatch[1], apiKey);
    }

    // Try as a forUsername fallback
    return fetchChannelByUsername(cleaned, apiKey);
}

async function fetchChannelById(channelId, apiKey) {
    try {
        const { data } = await axios.get(`${YOUTUBE_API_BASE}/channels`, {
            params: {
                part: 'snippet',
                id: channelId,
                key: apiKey,
            },
            timeout: 10_000,
        });
        const item = data.items?.[0];
        if (!item) return null;
        return {
            id: item.id,
            title: item.snippet.title,
            thumbnail: item.snippet.thumbnails?.default?.url || null,
        };
    } catch (err) {
        logger.warn('[YouTube] fetchChannelById error:', err.message);
        return null;
    }
}

async function fetchChannelByHandle(handle, apiKey) {
    try {
        const { data } = await axios.get(`${YOUTUBE_API_BASE}/channels`, {
            params: {
                part: 'snippet',
                forHandle: handle,
                key: apiKey,
            },
            timeout: 10_000,
        });
        const item = data.items?.[0];
        if (!item) return null;
        return {
            id: item.id,
            title: item.snippet.title,
            thumbnail: item.snippet.thumbnails?.default?.url || null,
        };
    } catch (err) {
        logger.warn('[YouTube] fetchChannelByHandle error:', err.message);
        return null;
    }
}

async function fetchChannelByUsername(username, apiKey) {
    try {
        const { data } = await axios.get(`${YOUTUBE_API_BASE}/channels`, {
            params: {
                part: 'snippet',
                forUsername: username,
                key: apiKey,
            },
            timeout: 10_000,
        });
        const item = data.items?.[0];
        if (!item) return null;
        return {
            id: item.id,
            title: item.snippet.title,
            thumbnail: item.snippet.thumbnails?.default?.url || null,
        };
    } catch (err) {
        logger.warn('[YouTube] fetchChannelByUsername error:', err.message);
        return null;
    }
}

/**
 * Fetch the latest video from a YouTube channel.
 * @param {string} channelId
 * @param {string} apiKey
 * @returns {Promise<{id:string, title:string, url:string, thumbnail:string, publishedAt:string}|null>}
 */
export async function fetchLatestVideo(channelId, apiKey) {
    if (!apiKey) return null;
    try {
        const { data } = await axios.get(`${YOUTUBE_API_BASE}/search`, {
            params: {
                part: 'snippet',
                channelId,
                order: 'date',
                maxResults: 1,
                type: 'video',
                key: apiKey,
            },
            timeout: 10_000,
        });
        const item = data.items?.[0];
        if (!item) return null;
        const videoId = item.id?.videoId;
        if (!videoId) return null;
        return {
            id: videoId,
            title: item.snippet.title,
            url: `https://www.youtube.com/watch?v=${videoId}`,
            thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url || null,
            publishedAt: item.snippet.publishedAt,
            channelTitle: item.snippet.channelTitle,
        };
    } catch (err) {
        logger.warn(`[YouTube] fetchLatestVideo error for ${channelId}:`, err.message);
        return null;
    }
}

// ─── Database helpers ─────────────────────────────────────────────────────────

export function getYouTubeConfigKey(guildId) {
    return `guild:${guildId}:youtube`;
}

/**
 * Load YouTube config for a guild.
 * Shape: { subscriptions: [ { channelId, channelTitle, thumbnail, notifyChannelId, customMessage } ] }
 */
export async function loadYouTubeConfig(client, guildId) {
    if (!client?.db) return { subscriptions: [] };
    try {
        const raw = await client.db.get(getYouTubeConfigKey(guildId));
        if (!raw) return { subscriptions: [] };
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return { subscriptions: [], ...parsed };
    } catch {
        return { subscriptions: [] };
    }
}

export async function saveYouTubeConfig(client, guildId, config) {
    if (!client?.db) return;
    await client.db.set(getYouTubeConfigKey(guildId), JSON.stringify(config));
}

// ─── Polling loop ─────────────────────────────────────────────────────────────

async function pollAllGuilds() {
    if (!_client) return;

    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) return;

    for (const [guildId] of _client.guilds.cache) {
        try {
            await pollGuild(_client, guildId, apiKey);
        } catch (err) {
            logger.error(`[YouTube] Poll error for guild ${guildId}:`, err.message);
        }
    }
}

async function pollGuild(client, guildId, apiKey) {
    const config = await loadYouTubeConfig(client, guildId);
    if (!config.subscriptions?.length) return;

    if (!lastVideoIdCache.has(guildId)) {
        lastVideoIdCache.set(guildId, new Map());
    }
    const guildCache = lastVideoIdCache.get(guildId);

    for (const sub of config.subscriptions) {
        const { channelId, notifyChannelId, customMessage } = sub;
        if (!channelId || !notifyChannelId) continue;

        const video = await fetchLatestVideo(channelId, apiKey);
        if (!video) continue;

        const lastId = guildCache.get(channelId);

        // Seed on first run so we don't spam old videos
        if (!lastId) {
            guildCache.set(channelId, video.id);
            continue;
        }

        if (video.id === lastId) continue;

        // New video detected!
        guildCache.set(channelId, video.id);
        await sendVideoNotification(client, guildId, notifyChannelId, sub, video, customMessage);
    }
}

async function sendVideoNotification(client, guildId, notifyChannelId, sub, video, customMessage) {
    try {
        const channel = client.channels.cache.get(notifyChannelId)
            || await client.channels.fetch(notifyChannelId).catch(() => null);

        if (!channel) {
            logger.warn(`[YouTube] Notify channel ${notifyChannelId} not found in guild ${guildId}`);
            return;
        }

        const { EmbedBuilder } = await import('discord.js');

        const embed = new EmbedBuilder()
            .setColor(0xFF0000) // YouTube red
            .setTitle(`📺 ${video.title}`)
            .setURL(video.url)
            .setDescription(customMessage
                ? customMessage
                    .replace('{channel}', sub.channelTitle || video.channelTitle)
                    .replace('{title}', video.title)
                    .replace('{url}', video.url)
                : `**${sub.channelTitle || video.channelTitle}** just uploaded a new video!`)
            .setThumbnail(sub.thumbnail || null)
            .setImage(video.thumbnail || null)
            .setFooter({ text: 'YouTube • New Upload' })
            .setTimestamp(new Date(video.publishedAt));

        await channel.send({ content: video.url, embeds: [embed] });

        logger.info(`[YouTube] Notified guild ${guildId} of new video ${video.id} from channel ${sub.channelId}`);
    } catch (err) {
        logger.error(`[YouTube] Failed to send notification in guild ${guildId}:`, err.message);
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the YouTube polling service.
 * Call once from ready.js after the client is ready.
 */
export function startYouTubeNotifier(client) {
    if (!process.env.YOUTUBE_API_KEY) {
        logger.warn('[YouTube] YOUTUBE_API_KEY not set — notifier disabled.');
        return;
    }

    _client = client;

    // Clear any existing timer
    if (_pollTimer) clearInterval(_pollTimer);

    // Initial seed poll (quiet — just sets lastVideoId without notifying)
    seedAllGuilds(client).catch(() => {});

    _pollTimer = setInterval(() => {
        pollAllGuilds().catch((err) => logger.error('[YouTube] Poll loop error:', err.message));
    }, POLL_INTERVAL_MS);

    logger.info(`[YouTube] Notifier started. Polling every ${POLL_INTERVAL_MS / 60000} min.`);
}

async function seedAllGuilds(client) {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) return;

    for (const [guildId] of client.guilds.cache) {
        try {
            const config = await loadYouTubeConfig(client, guildId);
            if (!config.subscriptions?.length) continue;

            if (!lastVideoIdCache.has(guildId)) lastVideoIdCache.set(guildId, new Map());
            const guildCache = lastVideoIdCache.get(guildId);

            for (const sub of config.subscriptions) {
                if (guildCache.has(sub.channelId)) continue;
                const video = await fetchLatestVideo(sub.channelId, apiKey);
                if (video) guildCache.set(sub.channelId, video.id);
            }
        } catch {
            // Silently ignore seed errors
        }
    }
}

export function stopYouTubeNotifier() {
    if (_pollTimer) {
        clearInterval(_pollTimer);
        _pollTimer = null;
    }
    _client = null;
}
