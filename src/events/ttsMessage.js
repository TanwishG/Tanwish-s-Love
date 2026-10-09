import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getCommandPrefix } from '../config/bot.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { getTtsSession, enqueueSpeech } from '../services/tts/ttsService.js';
import { getGuildTtsSettings, getEffectiveTtsLanguage } from '../services/tts/ttsSettings.js';
import { prepareMessageText } from '../services/tts/ttsText.js';

export default {
    name: Events.MessageCreate,
    async execute(message, client) {
        try {
            if (message.author.bot || message.webhookId || !message.guild || !message.content) return;

            const session = getTtsSession(message.guild.id);
            if (!session) return;

            // Only the voice channel's own chat, or the text channel where /tts join was used.
            const inVoiceChat = message.channelId === session.channelId;
            const inJoinChannel = session.textChannelId && message.channelId === session.textChannelId;
            if (!inVoiceChat && !inJoinChannel) return;

            // The author must be in the same voice channel as the bot.
            const member = message.member || (await message.guild.members.fetch(message.author.id).catch(() => null));
            if (!member || member.voice?.channelId !== session.channelId) return;

            // Don't read bot commands aloud.
            const guildConfig = await getGuildConfig(client, message.guild.id).catch(() => null);
            const prefix = guildConfig?.prefix || getCommandPrefix();
            if (message.content.startsWith('/') || (prefix && message.content.startsWith(prefix))) return;

            const prepared = prepareMessageText(message);
            if (!prepared) return;

            const settings = await getGuildTtsSettings(client, message.guild.id);
            const lang = await getEffectiveTtsLanguage(client, message.author.id, message.guild.id);

            // Say the author's name only when the speaker changes.
            const speakerChanged = session.lastSpeakerId !== message.author.id;
            session.lastSpeakerId = message.author.id;

            let text = prepared.text;
            if (settings.announceNames && speakerChanged && !prepared.isExpression) {
                text = `${member.displayName} said, ${text}`;
            }

            enqueueSpeech(message.guild.id, { text, lang });
        } catch (error) {
            logger.error('Error in TTS message handler:', error);
        }
    },
};
