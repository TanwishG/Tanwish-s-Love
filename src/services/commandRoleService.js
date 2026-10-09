/**
 * Command Role & User Access Restriction Service
 *
 * Allows server admins to select which command can be used by whom:
 *   - Specific Roles (e.g. @Moderator, @VIP)
 *   - Specific Users (e.g. specific user IDs)
 *
 * Bot owners (OWNER_IDS) bypass ALL restrictions in ANY server unconditionally.
 * Guild owners and Administrators also bypass guild-level restrictions.
 *
 * Config shape stored in guild config:
 *   commandRoles: { [commandName]: string[] } — allowed role IDs
 *   commandUsers: { [commandName]: string[] } — allowed user IDs
 */

import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';
import { isBotOwner } from '../config/bot.js';
import { PermissionFlagsBits } from 'discord.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeIdMap(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(
        Object.entries(raw).map(([cmd, ids]) => [
            String(cmd).toLowerCase(),
            Array.isArray(ids) ? ids.map(String) : [],
        ]),
    );
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Get the full restrictions (roles & users) for a guild.
 * @param {*} client
 * @param {string} guildId
 * @returns {Promise<{ commandRoles: Record<string, string[]>, commandUsers: Record<string, string[]> }>}
 */
export async function getCommandRestrictions(client, guildId) {
    const config = await getGuildConfig(client, guildId);
    return {
        commandRoles: normalizeIdMap(config?.commandRoles),
        commandUsers: normalizeIdMap(config?.commandUsers),
    };
}

/**
 * Get role restrictions map for backward-compat.
 */
export async function getCommandRoles(client, guildId) {
    const config = await getGuildConfig(client, guildId);
    return normalizeIdMap(config?.commandRoles);
}

/**
 * Get user restrictions map for a guild.
 */
export async function getCommandUsers(client, guildId) {
    const config = await getGuildConfig(client, guildId);
    return normalizeIdMap(config?.commandUsers);
}

/**
 * Get allowed roles for a command.
 */
export async function getCommandAllowedRoles(client, guildId, commandName) {
    const map = await getCommandRoles(client, guildId);
    return map[commandName.toLowerCase()] ?? [];
}

/**
 * Get allowed users for a command.
 */
export async function getCommandAllowedUsers(client, guildId, commandName) {
    const map = await getCommandUsers(client, guildId);
    return map[commandName.toLowerCase()] ?? [];
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Set the allowed roles for a command.
 */
export async function setCommandRoles(client, guildId, commandName, roleIds = [], context = {}) {
    const config = await getGuildConfig(client, guildId);
    const commandRoles = normalizeIdMap(config?.commandRoles);
    const key = commandName.toLowerCase();

    if (roleIds.length === 0) {
        delete commandRoles[key];
    } else {
        commandRoles[key] = Array.from(new Set(roleIds.map(String)));
    }

    await updateGuildConfig(client, guildId, { commandRoles }, context);
    return commandRoles;
}

/**
 * Set the allowed users for a command.
 */
export async function setCommandUsers(client, guildId, commandName, userIds = [], context = {}) {
    const config = await getGuildConfig(client, guildId);
    const commandUsers = normalizeIdMap(config?.commandUsers);
    const key = commandName.toLowerCase();

    if (userIds.length === 0) {
        delete commandUsers[key];
    } else {
        commandUsers[key] = Array.from(new Set(userIds.map(String)));
    }

    await updateGuildConfig(client, guildId, { commandUsers }, context);
    return commandUsers;
}

/**
 * Clear all restrictions (both roles and users) for a command.
 */
export async function clearCommandRestrictions(client, guildId, commandName, context = {}) {
    const config = await getGuildConfig(client, guildId);
    const commandRoles = normalizeIdMap(config?.commandRoles);
    const commandUsers = normalizeIdMap(config?.commandUsers);
    const key = commandName.toLowerCase();

    delete commandRoles[key];
    delete commandUsers[key];

    await updateGuildConfig(client, guildId, { commandRoles, commandUsers }, context);
    return { commandRoles, commandUsers };
}

/**
 * Alias for backward-compat with clearCommandRoles.
 */
export async function clearCommandRoles(client, guildId, commandName, context = {}) {
    return clearCommandRestrictions(client, guildId, commandName, context);
}

// ─── Check ────────────────────────────────────────────────────────────────────

/**
 * Check if a member is allowed to run a command given role & user restrictions.
 *
 * Passes when:
 *  1. The user is a bot owner (global bypass in ANY server).
 *  2. The user is the guild owner.
 *  3. The user has Administrator permission.
 *  4. No restrictions are configured (both roles & users lists are empty).
 *  5. The member's user ID is in the allowed users list.
 *  6. The member holds at least one of the allowed roles.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {string} commandName
 * @param {{ commandRoles?: Record<string, string[]>, commandUsers?: Record<string, string[]> }} restrictions
 * @returns {boolean}
 */
export function memberPassesCommandRestrictions(member, commandName, restrictions = {}) {
    const memberId = member?.user?.id || member?.id;
    if (!memberId) return false;

    // 1. Bot owner — global bypass in ANY server
    if (isBotOwner(memberId)) return true;

    // 2. Guild owner
    if (member.guild?.ownerId === memberId) return true;

    // 3. Administrator
    if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;

    const key = commandName.toLowerCase();
    const allowedRoles = restrictions.commandRoles?.[key] || [];
    const allowedUsers = restrictions.commandUsers?.[key] || [];

    // 4. No restriction set for this command -> everyone with base permissions can use it
    if (allowedRoles.length === 0 && allowedUsers.length === 0) {
        return true;
    }

    // 5. Allowed specific user
    if (allowedUsers.includes(memberId)) {
        return true;
    }

    // 6. Allowed role
    if (allowedRoles.length > 0 && member.roles?.cache) {
        const hasRole = allowedRoles.some((roleId) => member.roles.cache.has(roleId));
        if (hasRole) return true;
    }

    return false;
}

/**
 * Check access for a member against the database config.
 * @param {*} client
 * @param {import('discord.js').GuildMember} member
 * @param {string} commandName
 * @returns {Promise<{ allowed: boolean, requiredRoles: string[], requiredUsers: string[] }>}
 */
export async function checkCommandRoleAccess(client, member, commandName) {
    const memberId = member?.user?.id || member?.id;

    // Fast-path bot owner bypass
    if (isBotOwner(memberId)) {
        return { allowed: true, requiredRoles: [], requiredUsers: [] };
    }

    const { commandRoles, commandUsers } = await getCommandRestrictions(client, member.guild.id);
    const key = commandName.toLowerCase();
    const requiredRoles = commandRoles[key] || [];
    const requiredUsers = commandUsers[key] || [];

    const allowed = memberPassesCommandRestrictions(member, commandName, { commandRoles, commandUsers });

    return { allowed, requiredRoles, requiredUsers };
}
