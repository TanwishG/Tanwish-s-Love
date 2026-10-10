// The "Permissions" screen of /commands dashboard.
//
// One card per command category: title, a badge with the current mode and a dropdown to change it
// (Everyone / Server Administrators / Selected Roles / Selected Users). When a category is set to
// roles or users, a picker appears at the top of the screen. Cards are paged, 4 per page, because
// Discord allows at most 40 components per message.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  RoleSelectMenuBuilder,
  SectionBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  UserSelectMenuBuilder,
} from 'discord.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import { getCommandAccessSnapshot } from '../../../services/commandAccessService.js';
import {
  canManageAccessPolicy,
  getCategoryPermissionRule,
  setCategoryPermissionAccess,
} from '../../../services/commandPermissionsService.js';
import { logger } from '../../../utils/logger.js';

export const PERMISSIONS_OPEN = 'cmdaccess_perms_open';

const PAGE_SIZE = 4;
const COLLECTOR_TIME_MS = 10 * 60 * 1000;
const ACCENT = 0x5865f2;

const MODE_LABELS = {
  everyone: 'Everyone',
  admins: 'Server Administrators',
  roles: 'Selected Roles',
  users: 'Selected Users',
};

const id = (action, ...parts) => [`cmdaccess_pv_${action}`, ...parts].join(':');

function effectiveMode(rule) {
  if (!rule) return 'everyone';
  // Rules made elsewhere with both roles and users show as the closest simple mode.
  if (rule.mode === 'custom') return rule.roleIds?.length ? 'roles' : 'users';
  return MODE_LABELS[rule.mode] ? rule.mode : 'everyone';
}

function mentionList(ids, prefix) {
  return ids.slice(0, 10).map((entry) => `<${prefix}${entry}>`).join(' ') + (ids.length > 10 ? ` +${ids.length - 10} more` : '');
}

function summaryLine(category, rule, mode, commandRuleCount) {
  const parts = [];
  const count = `${category.commands.length} command${category.commands.length === 1 ? '' : 's'}`;

  if (mode === 'everyone') {
    parts.push(`${count} • anyone can use them (Discord permissions like Ban Members still apply)`);
  } else if (mode === 'admins') {
    parts.push(`${count} • only members with Manage Server`);
  } else if (mode === 'roles') {
    parts.push(rule?.roleIds?.length
      ? `${count} • roles: ${mentionList(rule.roleIds, '@&')}`
      : `Warning: no roles chosen yet, so only administrators can use these ${count}`);
  } else if (mode === 'users') {
    parts.push(rule?.userIds?.length
      ? `${count} • users: ${mentionList(rule.userIds, '@')}`
      : `Warning: no users chosen yet, so only administrators can use these ${count}`);
  }

  if (commandRuleCount > 0) {
    parts.push(`${commandRuleCount} command${commandRuleCount === 1 ? ' has' : 's have'} their own rule (overrides this)`);
  }
  return `-# ${parts.join('\n-# ')}`;
}

async function loadState(client, guildId) {
  const config = await getGuildConfig(client, guildId);
  const snapshot = getCommandAccessSnapshot(client, config);
  const categories = snapshot.categories;
  const commandRules = config.commandPermissions || {};

  const rules = new Map();
  for (const category of categories) {
    rules.set(category.key, await getCategoryPermissionRule(client, guildId, category.key));
  }
  return { categories, rules, commandRules };
}

