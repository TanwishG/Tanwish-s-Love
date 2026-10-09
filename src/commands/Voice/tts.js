import { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { successEmbed, infoEmbed } from '../../utils/embeds.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { TTS_LANGUAGES, getLanguageName } from '../../services/tts/ttsLanguages.js';
import {
    startTtsSession,
    destroyTtsSession,
    getTtsSession,
    enqueueSpeech,
} from '../../services/tts/ttsService.js';
import {
    getGuildTtsSettings,
    updateGuildTtsSettings,
    getUserTtsLanguage,
    setUserTtsLanguage,
    getEffectiveTtsLanguage,
} from '../../services/tts/ttsSettings.js';
import { MAX_SPOKEN_CHARS } from '../../services/tts/ttsText.js';

const languageChoices = TTS_LANGUAGES.map(({ name, value }) => ({ name, value }));

function requireVoice(interaction) {
    const channel = interaction.member?.voice?.channel;
    if (!channel) {
        throw new TitanBotError('Not in voice', ErrorTypes.USER_INPUT, 'Join a voice channel first.');
    }
    return channel;
}

function requireManageGuild(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        throw new TitanBotError(
            'Missing permission',
            ErrorTypes.PERMISSION,
            'You need the **Manage Server** permission to change TTS server settings.',
        );
    }
}

const onOff = (value) => (value ? 'on' : 'off');

