import { PermissionFlagsBits } from 'discord.js';
import { isBotOwner } from '../config/bot.js';
import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';
import { isProtectedCommand } from './commandAccessService.js';
import { normalizeCategoryKey } from '../config/commands/commandCategories.js';

// 'custom' = specific roles AND/OR users together (used by the dashboard); 'roles'/'users' come from the typed commands.
const VALID_MODES = new Set(['everyone', 'admins', 'roles', 'users', 'custom']);

function cleanIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === 'string' && /^\d{15,22}$/.test(value)))];
}

export function normalizeAccessRule(rule, fallbackMode = 'admins') {
  const mode = VALID_MODES.has(rule?.mode) ? rule.mode : fallbackMode;
  return {
    mode,
    roleIds: cleanIds(rule?.roleIds),
    userIds: cleanIds(rule?.userIds),
  };
}

export async function getCommandPermissionRule(client, guildId, commandName) {
  const config = await getGuildConfig(client, guildId);
  const key = String(commandName || '').trim().toLowerCase();
  const rules = config?.commandPermissions && typeof config.commandPermissions === 'object' ? config.commandPermissions : {};
  return { config, rule: rules[key] ? normalizeAccessRule(rules[key], 'admins') : null };
}

export async function setCommandPermissionRule(client, guildId, commandName, mode, target = null) {
  const key = String(commandName || '').trim().toLowerCase();
  if (!key) throw new Error('Choose a command first.');
  if (isProtectedCommand(key.split(' ')[0])) throw new Error(`The \`${key}\` command is protected and cannot have a custom access rule.`);
  if (!VALID_MODES.has(mode)) throw new Error('Invalid permission mode.');
  if ((mode === 'roles' && !target?.roleId) || (mode === 'users' && !target?.userId)) {
    throw new Error(`Select a ${mode === 'roles' ? 'role' : 'user'} for this permission mode.`);
  }

  const config = await getGuildConfig(client, guildId);
  const commandPermissions = { ...(config.commandPermissions || {}) };
  const current = normalizeAccessRule(commandPermissions[key], mode);
  let next;
  if (mode === 'roles') {
    const roleIds = current.mode === 'roles' ? current.roleIds : [];
    next = { mode, roleIds: cleanIds([...roleIds, target.roleId]), userIds: [] };
  } else if (mode === 'users') {
    const userIds = current.mode === 'users' ? current.userIds : [];
    next = { mode, roleIds: [], userIds: cleanIds([...userIds, target.userId]) };
  } else {
    next = { mode, roleIds: [], userIds: [] };
  }

  commandPermissions[key] = next;
  await updateGuildConfig(client, guildId, { commandPermissions });
  return next;
}

export async function removeCommandPermissionTarget(client, guildId, commandName, target = {}) {
  const key = String(commandName || '').trim().toLowerCase();
  const config = await getGuildConfig(client, guildId);
  const commandPermissions = { ...(config.commandPermissions || {}) };
  const current = normalizeAccessRule(commandPermissions[key], 'admins');
  if (target.roleId) current.roleIds = current.roleIds.filter((id) => id !== target.roleId);
  if (target.userId) current.userIds = current.userIds.filter((id) => id !== target.userId);
  if (!current.roleIds.length && !current.userIds.length && ['roles', 'users'].includes(current.mode)) {
    current.mode = 'admins';
  }
  commandPermissions[key] = current;
  await updateGuildConfig(client, guildId, { commandPermissions });
  return current;
}

export async function setDashboardAccess(client, guildId, mode, target = null) {
  if (!VALID_MODES.has(mode)) throw new Error('Invalid dashboard access mode.');
  const config = await getGuildConfig(client, guildId);
  const current = normalizeAccessRule(config.dashboardAccess, 'admins');
  let next;
  if (mode === 'roles') {
    if (!target?.roleId) throw new Error('Select a role for dashboard access.');
    const roleIds = current.mode === 'roles' ? current.roleIds : [];
    next = { mode, roleIds: cleanIds([...roleIds, target.roleId]), userIds: [] };
  } else if (mode === 'users') {
    if (!target?.userId) throw new Error('Select a user for dashboard access.');
    const userIds = current.mode === 'users' ? current.userIds : [];
    next = { mode, roleIds: [], userIds: cleanIds([...userIds, target.userId]) };
  } else {
    next = { mode, roleIds: [], userIds: [] };
  }
  await updateGuildConfig(client, guildId, { dashboardAccess: next });
  return next;
}

/** Who may change access rules: the bot owner, the server owner, or Manage Server/Administrator. */
export function canManageAccessPolicy(interaction) {
  if (!interaction?.user) return false;
  if (isBotOwner(interaction.user.id)) return true;
  if (interaction.guild?.ownerId === interaction.user.id) return true;
  const permissions = interaction.memberPermissions || interaction.member?.permissions;
  return Boolean(
    permissions?.has?.(PermissionFlagsBits.Administrator) || permissions?.has?.(PermissionFlagsBits.ManageGuild),
  );
}

function buildRule(mode, roleIds = [], userIds = []) {
  if (!VALID_MODES.has(mode)) throw new Error('Invalid permission mode.');
  return {
    mode,
    roleIds: mode === 'roles' || mode === 'custom' ? cleanIds(roleIds) : [],
    userIds: mode === 'users' || mode === 'custom' ? cleanIds(userIds) : [],
  };
}

