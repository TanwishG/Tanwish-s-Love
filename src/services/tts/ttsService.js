import { createRequire } from 'module';
import { Readable } from 'node:stream';
import { PermissionFlagsBits } from 'discord.js';
import {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    entersState,
    AudioPlayerStatus,
    NoSubscriberBehavior,
    VoiceConnectionStatus,
    generateDependencyReport,
} from '@discordjs/voice';
import { logger } from '../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { botHasPermission } from '../../utils/permissionGuard.js';
import { splitTextIntoChunks } from './ttsText.js';

const require = createRequire(import.meta.url);
const googleTTS = require('@sefinek/google-tts-api');

const MAX_QUEUE_LENGTH = 15;
const FETCH_TIMEOUT_MS = 10_000;
const PLAYBACK_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 20_000;

/** guildId -> session. A guild has at most one TTS session. */
const sessions = new Map();

export function getTtsSession(guildId) {
    return sessions.get(guildId) || null;
}

export function hasTtsSession(guildId) {
    return sessions.has(guildId);
}

function countHumans(channel) {
    return channel?.members?.filter((member) => !member.user.bot).size ?? 0;
}

/**
 * Join a voice channel and start a TTS session for the guild.
 * Returns the (possibly already existing) session.
 */
export async function startTtsSession(client, voiceChannel, textChannelId) {
    const guild = voiceChannel.guild;
    const guildId = guild.id;

    // Lavalink (music) and @discordjs/voice (TTS) cannot share one voice connection.
    if (client.riffy?.players?.get(guildId)) {
        throw new TitanBotError(
            'Music player active',
            ErrorTypes.USER_INPUT,
            'Music is active in this server. Stop it first with `/music leave`, then run `/tts join`.',
        );
    }

    if (!botHasPermission(voiceChannel, [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
        throw new TitanBotError(
            'Missing voice permissions',
            ErrorTypes.PERMISSION,
            'I need **Connect** and **Speak** permissions in your voice channel.',
        );
    }

    const existing = sessions.get(guildId);
    if (existing) {
        if (existing.channelId === voiceChannel.id) {
            existing.textChannelId = textChannelId || existing.textChannelId;
            return existing;
        }
        const currentChannel = guild.channels.cache.get(existing.channelId);
        if (countHumans(currentChannel) > 0) {
            throw new TitanBotError(
                'TTS in use elsewhere',
                ErrorTypes.USER_INPUT,
                `I'm already reading messages for people in <#${existing.channelId}>.`,
            );
        }
        destroyTtsSession(guildId, 'moved');
    }

    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false,
    });

    // Keep a short trail of what the voice connection did, so a failed join can be diagnosed from the logs.
    const trail = [];
    const debugLines = [];
    connection.on('stateChange', (oldState, newState) => {
        trail.push(newState.status);
        if (newState.status === VoiceConnectionStatus.Disconnected && newState.reason !== undefined) {
            trail.push(`reason=${newState.reason}${newState.closeCode ? `/code=${newState.closeCode}` : ''}`);
        }
    });
    connection.on('debug', (line) => {
        debugLines.push(line);
        if (debugLines.length > 15) debugLines.shift();
    });
    connection.on('error', (error) => logger.warn(`TTS voice connection error in guild ${guildId}: ${error.message}`));

    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    player.on('error', (error) => logger.warn(`TTS player error in guild ${guildId}: ${error.message}`));

    const session = {
        guildId,
        channelId: voiceChannel.id,
        textChannelId: textChannelId || null,
        connection,
        player,
        queue: [],
        busy: false,
        destroyed: false,
        lastSpeakerId: null,
    };
    sessions.set(guildId, session);

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        // Discord moves the bot between channels by briefly disconnecting; give it a moment to recover.
        try {
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
            ]);
        } catch {
            destroyTtsSession(guildId, 'disconnected');
        }
    });
    connection.on(VoiceConnectionStatus.Destroyed, () => {
        if (sessions.get(guildId) === session) destroyTtsSession(guildId, 'destroyed');
    });

    try {
        await entersState(connection, VoiceConnectionStatus.Ready, CONNECT_TIMEOUT_MS);
    } catch {
        const finalState = connection.state.status;
        logger.warn(
            `TTS voice connect failed in guild ${guildId}. Final state: ${finalState}. ` +
            `State trail: ${trail.join(' > ') || '(none)'}. Node ${process.version}.\n` +
            `Last voice debug lines:\n${debugLines.join('\n') || '(none)'}\n` +
            generateDependencyReport(),
        );
        destroyTtsSession(guildId, 'connect-failed');
        throw new TitanBotError(
            'Voice connection failed',
            ErrorTypes.CONFIGURATION,
            `I could not connect to the voice channel (stuck at: \`${finalState}\`). Check my permissions and try again; if it keeps happening, the bot's log has details.`,
        );
    }

    connection.subscribe(player);
    return session;
}