export default {
    slashOnly: true,
    category: 'Voice',
    data: new SlashCommandBuilder()
        .setName('tts')
        .setDescription('Text-to-speech: read voice-channel chat messages aloud')
        .setDMPermission(false)
        .addSubcommand((sub) =>
            sub.setName('join').setDescription('Join your voice channel and read messages aloud'),
        )
        .addSubcommand((sub) =>
            sub.setName('leave').setDescription('Stop reading messages and leave the voice channel'),
        )
        .addSubcommand((sub) =>
            sub
                .setName('say')
                .setDescription('Speak a message in the voice channel')
                .addStringOption((opt) =>
                    opt
                        .setName('message')
                        .setDescription('What should I say?')
                        .setRequired(true)
                        .setMaxLength(MAX_SPOKEN_CHARS),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('mylanguage')
                .setDescription('Set the language your messages are read in')
                .addStringOption((opt) =>
                    opt
                        .setName('language')
                        .setDescription('Leave empty to see your current setting')
                        .addChoices(...languageChoices, { name: 'Server default', value: 'default' }),
                ),
        )
        .addSubcommandGroup((group) =>
            group
                .setName('settings')
                .setDescription('Server-wide TTS settings (Manage Server)')
                .addSubcommand((sub) =>
                    sub.setName('view').setDescription('Show the current TTS settings'),
                )
                .addSubcommand((sub) =>
                    sub
                        .setName('language')
                        .setDescription('Default language for people without a personal setting')
                        .addStringOption((opt) =>
                            opt
                                .setName('language')
                                .setDescription('Language')
                                .setRequired(true)
                                .addChoices(...languageChoices),
                        ),
                )
                .addSubcommand((sub) =>
                    sub
                        .setName('names')
                        .setDescription('Say who wrote each message ("Sam said, ...")')
                        .addBooleanOption((opt) =>
                            opt.setName('enabled').setDescription('On or off').setRequired(true),
                        ),
                )
                .addSubcommand((sub) =>
                    sub
                        .setName('joinleave')
                        .setDescription('Announce when people join or leave the voice channel')
                        .addBooleanOption((opt) =>
                            opt.setName('enabled').setDescription('On or off').setRequired(true),
                        ),
                ),
        ),

    async execute(interaction, config, client) {
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand();
        const reply = (embed) => InteractionHelper.safeEditReply(interaction, { embeds: [embed] });

        if (group === 'settings') {
            return handleSettings(interaction, client, sub, reply);
        }

        switch (sub) {
            case 'join': {
                const channel = requireVoice(interaction);
                const session = await startTtsSession(client, channel, interaction.channelId);
                const where = session.textChannelId === channel.id
                    ? 'the chat of that voice channel'
                    : `<#${session.textChannelId}> and the voice channel chat`;
                return reply(
                    successEmbed(
                        'TTS Enabled',
                        `Connected to **${channel.name}**. I'll read messages from people in that voice channel written in ${where}.`,
                    ),
                );
            }

            case 'leave': {
                const session = getTtsSession(interaction.guildId);
                if (!session) {
                    throw new TitanBotError('No TTS session', ErrorTypes.USER_INPUT, 'TTS is not running in this server.');
                }
                if (interaction.member?.voice?.channelId !== session.channelId
                    && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
                    throw new TitanBotError(
                        'Wrong channel',
                        ErrorTypes.PERMISSION,
                        'Join my voice channel (or have Manage Server) to stop TTS.',
                    );
                }
                destroyTtsSession(interaction.guildId, 'command');
                return reply(successEmbed('TTS Stopped', 'Disconnected from the voice channel.'));
            }

            case 'say': {
                const channel = requireVoice(interaction);
                let session = getTtsSession(interaction.guildId);
                if (!session) {
                    session = await startTtsSession(client, channel, interaction.channelId);
                }
                if (session.channelId !== channel.id) {
                    throw new TitanBotError(
                        'Wrong channel',
                        ErrorTypes.USER_INPUT,
                        `I'm in <#${session.channelId}>. Join that channel to use \`/tts say\`.`,
                    );
                }
                const lang = await getEffectiveTtsLanguage(client, interaction.user.id, interaction.guildId);
                const queued = enqueueSpeech(interaction.guildId, {
                    text: interaction.options.getString('message', true),
                    lang,
                });
                if (!queued) {
                    throw new TitanBotError('Queue full', ErrorTypes.USER_INPUT, 'Too many messages queued. Try again in a moment.');
                }
                return reply(successEmbed('Queued', 'Your message will be spoken shortly.'));
            }

            case 'mylanguage': {
                const choice = interaction.options.getString('language');
                if (!choice) {
                    const personal = await getUserTtsLanguage(client, interaction.user.id);
                    const server = (await getGuildTtsSettings(client, interaction.guildId)).language;
                    return reply(
                        infoEmbed(
                            'Your TTS Language',
                            personal
                                ? `Your messages are read in **${getLanguageName(personal)}**.`
                                : `You have no personal setting, so the server default (**${getLanguageName(server)}**) is used.`,
                        ),
                    );
                }
                await setUserTtsLanguage(client, interaction.user.id, choice === 'default' ? null : choice);
                return reply(
                    successEmbed(
                        'Language Updated',
                        choice === 'default'
                            ? 'Your messages will use the server default language.'
                            : `Your messages will be read in **${getLanguageName(choice)}**.`,
                    ),
                );
            }

            default:
                throw new TitanBotError('Unknown subcommand', ErrorTypes.USER_INPUT, 'Unknown TTS subcommand.');
        }
    },
};

async function handleSettings(interaction, client, sub, reply) {
    if (sub === 'view') {
        const s = await getGuildTtsSettings(client, interaction.guildId);
        return reply(
            infoEmbed(
                'TTS Settings',
                [
                    `**Default language:** ${getLanguageName(s.language)}`,
                    `**Say author names:** ${onOff(s.announceNames)}`,
                    `**Announce join/leave:** ${onOff(s.announceJoinLeave)}`,
                ].join('\n'),
            ),
        );
    }

    requireManageGuild(interaction);

    switch (sub) {
        case 'language': {
            const language = interaction.options.getString('language', true);
            await updateGuildTtsSettings(client, interaction.guildId, { language });
            return reply(successEmbed('Default Language Updated', `Server default is now **${getLanguageName(language)}**.`));
        }
        case 'names': {
            const enabled = interaction.options.getBoolean('enabled', true);
            await updateGuildTtsSettings(client, interaction.guildId, { announceNames: enabled });
            return reply(successEmbed('Setting Updated', `Author names are now **${onOff(enabled)}**.`));
        }
        case 'joinleave': {
            const enabled = interaction.options.getBoolean('enabled', true);
            await updateGuildTtsSettings(client, interaction.guildId, { announceJoinLeave: enabled });
            return reply(successEmbed('Setting Updated', `Join/leave announcements are now **${onOff(enabled)}**.`));
        }
        default:
            throw new TitanBotError('Unknown subcommand', ErrorTypes.USER_INPUT, 'Unknown TTS settings option.');
    }
}
