import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  RoleSelectMenuBuilder,
  UserSelectMenuBuilder,
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
import { setCommandPermissionRule, getCommandPermissionRule } from '../../../services/commandPermissionsService.js';
import { buildCommandRegistry, isProtectedCommand } from '../../../services/commandAccessService.js';

export const DASHBOARD_CATEGORY_SELECT = 'cmdaccess_category';
export const DASHBOARD_COMMAND_SELECT = 'cmdaccess_command';
export const DASHBOARD_TOGGLE_CATEGORY = 'cmdaccess_toggle_category';
export const DASHBOARD_ENABLE_ALL = 'cmdaccess_enable_all';
export const DASHBOARD_DISABLE_ALL = 'cmdaccess_disable_all';
export const DASHBOARD_RESET_COMMANDS = 'cmdaccess_reset_commands';
export const DASHBOARD_REFRESH = 'cmdaccess_refresh';
export const DASHBOARD_HOME = 'cmdaccess_home';
export const DASHBOARD_PERMISSIONS = 'cmdaccess_permissions';
export const DASHBOARD_PERMISSION_COMMAND = 'cmdaccess_permission_command';
export const DASHBOARD_PERMISSION_MODE = 'cmdaccess_permission_mode';
export const DASHBOARD_PERMISSION_ROLE = 'cmdaccess_permission_role';
export const DASHBOARD_PERMISSION_USER = 'cmdaccess_permission_user';
export const DASHBOARD_PERMISSION_CATEGORY = 'cmdaccess_permission_category';
export const DASHBOARD_PERMISSION_CATEGORY_MODE = 'cmdaccess_permission_category_mode';
export const DASHBOARD_PERMISSION_CATEGORY_ROLE = 'cmdaccess_permission_category_role';
export const DASHBOARD_PERMISSION_CATEGORY_USER = 'cmdaccess_permission_category_user';

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
      '• `/commands permission` — choose who can use a command (everyone, roles, users, or admins)',
      '• `/commands dashboard-access` — choose who can open this dashboard (Manage Server required to change this)',
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
        .setCustomId(customId(DASHBOARD_PERMISSIONS, guildId))
        .setLabel('Manage Permissions')
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