export async function buildPermissionsPayload(client, guildId, guild, state) {
  const { categories, rules, commandRules } = await loadState(client, guildId);
  const pageCount = Math.max(1, Math.ceil(categories.length / PAGE_SIZE));
  state.page = Math.min(Math.max(0, state.page), pageCount - 1);

  const top = [
    new TextDisplayBuilder().setContent(
      [
        '# Command permissions',
        'Choose who may use each category of commands. Server administrators, the server owner and the bot owner can always use everything.',
        `-# Page ${state.page + 1} of ${pageCount} • changes apply immediately`,
      ].join('\n'),
    ),
  ];

  // Picker for the category that was just switched to "Selected Roles / Users".
  const focused = state.focus ? categories.find((entry) => entry.key === state.focus) : null;
  const focusedRule = focused ? rules.get(focused.key) : null;
  const focusedMode = focused ? effectiveMode(focusedRule) : null;

  if (focused && (focusedMode === 'roles' || focusedMode === 'users')) {
    const container = new ContainerBuilder().setAccentColor(0xfaa61a);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### ${focusedMode === 'roles' ? 'Choose roles' : 'Choose users'} for ${focused.displayName}`,
      ),
    );

    if (focusedMode === 'roles') {
      const picker = new RoleSelectMenuBuilder()
        .setCustomId(id('roles', guildId, focused.key))
        .setPlaceholder('Select the roles allowed to use these commands...')
        .setMinValues(0)
        .setMaxValues(25);
      const valid = (focusedRule?.roleIds || []).filter((roleId) => guild.roles.cache.has(roleId));
      if (valid.length > 0) picker.setDefaultRoles(valid);
      container.addActionRowComponents(new ActionRowBuilder().addComponents(picker));
    } else {
      const picker = new UserSelectMenuBuilder()
        .setCustomId(id('users', guildId, focused.key))
        .setPlaceholder('Select the users allowed to use these commands...')
        .setMinValues(0)
        .setMaxValues(25);
      if ((focusedRule?.userIds || []).length > 0) picker.setDefaultUsers(focusedRule.userIds.slice(0, 25));
      container.addActionRowComponents(new ActionRowBuilder().addComponents(picker));
    }
    top.push(container);
  }

  const pageCategories = categories.slice(state.page * PAGE_SIZE, state.page * PAGE_SIZE + PAGE_SIZE);
  for (const category of pageCategories) {
    const rule = rules.get(category.key);
    const mode = effectiveMode(rule);
    const commandRuleCount = category.commands.filter((command) => commandRules[command.name.toLowerCase()]).length;

    const card = new ContainerBuilder().setAccentColor(mode === 'everyone' ? ACCENT : 0xfaa61a);

    card.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ${category.displayName}`))
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(id('badge', guildId, category.key))
            .setLabel(MODE_LABELS[mode])
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
        ),
    );

    card.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(id('mode', guildId, category.key))
          .setPlaceholder('Who can use this category?')
          .addOptions(
            Object.entries(MODE_LABELS).map(([value, label]) =>
              new StringSelectMenuOptionBuilder().setLabel(label).setValue(value).setDefault(value === mode),
            ),
          ),
      ),
    );

    card.addTextDisplayComponents(new TextDisplayBuilder().setContent(summaryLine(category, rule, mode, commandRuleCount)));
    top.push(card);
  }

  if (pageCount > 1) {
    top.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(id('nav', guildId, String(state.page - 1)))
          .setLabel('Previous')
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(state.page === 0),
        new ButtonBuilder()
          .setCustomId(id('page', guildId))
          .setLabel(`${state.page + 1} / ${pageCount}`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(id('nav', guildId, String(state.page + 1)))
          .setLabel('Next')
          .setEmoji('▶️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(state.page >= pageCount - 1),
      ),
    );
  }

  return { components: top, flags: MessageFlags.IsComponentsV2 };
}

/** Opens the screen as its own private message and keeps it live. */
export async function openPermissionsView(interaction, client) {
  const guildId = interaction.guildId;
  const state = { page: 0, focus: null };

  const payload = await buildPermissionsPayload(client, guildId, interaction.guild, state);
  await interaction.reply({ ...payload, flags: payload.flags | MessageFlags.Ephemeral });

  const message = await interaction.fetchReply();
  const collector = message.createMessageComponentCollector({
    filter: (component) => component.user.id === interaction.user.id && component.customId.startsWith('cmdaccess_pv_'),
    time: COLLECTOR_TIME_MS,
  });

  collector.on('collect', async (component) => {
    try {
      const [action, , ...rest] = component.customId.replace('cmdaccess_pv_', '').split(':');
      const target = rest.join(':');

      if (action === 'nav') {
        state.page = Number.parseInt(target, 10) || 0;
        state.focus = null;
      } else if (action === 'mode' || action === 'roles' || action === 'users') {
        if (!canManageAccessPolicy(component)) {
          await component.reply({
            content: 'You need the **Manage Server** permission to change who can use commands.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const category = target;
        const current = await getCategoryPermissionRule(client, guildId, category);

        if (action === 'mode') {
          const mode = component.values[0];
          await setCategoryPermissionAccess(client, guildId, category, {
            mode,
            roleIds: current?.roleIds || [],
            userIds: current?.userIds || [],
          });
          state.focus = mode === 'roles' || mode === 'users' ? category : null;
        } else if (action === 'roles') {
          await setCategoryPermissionAccess(client, guildId, category, {
            mode: 'roles',
            roleIds: component.values,
          });
          state.focus = category;
        } else {
          await setCategoryPermissionAccess(client, guildId, category, {
            mode: 'users',
            userIds: component.values,
          });
          state.focus = category;
        }
      } else {
        await component.deferUpdate();
        return;
      }

      const next = await buildPermissionsPayload(client, guildId, interaction.guild, state);
      await component.update(next);
    } catch (error) {
      logger.error('Permissions screen error:', error);
      if (!component.replied && !component.deferred) {
        await component.reply({ content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });
}