export function destroyTtsSession(guildId, reason = 'manual') {
    const session = sessions.get(guildId);
    if (!session) return false;

    sessions.delete(guildId);
    session.destroyed = true;
    session.queue.length = 0;

    try {
        session.player.stop(true);
    } catch {
        // already stopped
    }
    try {
        if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
            session.connection.destroy();
        }
    } catch {
        // already destroyed
    }

    logger.debug(`TTS session for guild ${guildId} ended (${reason})`);
    return true;
}

export function shutdownTts() {
    for (const guildId of [...sessions.keys()]) {
        destroyTtsSession(guildId, 'shutdown');
    }
}

/**
 * Add something to the speech queue.
 * item: { text: string, lang: string, priority?: boolean }
 * Returns false if the guild has no session or the queue is full.
 */
export function enqueueSpeech(guildId, item) {
    const session = sessions.get(guildId);
    if (!session || session.destroyed) return false;
    if (session.queue.length >= MAX_QUEUE_LENGTH) return false;

    if (item.priority) session.queue.unshift(item);
    else session.queue.push(item);

    void pump(session);
    return true;
}

export function clearSpeechQueue(guildId) {
    const session = sessions.get(guildId);
    if (!session) return;
    session.queue.length = 0;
    session.player.stop(true);
}

async function pump(session) {
    if (session.busy) return;
    session.busy = true;

    try {
        while (!session.destroyed && session.queue.length > 0) {
            const item = session.queue.shift();
            const chunks = splitTextIntoChunks(item.text);

            // Download the first chunk, then fetch the next while the current one plays.
            let nextAudio = chunks.length ? fetchTtsAudio(chunks[0], item.lang) : null;
            for (let i = 0; i < chunks.length && !session.destroyed; i++) {
                const audio = await nextAudio;
                nextAudio = i + 1 < chunks.length ? fetchTtsAudio(chunks[i + 1], item.lang) : null;
                if (audio) await playBuffer(session, audio);
            }
        }
    } catch (error) {
        logger.error(`TTS queue error in guild ${session.guildId}:`, error);
    } finally {
        session.busy = false;
        // Something may have been queued between the last check and now.
        if (!session.destroyed && session.queue.length > 0) void pump(session);
    }
}

async function fetchTtsAudio(text, lang) {
    try {
        const url = googleTTS.getAudioUrl(text, {
            lang,
            slow: false,
            host: 'https://translate.google.com',
        });
        const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TitanBot-TTS)' },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
            logger.warn(`TTS request failed (${response.status}) for lang=${lang}`);
            return null;
        }
        return Buffer.from(await response.arrayBuffer());
    } catch (error) {
        logger.warn(`TTS download failed: ${error.message}`);
        return null;
    }
}

function playBuffer(session, buffer) {
    return new Promise((resolve) => {
        const { player } = session;
        let settled = false;

        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            player.off(AudioPlayerStatus.Idle, finish);
            player.off('error', finish);
            resolve();
        };

        const timer = setTimeout(() => {
            player.stop(true);
            finish();
        }, PLAYBACK_TIMEOUT_MS);

        player.once(AudioPlayerStatus.Idle, finish);
        player.once('error', finish);

        try {
            player.play(createAudioResource(Readable.from(buffer)));
        } catch (error) {
            logger.warn(`TTS playback failed: ${error.message}`);
            finish();
        }
    });
}