async function buildPermissionCategoryView(client, guildId, selectedCategoryKey = null) {
  const registry = buildCommandRegistry(client);
  const categories = [...registry.values()].map((category) => ({
    ...category,
    commands: category.commands.filter((command) => !isProtectedCommand(command.name) && !isProtectedCommand(command.name.split(' ')[0])),
  })).filter((category) => category.commands.length > 0);

  // Show the effective saved dashboard mode for every category, based on the
  // individual command rules already stored for its commands.
  const modeLabels = { everyone: 'Everyone', admins: 'Server admins', roles: 'Selected roles', users: 'Selected users' };
  for (const category of categories) {
    const rules = await Promise.all(category.commands.map(async (command) => {
      const state = await getCommandPermissionRule(client, guildId, command.name);
      return state?.rule || null;
    }));
    const signatures = new Set(rules.map((rule) => {
      if (!rule) return 'default';
      const ids = rule.mode === 'roles' ? (rule.roleIds || []).slice().sort().join(',')
        : rule.mode === 'users' ? (rule.userIds || []).slice().sort().join(',') : '';
      return `${rule.mode}:${ids}`;
    }));
    if (signatures.size === 1) {
      const rule = rules[0];
      if (!rule) category.currentPermissionMode = 'Default';
      else if (rule.mode === 'roles' && (rule.roleIds || []).length === 0) category.currentPermissionMode = 'Selected roles (none set)';
      else if (rule.mode === 'users' && (rule.userIds || []).length === 0) category.currentPermissionMode = 'Selected users (none set)';
      else category.currentPermissionMode = modeLabels[rule.mode] || 'Default';
    } else {
      category.currentPermissionMode = 'Mixed modes';
    }
  }

  const selectedCategory = categories.find((category) => category.key === selectedCategoryKey) || null;
  const categoryOptions = categories.slice(0, 25).map((category) => new StringSelectMenuOptionBuilder()
    .setLabel(category.displayName.slice(0, 100))
    .setDescription(`${category.currentPermissionMode} · ${category.commands.length} commands`.slice(0, 100))
    .setValue(category.key)
    .setEmoji(category.icon));
  const rows = [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId(DASHBOARD_PERMISSION_CATEGORY, guildId))
      .setPlaceholder(selectedCategory ? `Category: ${selectedCategory.displayName}`.slice(0, 150) : 'Choose a command category...')
      .addOptions(categoryOptions),
  )];
  if (selectedCategory) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(customId(DASHBOARD_PERMISSION_CATEGORY_MODE, guildId, encodeURIComponent(selectedCategory.key)))
        .setPlaceholder(`Set permissions for all ${selectedCategory.displayName} commands...`.slice(0, 150))
        .addOptions(
          { label: 'Everyone', value: 'everyone', description: 'Anyone may use commands in this category' },
          { label: 'Server administrators', value: 'admins', description: 'Only administrators / Manage Server' },
          { label: 'Selected roles', value: 'roles', description: 'Allow selected roles for every command' },
          { label: 'Selected users', value: 'users', description: 'Allow selected users for every command' },
        ),
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId(DASHBOARD_HOME, guildId)).setLabel('Back').setEmoji('◀️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(customId(DASHBOARD_REFRESH, guildId)).setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
  ));
  const embed = createEmbed({
    title: '🔐 Category Permissions',
    description: selectedCategory
      ? `**${selectedCategory.displayName} — current mode: ${selectedCategory.currentPermissionMode}**\n\nSet the same access rule for **all configurable commands** in **${selectedCategory.displayName}** (${selectedCategory.commands.length} commands). This overwrites existing custom permission rules for those commands.`
      : 'Choose a category to set access for all its commands at once. The dropdown description shows each category’s currently saved mode. “Mixed modes” means its commands have different permission settings; “Default” means no custom rule is saved.',
    color: 'info',
    footer: 'Bot owner and server owner retain access; protected commands are excluded.',
  });
  return { embed, components: rows };
}
async function applyPermissionRuleToCategory(client, guildId, categoryKey, mode, target = null) {
  const category = buildCommandRegistry(client).get(categoryKey);
  if (!category) throw new Error('That command category could not be found. Refresh the dashboard and try again.');
  const commands = category.commands.filter((command) => !isProtectedCommand(command.name) && !isProtectedCommand(command.name.split(' ')[0]));
  let changed = 0;
  for (const command of commands) {
    if (mode === 'roles') {
      await setCommandPermissionRule(client, guildId, command.name, mode, { roleId: target.roleId });
    } else if (mode === 'users') {
      await setCommandPermissionRule(client, guildId, command.name, mode, { userId: target.userId });
    } else {
      await setCommandPermissionRule(client, guildId, command.name, mode);
    }
    changed += 1;
  }
  return changed;
}

