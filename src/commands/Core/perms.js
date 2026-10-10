import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';

const PERMISSION_INFO = [
  ['ViewChannel', 'See channels where the bot is expected to work (baseline).', true],
  ['SendMessages', 'Send command replies and text messages (baseline).', true],
  ['ReadMessageHistory', 'Read prior messages for features that inspect channel history.', false],
  ['EmbedLinks', 'Send rich embeds used by dashboards, help, moderation logs, and reports.', true],
  ['AttachFiles', 'Send files or generated attachments.', false],
  ['AddReactions', 'Add reactions for reaction-based features.', false],
  ['ManageChannels', 'Lock/unlock channels and manage channel settings.', false],
  ['ManageRoles', 'Assign/remove roles for autoroles, QOTD winners, and role features. Bot role must be above target roles.', false],
  ['ManageMessages', 'Delete or manage messages for moderation and cleanup features.', false],
  ['KickMembers', 'Use member-kick moderation commands.', false],
  ['BanMembers', 'Use member-ban moderation commands.', false],
  ['ModerateMembers', 'Timeout members with moderation commands.', false],
  ['ManageGuild', 'Manage server-level settings and features that explicitly require it.', false],
  ['ViewAuditLog', 'Read audit logs for features that use them.', false],
  ['Connect', 'Join voice channels for music/voice features.', false],
  ['Speak', 'Play audio in voice channels.', false],
  ['MoveMembers', 'Move members between voice channels where supported.', false],
  ['PrioritySpeaker', 'Use priority speaking in voice features that request it.', false],
];

function getPermissionReport(interaction) {
  const guild = interaction.guild;
  const botMember = guild?.members?.me;
  const channel = interaction.channel;
  const guildPermissions = botMember?.permissions;
  const channelPermissions = botMember && channel?.permissionsFor ? channel.permissionsFor(botMember) : null;

  const granted = [];
  const missing = [];
  const unavailable = [];

  for (const [key, reason, baseline] of PERMISSION_INFO) {
    const bit = PermissionFlagsBits[key];
    if (!bit || !guildPermissions) {
      unavailable.push({ key, reason, baseline });
      continue;
    }
    const guildHas = guildPermissions.has(bit);
    const channelHas = channelPermissions ? channelPermissions.has(bit) : guildHas;
    if (guildHas && channelHas) {
      granted.push({ key, reason, baseline });
    } else {
      missing.push({
        key,
        reason,
        baseline,
        status: !guildHas ? 'Missing from bot role/server permissions' : 'Blocked by this channel’s overwrites',
      });
    }
  }

  return { granted, missing, unavailable };
}

function buildReportEmbed(interaction) {
  const { granted, missing, unavailable } = getPermissionReport(interaction);
  const format = (item) => `${item.baseline ? '⭐ ' : ''}**${item.key}** — ${item.reason}`;
  const chunkLines = (lines, limit = 1000) => {
    const chunks = [];
    let current = '';
    for (const line of lines) {
      const next = current ? `${current}\n${line}` : line;
      if (next.length > limit && current) {
        chunks.push(current);
        current = line;
      } else {
        current = next;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  };
  const fields = [];
  const grantedLines = granted.map(format);
  const missingLines = missing.map((item) => `❌ **${item.key}** — ${item.reason}\n↳ ${item.status}${item.baseline ? ' (**baseline permission**)' : ''}`);
  const unavailableLines = unavailable.map((item) => `**${item.key}** — ${item.reason}`);
  const addChunkedFields = (name, lines, emptyText) => {
    const chunks = chunkLines(lines);
    if (!chunks.length) {
      fields.push({ name: `${name} (0)`, value: emptyText, inline: false });
      return;
    }
    chunks.forEach((value, index) => fields.push({
      name: index === 0 ? `${name} (${lines.length})` : `${name} (continued)`,
      value,
      inline: false,
    }));
  };
  addChunkedFields('✅ Available', grantedLines, 'No permissions from the checklist are currently available.');
  addChunkedFields('⚠️ Missing / blocked', missingLines, 'No missing permissions detected from this checklist.');
  if (unavailable.length) addChunkedFields('ℹ️ Not checked', unavailableLines, '');

  return createEmbed({
    title: '🔎 Bot Permission Report',
    description: [
      `Permission check for **${interaction.guild?.name || 'this server'}**${interaction.channel ? ` in ${interaction.channel}` : ''}.`,
      '',
      '⭐ marks baseline permissions commonly needed for normal replies and embeds. Other permissions are feature-specific and should only be granted if you use those features.',
      '**Administrator is not required for the checklist itself.** Grant only the missing permissions for features you actually use, and keep the bot role below trusted staff roles but above roles it must assign.',
    ].join('\n'),
    color: missing.some((item) => item.baseline) ? 'warning' : 'info',
    fields,
    footer: 'This is a practical feature checklist, not a guarantee that every listed permission is needed in every server.',
  });
}

async function sendReport(interaction, ephemeral = false) {
  if (!interaction.guild) {
    const payload = { content: 'Use this command inside a server.', flags: MessageFlags.Ephemeral };
    return interaction.reply(payload);
  }
  const embed = buildReportEmbed(interaction);
  if (interaction._isPrefixCommand) {
    return interaction.reply({ embeds: [embed] });
  }
  return interaction.reply({ embeds: [embed], flags: ephemeral ? MessageFlags.Ephemeral : undefined });
}

export default {
  data: new SlashCommandBuilder()
    .setName('perms')
    .setDescription('Check which bot permissions are granted or missing'),
  category: 'Core',
  async prefixExecute(interaction) {
    return sendReport(interaction);
  },
  async execute(interaction) {
    return sendReport(interaction, true);
  },
};
