import { PermissionFlagsBits } from 'discord.js';
import { isBotOwner } from '../config/bot.js';
import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';
import { isProtectedCommand } from './commandAccessService.js';

const VALID_MODES = new Set(['everyone', 'admins', 'roles', 'users']);

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
  // Lock is moderation-sensitive: until configured in the dashboard, only admins may use it.
  const defaultMode = key === 'lock' ? 'admins' : null;
  return { config, rule: rules[key] ? normalizeAccessRule(rules[key], defaultMode || 'admins') : (defaultMode ? normalizeAccessRule(null, defaultMode) : null) };
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
  if (normalized.mode === 'roles') {
    const roleCache = member?.roles?.cache;
    return Boolean(roleCache && normalized.roleIds.some((roleId) => roleCache.has(roleId)));
  }
  return true;
}

export async function checkCommandAccess(client, guildId, commandName, member, userId, guild) {
  const key = String(commandName || '').trim().toLowerCase();
  if (isProtectedCommand(key.split(' ')[0])) return { allowed: true, rule: null };
  const { rule } = await getCommandPermissionRule(client, guildId, key);
  if (!rule) return { allowed: true, rule: null };
  return { allowed: canUseCommandByRule(member, userId, guild, rule), rule };
}