function buildPermissionCommandView(client, guildId, selectedCommand = null, rule = null) {
  const registry = buildCommandRegistry(client);
  const commands = [];
  for (const category of registry.values()) {
    for (const command of category.commands) {
      if (!isProtectedCommand(command.name) && !isProtectedCommand(command.name.split(' ')[0])) commands.push(command.name);
    }
  }
  commands.sort((a, b) => a.localeCompare(b));
  // Discord limits a select menu to 25 entries. Keep /lock explicitly available even
  // when the bot has more than 25 commands and alphabetical truncation would hide it.
  const visibleCommands = commands.includes('lock')
    ? ['lock', ...commands.filter((name) => name !== 'lock').slice(0, 24)]
    : commands.slice(0, 25);
  const commandOptions = visibleCommands.map((name) => new StringSelectMenuOptionBuilder()
    .setLabel(`/${name}`.slice(0, 100))
    .setValue(name)
    .setDescription('Choose command to configure'.slice(0, 100)));
  const rows = [];
  if (commandOptions.length) rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId(DASHBOARD_PERMISSION_COMMAND, guildId))
      .setPlaceholder(selectedCommand ? `Selected: /${selectedCommand}`.slice(0, 150) : 'Select a command...')
      .addOptions(commandOptions)));
  if (selectedCommand) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(customId(DASHBOARD_PERMISSION_MODE, guildId, encodeURIComponent(selectedCommand)))
        .setPlaceholder(`Access mode for /${selectedCommand}`.slice(0, 150))
        .addOptions(
          { label: 'Everyone', value: 'everyone', description: 'Anyone may use it, subject to built-in checks' },
          { label: 'Server administrators', value: 'admins', description: 'Only administrators / Manage Server' },
          { label: 'Selected roles', value: 'roles', description: 'Choose a role in the next step' },
          { label: 'Selected users', value: 'users', description: 'Choose a user in the next step' },
        )));
    if (rule?.mode === 'roles') rows.push(new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder().setCustomId(customId(DASHBOARD_PERMISSION_ROLE, guildId, encodeURIComponent(selectedCommand)))
        .setPlaceholder('Select role(s) to allow').setMinValues(1).setMaxValues(10)));
    if (rule?.mode === 'users') rows.push(new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder().setCustomId(customId(DASHBOARD_PERMISSION_USER, guildId, encodeURIComponent(selectedCommand)))
        .setPlaceholder('Select user(s) to allow').setMinValues(1).setMaxValues(10)));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId(DASHBOARD_HOME, guildId)).setLabel('Back').setEmoji('◀️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(customId(DASHBOARD_REFRESH, guildId)).setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary)));
  const guild = client.guilds.cache.get(guildId);
  let modeText = 'No custom rule set — the bot currently allows this command unless its built-in checks or Discord permissions deny it.';
  if (rule) {
    if (rule.mode === 'everyone') {
      modeText = 'Current mode: **Everyone** — all server members can use it, subject to built-in command checks. Bot owners, server owners, and members with Administrator/Manage Server retain their bypass.';
    } else if (rule.mode === 'admins') {
      modeText = 'Current mode: **Server administrators** — members with Administrator or Manage Server can use it. Bot owners and server owners retain their bypass.';
    } else if (rule.mode === 'roles') {
      const allowedRoles = (rule.roleIds || []).map((id) => {
        const role = guild?.roles.cache.get(id);
        return role ? `${role} (**${role.name}**, ID: ${id})` : `Deleted/missing role (ID: ${id})`;
      });
      modeText = allowedRoles.length
        ? `Current mode: **Selected roles** — allowed roles: ${allowedRoles.join(', ')}. Bot owners, server owners, and members with Administrator/Manage Server retain their bypass.`
        : 'Current mode: **Selected roles**, but no valid role is configured. Bot owners, server owners, and members with Administrator/Manage Server retain their bypass.';
    } else if (rule.mode === 'users') {
      const allowedUsers = (rule.userIds || []).map((id) => `<@${id}> (ID: ${id})`);
      modeText = allowedUsers.length
        ? `Current mode: **Selected users** — allowed users: ${allowedUsers.join(', ')}. Bot owners, server owners, and members with Administrator/Manage Server retain their bypass.`
        : 'Current mode: **Selected users**, but no user is configured. Bot owners, server owners, and members with Administrator/Manage Server retain their bypass.';
    }
  }
  const embed = createEmbed({ title: '🔐 Command Permissions', description: selectedCommand
    ? `Configure who can use **/${selectedCommand}**.\n${modeText}\n\nFor role/user modes, select the mode first, then choose the roles or users from the menu that appears.`
    : 'Choose a command below to configure who can use it. This interactive page replaces the typed `/commands permission` workflow.', color: 'info', footer: 'Bot owner and server owner retain access; protected commands cannot be configured.' });
  return { embed, components: rows, selectedCommand };
}

