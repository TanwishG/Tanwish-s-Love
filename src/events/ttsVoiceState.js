import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getTtsSession, destroyTtsSession, enqueueSpeech } from '../services/tts/ttsService.js';
import { getGuildTtsSettings } from '../services/tts/ttsSettings.js';

export default {
    name: Events.VoiceStateUpdate,
    async execute(oldState, newState, client) {
        try {
            const guildId = newState.guild?.id || oldState.guild?.id;
            const session = guildId ? getTtsSession(guildId) : null;
            if (!session) return;

            // The bot itself was kicked, or an admin dragged it to another channel.
            if (newState.id === client.user.id) {
                if (!newState.channelId) destroyTtsSession(guildId, 'bot-removed');
                else session.channelId = newState.channelId;
                return;
            }

            if (newState.member?.user.bot) return;

            const joined = newState.channelId === session.channelId && oldState.channelId !== session.channelId;
            const left = oldState.channelId === session.channelId && newState.channelId !== session.channelId;
            if (!joined && !left) return;

            if (left) {
                session.lastSpeakerId = session.lastSpeakerId === oldState.id ? null : session.lastSpeakerId;

                const channel = oldState.channel;
                const humans = channel?.members?.filter((m) => !m.user.bot).size ?? 0;
                if (humans === 0) {
                    destroyTtsSession(guildId, 'channel-empty');
                    return;
                }
            }

            const settings = await getGuildTtsSettings(client, guildId);
            if (!settings.announceJoinLeave) return;

            const name = (joined ? newState.member : oldState.member)?.displayName;
            if (!name) return;
            enqueueSpeech(guildId, {
                text: `${name} ${joined ? 'joined' : 'left'}`,
                lang: settings.language,
                priority: true,
            });
        } catch (error) {
            logger.error('Error in TTS voice state handler:', error);
        }
    },
};
