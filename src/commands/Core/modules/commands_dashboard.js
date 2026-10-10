import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  RoleSelectMenuBuilder,
  UserSelectMenuBuilder,
  MessageFlags,
} from 'discord.js';
import { createEmbed } from '../../../utils/embeds.js';
import {
  getCommandAccessSnapshot,
  disableCategory,
  enableCategory,
  disableCommand,
  enableCommand,
  resetCategoryCommands,
} from '../../../services/commandAccessService.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import {
  canManageAccessPolicy,
  getCommandPermissionRule,
  getDashboardAccessRule,
  setCommandPermissionAccess,
  setDashboardAccessPolicy,
} from '../../../services/commandPermissionsService.js';

export const DASHBOARD_CATEGORY_SELECT = 'cmdaccess_category';
export const DASHBOARD_COMMAND_SELECT = 'cmdaccess_command';
export const DASHBOARD_TOGGLE_CATEGORY = 'cmdaccess_toggle_category';
export const DASHBOARD_ENABLE_ALL = 'cmdaccess_enable_all';
export const DASHBOARD_DISABLE_ALL = 'cmdaccess_disable_all';
export const DASHBOARD_RESET_COMMANDS = 'cmdaccess_reset_commands';
export const DASHBOARD_REFRESH = 'cmdaccess_refresh';
export const DASHBOARD_HOME = 'cmdaccess_home';
export const DASHBOARD_PERM_OPEN = 'cmdaccess_perm_open';
export const DASHBOARD_PERM_COMMAND = 'cmdaccess_perm_cmd';
export const DASHBOARD_PERM_MODE = 'cmdaccess_perm_mode';
export const DASHBOARD_PERM_ROLES = 'cmdaccess_perm_roles';
export const DASHBOARD_PERM_USERS = 'cmdaccess_perm_users';
export const DASHBOARD_PERM_RESET = 'cmdaccess_perm_reset';
export const DASHBOARD_PERM_BACK = 'cmdaccess_perm_back';
export const DASHBOARD_ACCESS_OPEN = 'cmdaccess_dash_open';

// Stands in for a command name when the editor is changing "who can open this dashboard".
const DASHBOARD_TARGET = '@dashboard';

const MODE_LABELS = {
  everyone: '🌐 Everyone',
  admins: '🛡️ Server administrators only',
  custom: '👥 Specific roles / users',
  roles: '👥 Specific roles',
  users: '👥 Specific users',
};

const STATUS = {
  enabled: '🟢',
  partial: '🟡',
  disabled: '🔴',
};

function customId(base, guildId, suffix = '') {
  return suffix ? `${base}:${guildId}:${suffix}` : `${base}:${guildId}`;
}

function getCategoryStatus(category) {
  if (category.categoryDisabled) {
    return STATUS.disabled;
  }
  if (category.disabledCount === 0) {
    return STATUS.enabled;
  }
  return STATUS.partial;
}

function formatCommandLabel(command) {
  if (command.isSubcommand) {
    return `\`${command.name.replace(/ /g, ' ')}\``;
  }
  return `\`${command.name}\``;
}