export async function buildDashboardView(client, guildId, guild, view = 'overview', categoryKey = null) {
  const config = await getGuildConfig(client, guildId);
  const snapshot = getCommandAccessSnapshot(client, config);

  if (view === 'permissions') {
    return await buildPermissionCategoryView(client, guildId, categoryKey);
  }
  if (view === 'permission-command' && categoryKey) {
    const permissionState = await getCommandPermissionRule(client, guildId, categoryKey);
    return buildPermissionCommandView(client, guildId, categoryKey, permissionState?.rule || null);
  }

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

  if (action === DASHBOARD_PERMISSIONS) {
    const view = await buildDashboardView(client, guildId, interaction.guild, 'permissions');
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (action === DASHBOARD_PERMISSION_CATEGORY) {
    const categoryKey = interaction.values[0];
    const view = await buildPermissionCategoryView(client, guildId, categoryKey);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (action === DASHBOARD_PERMISSION_CATEGORY_MODE) {
    const categoryKey = decodeURIComponent(suffix || '');
    const mode = interaction.values[0];
    if (mode === 'roles' || mode === 'users') {
      const registry = buildCommandRegistry(client);
      const category = registry.get(categoryKey);
      if (!category) return interaction.reply({ content: 'Category not found. Refresh the dashboard and try again.', ephemeral: true });
      const view = await buildPermissionCategoryView(client, guildId, categoryKey);
      const targetId = customId(mode === 'roles' ? DASHBOARD_PERMISSION_CATEGORY_ROLE : DASHBOARD_PERMISSION_CATEGORY_USER, guildId, encodeURIComponent(categoryKey));
      const selector = mode === 'roles'
        ? new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(targetId).setPlaceholder('Select roles to allow for this category').setMinValues(1).setMaxValues(10))
        : new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(targetId).setPlaceholder('Select users to allow for this category').setMinValues(1).setMaxValues(10));
      return interaction.update({ embeds: [view.embed], components: [view.components[0], selector, ...view.components.slice(1)] });
    }
    const changed = await applyPermissionRuleToCategory(client, guildId, categoryKey, mode);
    const view = await buildPermissionCategoryView(client, guildId, categoryKey);
    view.embed.setDescription(`Applied **${mode}** access to **${changed} commands** in this category. Choose another category or change the mode again.`);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (action === DASHBOARD_PERMISSION_CATEGORY_ROLE || action === DASHBOARD_PERMISSION_CATEGORY_USER) {
    const categoryKey = decodeURIComponent(suffix || '');
    const mode = action === DASHBOARD_PERMISSION_CATEGORY_ROLE ? 'roles' : 'users';
    let changed = 0;
    for (const targetId of interaction.values) {
      changed = await applyPermissionRuleToCategory(client, guildId, categoryKey, mode,
        mode === 'roles' ? { roleId: targetId } : { userId: targetId });
    }
    const view = await buildPermissionCategoryView(client, guildId, categoryKey);
    view.embed.setDescription(`Applied **${mode}** access to **${changed} commands** in this category. Choose another category or change the mode again.`);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (action === DASHBOARD_PERMISSION_COMMAND) {
    const commandName = interaction.values[0];
    const permissionState = await getCommandPermissionRule(client, guildId, commandName);
    const view = buildPermissionCommandView(client, guildId, commandName, permissionState.rule);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (action === DASHBOARD_PERMISSION_MODE) {
    const commandName = decodeURIComponent(suffix || '');
    const mode = interaction.values[0];
    if (mode === 'roles' || mode === 'users') {
      const permissionState = await getCommandPermissionRule(client, guildId, commandName);
      const view = buildPermissionCommandView(client, guildId, commandName, { ...(permissionState.rule || {}), mode });
      return interaction.update({ embeds: [view.embed], components: view.components });
    }
    const rule = await setCommandPermissionRule(client, guildId, commandName, mode);
    const view = buildPermissionCommandView(client, guildId, commandName, rule);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (action === DASHBOARD_PERMISSION_ROLE || action === DASHBOARD_PERMISSION_USER) {
    const commandName = decodeURIComponent(suffix || '');
    const mode = action === DASHBOARD_PERMISSION_ROLE ? 'roles' : 'users';
    let rule = null;
    for (const targetId of interaction.values) {
      rule = await setCommandPermissionRule(client, guildId, commandName, mode,
        mode === 'roles' ? { roleId: targetId } : { userId: targetId });
    }
    const view = buildPermissionCommandView(client, guildId, commandName, rule);
    return interaction.update({ embeds: [view.embed], components: view.components });
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
