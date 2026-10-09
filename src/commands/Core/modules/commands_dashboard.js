import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  RoleSelectMenuBuilder,
  UserSelectMenuBuilder,
  EmbedBuilder,
} from 'discord.js';
import { createEmbed } from '../../../utils/embeds.js';
import {
  getCommandAccessSnapshot,
  disableCategory,
  enableCategory,
  disableCommand,
  enableCommand,
  resetCategoryCommands,
  resolveCommandTarget,
} from '../../../services/commandAccessService.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import {
  getCommandRestrictions,
  setCommandRoles,
  setCommandUsers,
  clearCommandRestrictions,
} from '../../../services/commandRoleService.js';

export const DASHBOARD_CATEGORY_SELECT = 'cmdaccess_category';
export const DASHBOARD_COMMAND_SELECT = 'cmdaccess_command';
export const DASHBOARD_TOGGLE_CATEGORY = 'cmdaccess_toggle_category';
export const DASHBOARD_ENABLE_ALL = 'cmdaccess_enable_all';
export const DASHBOARD_DISABLE_ALL = 'cmdaccess_disable_all';
export const DASHBOARD_RESET_COMMANDS = 'cmdaccess_reset_commands';
export const DASHBOARD_REFRESH = 'cmdaccess_refresh';
export const DASHBOARD_HOME = 'cmdaccess_home';

// Permission & "Who Can Use" action custom IDs
export const DASHBOARD_PERMS_VIEW = 'cmdaccess_perms_view';
export const DASHBOARD_CMD_PERMS = 'cmdaccess_cmd_perms';
export const DASHBOARD_SET_ROLES = 'cmdaccess_set_roles';
export const DASHBOARD_SET_USERS = 'cmdaccess_set_users';
export const DASHBOARD_CLEAR_RESTRICTIONS = 'cmdaccess_clear_rest';
export const DASHBOARD_TOGGLE_SINGLE_CMD = 'cmdaccess_toggle_cmd';