function chunkLines(lines, maxLength = 980) {
  const chunks = [];
  let current = '';

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLength && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

export function buildOverviewEmbed(snapshot, guild) {
  const fullyEnabled = snapshot.categories.filter((c) => !c.categoryDisabled && c.disabledCount === 0).length;
  const partial = snapshot.categories.filter((c) => !c.categoryDisabled && c.disabledCount > 0).length;
  const disabled = snapshot.categories.filter((c) => c.categoryDisabled).length;

  const categoryLines = snapshot.categories.map((category) => {
    const icon = getCategoryStatus(category);
    const subcommandNote = category.commands.some((c) => c.isSubcommand) ? ' · incl. subcommands' : '';
    return `${icon} ${category.icon} **${category.displayName}** — ${category.enabledCount}/${category.totalCount}${subcommandNote}`;
  });

  const fields = [
    {
      name: '📊 Summary',
      value: [
        `**${snapshot.enabledTotal}/${snapshot.totalCommands}** entries enabled`,
        `${STATUS.enabled} ${fullyEnabled} fully on · ${STATUS.partial} ${partial} partial · ${STATUS.disabled} ${disabled} off`,
      ].join('\n'),
      inline: false,
    },
    {
      name: '🔑 Legend',
      value: `${STATUS.enabled} All enabled · ${STATUS.partial} Some disabled · ${STATUS.disabled} Category off`,
      inline: false,
    },
  ];

  const chunks = chunkLines(categoryLines);
  chunks.forEach((chunk, index) => {
    fields.push({
      name: index === 0 ? '📁 Categories' : '📁 Categories (cont.)',
      value: chunk,
      inline: false,
    });
  });

  fields.push({
    name: 'How to Use',
    value: [
      '• Select a category below to manage commands and subcommands',
      '• `/commands disable` — turn off a category or specific command',
      '• `/commands enable` — turn something back on',
      '• Open a category, then press **Who can use these commands** to pick roles/users with dropdowns',
      '• **Who can open this dashboard** (button below) controls who may use this screen',
    ].join('\n'),
  });

  return createEmbed({
    title: '⚙️ Command Access',
    description: `Manage slash and prefix commands for **${guild.name}**. Subcommands (e.g. \`birthday list\`) are listed separately.`,
    color: 'info',
    fields,
    footer: '🔒 commands & configwizard always stay available',
  });
}

export function buildCategoryEmbed(category, guild) {
  const statusIcon = getCategoryStatus(category);
  const statusText = category.categoryDisabled
    ? 'Category disabled'
    : category.disabledCount === 0
      ? 'All entries enabled'
      : `${category.disabledCount} of ${category.totalCount} disabled`;

  const commandLines = category.commands.map((command) => {
    const enabled = category.enabledCommands.includes(command.name);
    const icon = enabled ? STATUS.enabled : STATUS.disabled;
    const lock = command.protected ? ' 🔒' : '';
    return `${icon} ${formatCommandLabel(command)}${lock}`;
  });

  const fields = [
    {
      name: `${statusIcon} Status`,
      value: statusText,
      inline: true,
    },
    {
      name: '📈 Count',
      value: `${category.enabledCount}/${category.totalCount} enabled`,
      inline: true,
    },
  ];

  const chunks = chunkLines(commandLines);
  chunks.forEach((chunk, index) => {
    fields.push({
      name: index === 0 ? '📋 Commands & Subcommands' : '📋 (cont.)',
      value: chunk,
      inline: false,
    });
  });

  fields.push({
    name: 'How to Use',
    value: [
      '• Use the dropdown to toggle individual commands or subcommands',
      '• **Disable All** turns off the whole category',
      '• **Clear Overrides** re-enables individually disabled entries',
      '• **Who can use these commands** picks the roles/users allowed to run each command',
    ].join('\n'),
  });

  return createEmbed({
    title: `${category.icon} ${category.displayName}`,
    description: `Command access for **${guild.name}**.`,
    color: category.categoryDisabled ? 'error' : category.disabledCount > 0 ? 'warning' : 'success',
    fields,
    footer: '🔒 Protected entries cannot be disabled',
  });
}

export function buildOverviewComponents(guildId, snapshot) {
  const categoryOptions = snapshot.categories.slice(0, 25).map((category) => {
    const status = getCategoryStatus(category);
    return new StringSelectMenuOptionBuilder()
      .setLabel(`${category.displayName}`.slice(0, 100))
      .setDescription(`${status} ${category.enabledCount}/${category.totalCount} enabled`.slice(0, 100))
      .setValue(category.key)
      .setEmoji(category.icon);
  });

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(customId(DASHBOARD_CATEGORY_SELECT, guildId))
        .setPlaceholder('📁 Select a category...')
        .addOptions(categoryOptions),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(customId(DASHBOARD_REFRESH, guildId))
        .setLabel('Refresh')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(customId(DASHBOARD_ACCESS_OPEN, guildId))
        .setLabel('Who can open this dashboard')
        .setEmoji('🔐')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

export function buildCategoryComponents(guildId, category) {
  const toggleableCommands = category.commands.filter((command) => !command.protected);
  const commandOptions = toggleableCommands.slice(0, 25).map((command) => {
    const enabled = category.enabledCommands.includes(command.name);
    const label = command.isSubcommand
      ? command.name.replace(' ', ' · ').slice(0, 100)
      : command.name.slice(0, 100);

    return new StringSelectMenuOptionBuilder()
      .setLabel(label)
      .setDescription((enabled ? '🟢 Enabled — click to disable' : '🔴 Disabled — click to enable').slice(0, 100))
      .setValue(command.name);
  });

  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(customId(DASHBOARD_HOME, guildId))
        .setLabel('Back')
        .setEmoji('◀️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(customId(DASHBOARD_TOGGLE_CATEGORY, guildId, category.key))
        .setLabel(category.categoryDisabled ? 'Enable Category' : 'Disable Category')
        .setEmoji(category.categoryDisabled ? '🟢' : '🔴')
        .setStyle(category.categoryDisabled ? ButtonStyle.Success : ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(customId(DASHBOARD_ENABLE_ALL, guildId, category.key))
        .setLabel('Enable All')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(customId(DASHBOARD_DISABLE_ALL, guildId, category.key))
        .setLabel('Disable All')
        .setEmoji('⛔')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(customId(DASHBOARD_RESET_COMMANDS, guildId, category.key))
        .setLabel('Clear Overrides')
        .setEmoji('🧹')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(customId(DASHBOARD_PERM_OPEN, guildId, category.key))
        .setLabel('Who can use these commands')
        .setEmoji('👥')
        .setStyle(ButtonStyle.Primary),
    ),
  );

  if (commandOptions.length > 0) {
    rows.unshift(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(customId(DASHBOARD_COMMAND_SELECT, guildId, category.key))
          .setPlaceholder('Toggle a command or subcommand...')
          .addOptions(commandOptions),
      ),
    );
  }

  return rows;
}

function describeRule(rule) {
  const lines = [];
  if (rule.roleIds?.length) lines.push(`**Roles:** ${rule.roleIds.map((id) => `<@&${id}>`).join(' ')}`);
  if (rule.userIds?.length) lines.push(`**Users:** ${rule.userIds.map((id) => `<@${id}>`).join(' ')}`);
  return lines.join('\n');
}

/**
 * The "who can use this" screen.
 * commandName === DASHBOARD_TARGET edits who may open the dashboard instead of a command.
 */
export async function buildAccessEditorView(client, guildId, guild, categoryKey, commandName) {
  const config = await getGuildConfig(client, guildId);
  const snapshot = getCommandAccessSnapshot(client, config);
  const isDashboard = commandName === DASHBOARD_TARGET;
  const category = isDashboard ? null : snapshot.categories.find((entry) => entry.key === categoryKey);

  if (!isDashboard && !category) {
    return { embed: buildOverviewEmbed(snapshot, guild), components: buildOverviewComponents(guildId, snapshot) };
  }

  const selectable = isDashboard ? [] : category.commands.filter((command) => !command.protected);
  let target = commandName;
  if (!isDashboard && (!target || !selectable.some((command) => command.name === target))) {
    target = selectable[0]?.name || null;
  }
  if (!isDashboard && !target) {
    return { embed: buildCategoryEmbed(category, guild), components: buildCategoryComponents(guildId, category) };
  }

  const rules = config.commandPermissions || {};
  const rule = isDashboard
    ? await getDashboardAccessRule(client, guildId)
    : (await getCommandPermissionRule(client, guildId, target)).rule || { mode: 'everyone', roleIds: [], userIds: [] };

  const mode = ['roles', 'users'].includes(rule.mode) ? 'custom' : rule.mode;
  const validRoleIds = (rule.roleIds || []).filter((id) => guild.roles.cache.has(id));
  const tokenSuffix = `${isDashboard ? '-' : categoryKey}:${target}`;

  const fields = [
    { name: 'Who can use it', value: MODE_LABELS[mode] || MODE_LABELS.everyone, inline: false },
  ];
  const listText = describeRule(rule);
  if (mode === 'custom') {
    fields.push({ name: 'Chosen', value: listText || '_Nobody picked yet — only server administrators can use it until you choose roles or users below._', inline: false });
  }
  fields.push({
    name: 'Good to know',
    value: [
      '• Server administrators, the server owner and the bot owner can always use everything.',
      isDashboard
        ? '• Anyone allowed here can open this dashboard, but only Manage Server members can change these settings.'
        : '• The command\'s own Discord permission requirements still apply on top (for example Ban Members).',
      '• `/commands` and `/configwizard` can never be locked.',
    ].join('\n'),
  });

  const embed = createEmbed({
    title: isDashboard ? '🔐 Who can open this dashboard' : `👥 Who can use /${target}`,
    description: isDashboard
      ? 'Choose who is allowed to open the command dashboard.'
      : `Category: **${category.displayName}** — pick a command, then choose who may use it.`,
    color: mode === 'everyone' ? 'info' : 'warning',
    fields,
  });

  const rows = [];

  if (!isDashboard) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(customId(DASHBOARD_PERM_COMMAND, guildId, categoryKey))
          .setPlaceholder('Pick a command...')
          .addOptions(
            selectable.slice(0, 25).map((command) => {
              const commandRule = rules[command.name.toLowerCase()];
              const summary = commandRule
                ? (MODE_LABELS[['roles', 'users'].includes(commandRule.mode) ? 'custom' : commandRule.mode] || 'Restricted')
                : MODE_LABELS.everyone;
              return new StringSelectMenuOptionBuilder()
                .setLabel((command.isSubcommand ? command.name.replace(' ', ' · ') : command.name).slice(0, 100))
                .setDescription(summary.replace(/\*\*/g, '').slice(0, 100))
                .setValue(command.name.slice(0, 100))
                .setDefault(command.name === target);
            }),
          ),
      ),
    );
  }

  rows.push(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(customId(DASHBOARD_PERM_MODE, guildId, tokenSuffix))
        .setPlaceholder('Who can use it?')
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel('Everyone').setValue('everyone').setEmoji('🌐')
            .setDescription('No extra restriction').setDefault(mode === 'everyone'),
          new StringSelectMenuOptionBuilder().setLabel('Server administrators only').setValue('admins').setEmoji('🛡️')
            .setDescription('Members with Manage Server').setDefault(mode === 'admins'),
          new StringSelectMenuOptionBuilder().setLabel('Specific roles / users').setValue('custom').setEmoji('👥')
            .setDescription('Pick the roles and users below').setDefault(mode === 'custom'),
        ),
    ),
  );

  if (mode === 'custom') {
    const roleSelect = new RoleSelectMenuBuilder()
      .setCustomId(customId(DASHBOARD_PERM_ROLES, guildId, tokenSuffix))
      .setPlaceholder('🎭 Roles allowed...')
      .setMinValues(0)
      .setMaxValues(25);
    if (validRoleIds.length > 0) roleSelect.setDefaultRoles(validRoleIds);

    const userSelect = new UserSelectMenuBuilder()
      .setCustomId(customId(DASHBOARD_PERM_USERS, guildId, tokenSuffix))
      .setPlaceholder('👤 Users allowed...')
      .setMinValues(0)
      .setMaxValues(25);
    if ((rule.userIds || []).length > 0) userSelect.setDefaultUsers(rule.userIds.slice(0, 25));

    rows.push(new ActionRowBuilder().addComponents(roleSelect));
    rows.push(new ActionRowBuilder().addComponents(userSelect));
  }

  const buttons = [
    new ButtonBuilder()
      .setCustomId(isDashboard ? customId(DASHBOARD_HOME, guildId) : customId(DASHBOARD_PERM_BACK, guildId, categoryKey))
      .setLabel('Back')
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary),
  ];
  if (!isDashboard) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(customId(DASHBOARD_PERM_RESET, guildId, tokenSuffix))
        .setLabel('Allow everyone')
        .setEmoji('🌐')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(mode === 'everyone'),
    );
  }
  rows.push(new ActionRowBuilder().addComponents(buttons));

  return { embed, components: rows };
}