export async function getDashboardAccessRule(client, guildId) {
  const config = await getGuildConfig(client, guildId);
  return normalizeAccessRule(config?.dashboardAccess, 'admins');
}

/** Replace the whole rule for a command (used by the dashboard pickers). */
export async function setCommandPermissionAccess(client, guildId, commandName, { mode, roleIds = [], userIds = [] }) {
  const key = String(commandName || '').trim().toLowerCase();
  if (!key) throw new Error('Choose a command first.');
  if (isProtectedCommand(key.split(' ')[0])) throw new Error(`The \`${key}\` command is protected and cannot have a custom access rule.`);

  const config = await getGuildConfig(client, guildId);
  const commandPermissions = { ...(config.commandPermissions || {}) };
  if (mode === 'everyone') delete commandPermissions[key];
  else commandPermissions[key] = buildRule(mode, roleIds, userIds);

  await updateGuildConfig(client, guildId, { commandPermissions });
  return commandPermissions[key] || null;
}

export async function getCategoryPermissionRule(client, guildId, categoryKey) {
  const config = await getGuildConfig(client, guildId);
  const key = normalizeCategoryKey(categoryKey);
  const rules = config?.categoryPermissions && typeof config.categoryPermissions === 'object' ? config.categoryPermissions : {};
  return rules[key] ? normalizeAccessRule(rules[key], 'admins') : null;
}

/** Set who may use every command in a category. mode 'everyone' removes the rule. */
export async function setCategoryPermissionAccess(client, guildId, categoryKey, { mode, roleIds = [], userIds = [] }) {
  const key = normalizeCategoryKey(categoryKey);
  if (!key) throw new Error('Choose a category first.');
  const config = await getGuildConfig(client, guildId);
  const categoryPermissions = { ...(config.categoryPermissions || {}) };
  if (mode === 'everyone') delete categoryPermissions[key];
  else categoryPermissions[key] = buildRule(mode, roleIds, userIds);
  await updateGuildConfig(client, guildId, { categoryPermissions });
  return categoryPermissions[key] || null;
}

export async function setDashboardAccessPolicy(client, guildId, { mode, roleIds = [], userIds = [] }) {
  const next = buildRule(mode, roleIds, userIds);
  await updateGuildConfig(client, guildId, { dashboardAccess: next });
  return next;
}

export async function canAccessDashboard(interaction, config = null) {
  if (!interaction?.guild || !interaction?.user) return false;
  if (isBotOwner(interaction.user.id) || interaction.guild.ownerId === interaction.user.id) return true;
  const member = interaction.member;
  if (member?.permissions?.has(PermissionFlagsBits.Administrator) || member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const resolvedConfig = config || await getGuildConfig(interaction.client, interaction.guildId);
  const rule = normalizeAccessRule(resolvedConfig?.dashboardAccess, 'admins');
  if (rule.mode === 'everyone') return true;
  if (rule.mode === 'admins') return false;
  if (rule.mode === 'users') return rule.userIds.includes(interaction.user.id);
  if (rule.mode === 'roles') {
    const roleCache = interaction.member?.roles?.cache;
    return Boolean(roleCache && rule.roleIds.some((roleId) => roleCache.has(roleId)));
  }
  if (rule.mode === 'custom') {
    const roleCache = interaction.member?.roles?.cache;
    return rule.userIds.includes(interaction.user.id)
      || Boolean(roleCache && rule.roleIds.some((roleId) => roleCache.has(roleId)));
  }
  return false;
}

export function canUseCommandByRule(member, userId, guild, rule) {
  if (!guild || !userId) return true;
  if (isBotOwner(userId) || guild.ownerId === userId) return true;
  if (member?.permissions?.has(PermissionFlagsBits.Administrator) || member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const normalized = normalizeAccessRule(rule, 'everyone');
  if (normalized.mode === 'everyone') return true;
  if (normalized.mode === 'admins') return Boolean(member?.permissions?.has(PermissionFlagsBits.ManageGuild));
  if (normalized.mode === 'users') return normalized.userIds.includes(userId);
  if (normalized.mode === 'custom') {
    const roleCache = member?.roles?.cache;
    return normalized.userIds.includes(userId)
      || Boolean(roleCache && normalized.roleIds.some((roleId) => roleCache.has(roleId)));
  }
  if (normalized.mode === 'roles') {
    const roleCache = member?.roles?.cache;
    return Boolean(roleCache && normalized.roleIds.some((roleId) => roleCache.has(roleId)));
  }
  return true;
}

export async function checkCommandAccess(client, guildId, commandName, member, userId, guild, category = null) {
  const key = String(commandName || '').trim().toLowerCase();
  if (isProtectedCommand(key.split(' ')[0])) return { allowed: true, rule: null };

  // A rule on the command itself wins; otherwise the category's rule applies.
  const { config, rule } = await getCommandPermissionRule(client, guildId, key);
  if (rule) return { allowed: canUseCommandByRule(member, userId, guild, rule), rule };

  if (category) {
    const categoryKey = normalizeCategoryKey(category);
    const categoryRule = config?.categoryPermissions?.[categoryKey];
    if (categoryRule) {
      const normalized = normalizeAccessRule(categoryRule, 'admins');
      return { allowed: canUseCommandByRule(member, userId, guild, normalized), rule: normalized };
    }
  }
  return { allowed: true, rule: null };
}