const STATUS = {
  enabled: '🟢',
  partial: '🟡',
  disabled: '🔴',
  restricted: '🔐',
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

// ─── Screen 1: Overview ───────────────────────────────────────────────────────

export function buildOverviewEmbed(snapshot, guild, restrictions = {}) {
  const fullyEnabled = snapshot.categories.filter((c) => !c.categoryDisabled && c.disabledCount === 0).length;
  const partial = snapshot.categories.filter((c) => !c.categoryDisabled && c.disabledCount > 0).length;
  const disabled = snapshot.categories.filter((c) => c.categoryDisabled).length;

  const restrictedCmdCount = Object.keys(restrictions.commandRoles || {}).length +
    Object.keys(restrictions.commandUsers || {}).length;

  const categoryLines = snapshot.categories.map((category) => {
    const icon = getCategoryStatus(category);
    const subcommandNote = category.commands.some((c) => c.isSubcommand) ? ' · incl. subcommands' : '';
    return `${icon} ${category.icon} **${category.displayName}** — ${category.enabledCount}/${category.totalCount}${subcommandNote}`;
  });

  const fields = [
    {
      name: '📊 Summary',
      value: [
        `**${snapshot.enabledTotal}/${snapshot.totalCommands}** commands enabled`,
        `${STATUS.enabled} ${fullyEnabled} fully on · ${STATUS.partial} ${partial} partial · ${STATUS.disabled} ${disabled} off`,
        `🔐 **${restrictedCmdCount}** command(s) with custom role/user permissions`,
      ].join('\n'),
      inline: false,
    },
    {
      name: '🔑 Legend',
      value: `${STATUS.enabled} All enabled · ${STATUS.partial} Some disabled · ${STATUS.disabled} Category off · 🔐 Role/User restricted`,
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
    name: '💡 Quick Actions',
    value: [
      '• Select a category below to browse commands and configure permissions',
      '• Click **Who Can Use What** to view all custom restricted commands',
      '• Bot owners, server owner & Admins bypass all restrictions everywhere',
    ].join('\n'),
  });

  return createEmbed({
    title: '⚙️ Command Access & Permissions',
    description: `Manage commands and configure who can use which command in **${guild.name}**.`,
    color: 'info',
    fields,
    footer: '🔒 commands & configwizard always stay available',
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
        .setPlaceholder('📁 Select a category to manage commands...')
        .addOptions(categoryOptions),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(customId(DASHBOARD_PERMS_VIEW, guildId))
        .setLabel('Who Can Use What (Permissions)')
        .setEmoji('🔐')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(customId(DASHBOARD_REFRESH, guildId))
        .setLabel('Refresh')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ─── Screen 2: Category View ──────────────────────────────────────────────────

export function buildCategoryEmbed(category, guild, restrictions = {}) {
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

    const cmdKey = command.name.toLowerCase();
    const hasRoles = restrictions.commandRoles?.[cmdKey]?.length > 0;
    const hasUsers = restrictions.commandUsers?.[cmdKey]?.length > 0;
    const restIcon = (hasRoles || hasUsers) ? ' 🔐' : '';

    return `${icon} ${formatCommandLabel(command)}${lock}${restIcon}`;
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
    name: 'How to Manage',
    value: [
      '• Select any command below to **choose which roles or users can use it**',
      '• Use the buttons to enable or disable the whole category at once',
    ].join('\n'),
  });

  return createEmbed({
    title: `${category.icon} ${category.displayName}`,
    description: `Manage commands and access restrictions for **${guild.name}**.`,
    color: category.categoryDisabled ? 'error' : category.disabledCount > 0 ? 'warning' : 'success',
    fields,
    footer: '🔒 Protected commands cannot be disabled',
  });
}

export function buildCategoryComponents(guildId, category, restrictions = {}) {
  const selectableCommands = category.commands.filter((command) => !command.protected);
  const commandOptions = selectableCommands.slice(0, 25).map((command) => {
    const enabled = category.enabledCommands.includes(command.name);
    const cmdKey = command.name.toLowerCase();
    const roleCount = restrictions.commandRoles?.[cmdKey]?.length || 0;
    const userCount = restrictions.commandUsers?.[cmdKey]?.length || 0;

    let restrictionText = '🌐 Everyone with base perms';
    if (roleCount > 0 && userCount > 0) {
      restrictionText = `🔐 ${roleCount} role(s), ${userCount} user(s)`;
    } else if (roleCount > 0) {
      restrictionText = `🔐 ${roleCount} role(s) only`;
    } else if (userCount > 0) {
      restrictionText = `🔐 ${userCount} user(s) only`;
    }

    const label = command.isSubcommand
      ? command.name.replace(' ', ' · ').slice(0, 100)
      : command.name.slice(0, 100);

    return new StringSelectMenuOptionBuilder()
      .setLabel(label)
      .setDescription(`${enabled ? '🟢' : '🔴'} ${restrictionText}`.slice(0, 100))
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

  if (commandOptions.length > 0) {
    rows.unshift(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(customId(DASHBOARD_COMMAND_SELECT, guildId, category.key))
          .setPlaceholder('⚙️ Select a command to configure permissions & status...')
          .addOptions(commandOptions),
      ),
    );
  }

  return rows;
}

// ─── Screen 3: Command Access / Permissions Management ────────────────────────

export function buildCommandPermsEmbed(commandName, commandTarget, isEnabled, restrictions, guild) {
  const cmdKey = commandName.toLowerCase();
  const allowedRoles = restrictions.commandRoles?.[cmdKey] || [];
  const allowedUsers = restrictions.commandUsers?.[cmdKey] || [];

  const rolesText = allowedRoles.length > 0
    ? allowedRoles.map((id) => `<@&${id}>`).join(', ')
    : '`Unrestricted` (any role with standard Discord permission)';

  const usersText = allowedUsers.length > 0
    ? allowedUsers.map((id) => `<@${id}>`).join(', ')
    : '`Unrestricted` (any user with standard Discord permission)';

  const statusText = isEnabled
    ? '🟢 **Enabled** in this server'
    : '🔴 **Disabled** in this server';

  const embed = new EmbedBuilder()
    .setTitle(`🔐 Permissions: /${commandName}`)
    .setDescription(
      `Configure who can use \`/${commandName}\` in **${guild.name}**.\n\n` +
      `**Description:** ${commandTarget?.description || 'No description'}\n` +
      `**Current Status:** ${statusText}\n\n` +
      '> 💡 **Universal Bypass:** Bot owners, the server owner, and server Administrators can run any command regardless of role/user restrictions.',
    )
    .setColor(isEnabled ? (allowedRoles.length || allowedUsers.length ? 0xFEE75C : 0x57F287) : 0xED4245)
    .addFields(
      {
        name: '🛡️ Allowed Roles',
        value: rolesText,
        inline: false,
      },
      {
        name: '👤 Allowed Users',
        value: usersText,
        inline: false,
      },
      {
        name: '📋 How to configure below',
        value: [
          '• **Select Roles:** Choose which role(s) are allowed to use this command',
          '• **Select Users:** Choose specific user(s) allowed to use this command',
          '• **Enable / Disable:** Toggle command on or off for this server',
          '• **Reset to Everyone:** Remove all role & user restrictions',
        ].join('\n'),
        inline: false,
      },
    )
    .setFooter({ text: 'Changes apply immediately' })
    .setTimestamp();

  return embed;
}

export function buildCommandPermsComponents(guildId, commandName, isEnabled, categoryKey = null) {
  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId(customId(DASHBOARD_SET_ROLES, guildId, commandName))
    .setPlaceholder('🛡️ Select role(s) allowed to use this command...')
    .setMinValues(1)
    .setMaxValues(10);

  const userSelect = new UserSelectMenuBuilder()
    .setCustomId(customId(DASHBOARD_SET_USERS, guildId, commandName))
    .setPlaceholder('👤 Select user(s) allowed to use this command...')
    .setMinValues(1)
    .setMaxValues(10);

  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId(DASHBOARD_CATEGORY_SELECT, guildId, categoryKey || 'home'))
      .setLabel('Back to Category')
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(customId(DASHBOARD_TOGGLE_SINGLE_CMD, guildId, commandName))
      .setLabel(isEnabled ? 'Disable Command' : 'Enable Command')
      .setEmoji(isEnabled ? '🔴' : '🟢')
      .setStyle(isEnabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(customId(DASHBOARD_CLEAR_RESTRICTIONS, guildId, commandName))
      .setLabel('Reset to Everyone')
      .setEmoji('🧹')
      .setStyle(ButtonStyle.Primary),
  );

  return [
    new ActionRowBuilder().addComponents(roleSelect),
    new ActionRowBuilder().addComponents(userSelect),
    buttonRow,
  ];
}

// ─── Screen 4: "Who Can Use What" Overview ────────────────────────────────────

export function buildPermsOverviewEmbed(restrictions, guild, snapshot) {
  const cmdRoles = restrictions.commandRoles || {};
  const cmdUsers = restrictions.commandUsers || {};

  const allRestrictedKeys = Array.from(new Set([...Object.keys(cmdRoles), ...Object.keys(cmdUsers)]));

  const lines = allRestrictedKeys.length > 0
    ? allRestrictedKeys.map((cmd) => {
        const roles = cmdRoles[cmd] || [];
        const users = cmdUsers[cmd] || [];
        const parts = [];
        if (roles.length > 0) parts.push(`Roles: ${roles.map((id) => `<@&${id}>`).join(' ')}`);
        if (users.length > 0) parts.push(`Users: ${users.map((id) => `<@${id}>`).join(' ')}`);
        return `• \`/${cmd}\` → ${parts.join(' | ')}`;
      })
    : ['`No commands have custom role or user restrictions.`\nAll commands are available according to their base Discord permissions.'];

  return new EmbedBuilder()
    .setTitle('🔐 Who Can Use What (Active Permissions)')
    .setDescription(
      `Overview of all role and user restricted commands in **${guild.name}**.\n\n` +
      '> 👑 **Bot Owner Access:** Bot owners bypass all restrictions in ANY server.\n' +
      '> 🛡️ **Server Owner & Admin Access:** Guild owners and Admins bypass all restrictions.\n\n' +
      'To restrict or unrestrict any command, select a category below and pick the command!',
    )
    .setColor(0x5865F2)
    .addFields({
      name: `Restricted Commands (${allRestrictedKeys.length})`,
      value: lines.slice(0, 25).join('\n') || 'None',
      inline: false,
    })
    .setFooter({ text: 'Select a category below to configure any command' })
    .setTimestamp();
}

export function buildPermsOverviewComponents(guildId, snapshot) {
  const categoryOptions = snapshot.categories.slice(0, 25).map((category) => {
    return new StringSelectMenuOptionBuilder()
      .setLabel(`${category.displayName}`.slice(0, 100))
      .setDescription(`Browse and configure ${category.displayName} commands`.slice(0, 100))
      .setValue(category.key)
      .setEmoji(category.icon);
  });

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(customId(DASHBOARD_CATEGORY_SELECT, guildId))
        .setPlaceholder('📁 Pick a category to configure commands...')
        .addOptions(categoryOptions),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(customId(DASHBOARD_HOME, guildId))
        .setLabel('Overview')
        .setEmoji('🏠')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(customId(DASHBOARD_PERMS_VIEW, guildId))
        .setLabel('Refresh')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ─── Central View Builder ─────────────────────────────────────────────────────

export async function buildDashboardView(client, guildId, guild, view = 'overview', targetKey = null) {
  const config = await getGuildConfig(client, guildId);
  const snapshot = getCommandAccessSnapshot(client, config);
  const restrictions = await getCommandRestrictions(client, guildId);

  // Command permission detail screen
  if (view === 'command_perms' && targetKey) {
    const commandTarget = resolveCommandTarget(client, targetKey);
    const category = snapshot.categories.find((c) =>
      c.commands.some((cmd) => cmd.name.toLowerCase() === targetKey.toLowerCase()),
    );
    const isEnabled = !snapshot.disabledCommands[targetKey.toLowerCase()] && !category?.categoryDisabled;

    return {
      embed: buildCommandPermsEmbed(targetKey, commandTarget, isEnabled, restrictions, guild),
      components: buildCommandPermsComponents(guildId, targetKey, isEnabled, category?.key),
      categoryKey: category?.key,
      commandName: targetKey,
    };
  }

  // Category view
  if (view === 'category' && targetKey) {
    const category = snapshot.categories.find((entry) => entry.key === targetKey);
    if (!category) {
      return {
        embed: buildOverviewEmbed(snapshot, guild, restrictions),
        components: buildOverviewComponents(guildId, snapshot),
      };
    }

    return {
      embed: buildCategoryEmbed(category, guild, restrictions),
      components: buildCategoryComponents(guildId, category, restrictions),
      categoryKey: targetKey,
    };
  }

  // Permissions summary screen
  if (view === 'perms_overview') {
    return {
      embed: buildPermsOverviewEmbed(restrictions, guild, snapshot),
      components: buildPermsOverviewComponents(guildId, snapshot),
    };
  }

  // Overview (default)
  return {
    embed: buildOverviewEmbed(snapshot, guild, restrictions),
    components: buildOverviewComponents(guildId, snapshot),
  };
}

// ─── Interactive Component Handler ────────────────────────────────────────────

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

  // 1. Role Select Menu — Admin picked roles allowed for this command
  if (action === DASHBOARD_SET_ROLES) {
    await interaction.deferUpdate();
    const commandName = suffix;
    const selectedRoles = interaction.values || [];
    await setCommandRoles(client, guildId, commandName, selectedRoles);

    const view = await buildDashboardView(client, guildId, interaction.guild, 'command_perms', commandName);
    return interaction.editReply({ embeds: [view.embed], components: view.components });
  }

  // 2. User Select Menu — Admin picked users allowed for this command
  if (action === DASHBOARD_SET_USERS) {
    await interaction.deferUpdate();
    const commandName = suffix;
    const selectedUsers = interaction.values || [];
    await setCommandUsers(client, guildId, commandName, selectedUsers);

    const view = await buildDashboardView(client, guildId, interaction.guild, 'command_perms', commandName);
    return interaction.editReply({ embeds: [view.embed], components: view.components });
  }

  // 3. Clear Restrictions Button — Reset to everyone
  if (action === DASHBOARD_CLEAR_RESTRICTIONS) {
    await interaction.deferUpdate();
    const commandName = suffix;
    await clearCommandRestrictions(client, guildId, commandName);

    const view = await buildDashboardView(client, guildId, interaction.guild, 'command_perms', commandName);
    return interaction.editReply({ embeds: [view.embed], components: view.components });
  }

  // 4. Toggle Single Command Enable/Disable
  if (action === DASHBOARD_TOGGLE_SINGLE_CMD) {
    await interaction.deferUpdate();
    const commandName = suffix;
    const config = await getGuildConfig(client, guildId);
    const snapshot = getCommandAccessSnapshot(client, config);
    const isCurrentlyDisabled = Boolean(snapshot.disabledCommands[commandName.toLowerCase()]);

    if (isCurrentlyDisabled) {
      await enableCommand(client, guildId, commandName);
    } else {
      await disableCommand(client, guildId, commandName);
    }

    const view = await buildDashboardView(client, guildId, interaction.guild, 'command_perms', commandName);
    return interaction.editReply({ embeds: [view.embed], components: view.components });
  }

  // 5. Command Picked from Category List -> Open Command Permissions Detail
  if (action === DASHBOARD_COMMAND_SELECT) {
    await interaction.deferUpdate();
    const commandName = interaction.values[0];
    const view = await buildDashboardView(client, guildId, interaction.guild, 'command_perms', commandName);
    return interaction.editReply({ embeds: [view.embed], components: view.components });
  }

  // 6. Category Select Menu
  if (action === DASHBOARD_CATEGORY_SELECT) {
    await interaction.deferUpdate();
    const categoryKey = interaction.values?.[0] || suffix;

    if (!categoryKey || categoryKey === 'home') {
      const view = await buildDashboardView(client, guildId, interaction.guild, 'overview');
      return interaction.editReply({ embeds: [view.embed], components: view.components });
    }

    const view = await buildDashboardView(client, guildId, interaction.guild, 'category', categoryKey);
    return interaction.editReply({ embeds: [view.embed], components: view.components });
  }

  // 7. Permissions Overview Screen
  if (action === DASHBOARD_PERMS_VIEW) {
    await interaction.deferUpdate();
    const view = await buildDashboardView(client, guildId, interaction.guild, 'perms_overview');
    return interaction.editReply({ embeds: [view.embed], components: view.components });
  }

  await interaction.deferUpdate();

  // 8. Overview / Home / Refresh
  if (action === DASHBOARD_REFRESH || action === DASHBOARD_HOME) {
    const view = await buildDashboardView(client, guildId, interaction.guild, 'overview');
    return interaction.editReply({ embeds: [view.embed], components: view.components });
  }

  // 9. Category Actions
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