async function handleAccessEditorComponent(interaction, client, action, parts, guildId) {
  const categoryKey = parts[2] === '-' ? null : parts[2];
  const target = parts.slice(3).join(':') || null;
  const isDashboard = action === DASHBOARD_ACCESS_OPEN || target === DASHBOARD_TARGET;

  const show = async (cmd) => {
    const view = await buildAccessEditorView(client, guildId, interaction.guild, categoryKey, isDashboard ? DASHBOARD_TARGET : cmd);
    return interaction.update({ embeds: [view.embed], components: view.components });
  };

  if (action === DASHBOARD_ACCESS_OPEN) return show(DASHBOARD_TARGET);
  if (action === DASHBOARD_PERM_OPEN) return show(null);
  if (action === DASHBOARD_PERM_COMMAND) return show(interaction.values[0]);

  if (action === DASHBOARD_PERM_BACK) {
    const view = await buildDashboardView(client, guildId, interaction.guild, 'category', parts[2]);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  // Everything below changes settings.
  if (!canManageAccessPolicy(interaction)) {
    return interaction.reply({
      content: 'You need the **Manage Server** permission to change who can use commands.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const current = isDashboard
    ? await getDashboardAccessRule(client, guildId)
    : (await getCommandPermissionRule(client, guildId, target)).rule || { mode: 'everyone', roleIds: [], userIds: [] };

  let next;
  if (action === DASHBOARD_PERM_MODE) {
    next = { mode: interaction.values[0], roleIds: current.roleIds, userIds: current.userIds };
  } else if (action === DASHBOARD_PERM_ROLES) {
    next = { mode: 'custom', roleIds: interaction.values, userIds: current.userIds };
  } else if (action === DASHBOARD_PERM_USERS) {
    next = { mode: 'custom', roleIds: current.roleIds, userIds: interaction.values };
  } else if (action === DASHBOARD_PERM_RESET) {
    next = { mode: 'everyone', roleIds: [], userIds: [] };
  } else {
    return show(target);
  }

  if (isDashboard) await setDashboardAccessPolicy(client, guildId, next);
  else await setCommandPermissionAccess(client, guildId, target, next);

  return show(target);
}

export async function buildDashboardView(client, guildId, guild, view = 'overview', categoryKey = null) {
  const config = await getGuildConfig(client, guildId);
  const snapshot = getCommandAccessSnapshot(client, config);

  if (view === 'category' && categoryKey) {
    const category = snapshot.categories.find((entry) => entry.key === categoryKey);
    if (!category) {
      return {
        embed: buildOverviewEmbed(snapshot, guild),
        components: buildOverviewComponents(guildId, snapshot),
      };
    }

    return {
      embed: buildCategoryEmbed(category, guild),
      components: buildCategoryComponents(guildId, category),
      categoryKey,
    };
  }

  return {
    embed: buildOverviewEmbed(snapshot, guild),
    components: buildOverviewComponents(guildId, snapshot),
  };
}

export async function handleDashboardComponent(interaction, client) {
  const parts = interaction.customId.split(':');
  const action = parts[0];
  const guildId = parts[1];
  const suffix = parts[2] || null;

  if (guildId !== interaction.guildId) {
    return interaction.reply({
      content: 'This dashboard belongs to another server.',
      ephemeral: true,
    });
  }

  if (action.startsWith('cmdaccess_perm_') || action === DASHBOARD_ACCESS_OPEN) {
    return handleAccessEditorComponent(interaction, client, action, parts, guildId);
  }

  if (action === DASHBOARD_COMMAND_SELECT) {
    const categoryKey = suffix;
    const commandName = interaction.values[0];
    const config = await getGuildConfig(client, guildId);
    const snapshot = getCommandAccessSnapshot(client, config);
    const category = snapshot.categories.find((entry) => entry.key === categoryKey);
    const enabled = category?.enabledCommands.includes(commandName);

    if (enabled) {
      await disableCommand(client, guildId, commandName);
    } else {
      await enableCommand(client, guildId, commandName);
    }

    const view = await buildDashboardView(client, guildId, interaction.guild, 'category', categoryKey);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (action === DASHBOARD_CATEGORY_SELECT) {
    const categoryKey = interaction.values[0];
    const view = await buildDashboardView(client, guildId, interaction.guild, 'category', categoryKey);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  await interaction.deferUpdate();

  if (action === DASHBOARD_REFRESH || action === DASHBOARD_HOME) {
    const view = await buildDashboardView(client, guildId, interaction.guild, 'overview');
    return interaction.editReply({ embeds: [view.embed], components: view.components });
  }

  if (action === DASHBOARD_TOGGLE_CATEGORY) {
    const categoryKey = suffix;
    const config = await getGuildConfig(client, guildId);
    const snapshot = getCommandAccessSnapshot(client, config);
    const category = snapshot.categories.find((entry) => entry.key === categoryKey);

    if (category?.categoryDisabled) {
      await enableCategory(client, guildId, categoryKey);
    } else {
      await disableCategory(client, guildId, categoryKey);
    }

    const view = await buildDashboardView(client, guildId, interaction.guild, 'category', categoryKey);
    return interaction.editReply({ embeds: [view.embed], components: view.components });
  }

  if (action === DASHBOARD_ENABLE_ALL) {
    await enableCategory(client, guildId, suffix);
    await resetCategoryCommands(client, guildId, suffix);
    const view = await buildDashboardView(client, guildId, interaction.guild, 'category', suffix);
    return interaction.editReply({ embeds: [view.embed], components: view.components });
  }

  if (action === DASHBOARD_DISABLE_ALL) {
    await disableCategory(client, guildId, suffix);
    const view = await buildDashboardView(client, guildId, interaction.guild, 'category', suffix);
    return interaction.editReply({ embeds: [view.embed], components: view.components });
  }

  if (action === DASHBOARD_RESET_COMMANDS) {
    await enableCategory(client, guildId, suffix);
    await resetCategoryCommands(client, guildId, suffix);
    const view = await buildDashboardView(client, guildId, interaction.guild, 'category', suffix);
    return interaction.editReply({ embeds: [view.embed], components: view.components });
  }

  return interaction.editReply({ content: 'Unknown dashboard action.', embeds: [], components: [] });
}

export function isCommandAccessCustomId(customIdValue) {
  return customIdValue.startsWith('cmdaccess_');
}

export function createDashboardCollectorFilter(userId, guildId) {
  return (componentInteraction) =>
    componentInteraction.user.id === userId &&
    componentInteraction.customId.includes(`:${guildId}`);
}
