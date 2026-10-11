// Self-test for "who can use which command".
//
// It runs the SAME checks the bot runs when someone uses a command, in the same order:
//   1. maintenance mode            4. access rules (dashboard "Permissions")
//   2. category switched off       5. the command's own Discord permission
//   3. turned off in /commands
// ...for several pretend people (plus you), so you can see what is allowed and blocked.

import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { getBotOwners, isBotOwner, isCommandCategoryEnabled, isMaintenanceMode } from '../config/bot.js';
import { getGuildConfig } from './config/guildConfig.js';
import { getCommandAccessSnapshot, isCommandEnabledInConfig } from './commandAccessService.js';
import { canAccessDashboard, checkCommandAccess } from './commandPermissionsService.js';
import { getCommandDefaultPermissions, memberMeetsCommandPermissions } from '../utils/permissionGuard.js';

const P = PermissionFlagsBits;
const BASIC = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory];

export function makeTestMember(guild, id, { roleIds = [], permissions = BASIC } = {}) {
    return {
        id,
        guild,
        roles: { cache: new Map(roleIds.map((roleId) => [roleId, { id: roleId }])) },
        permissions: new PermissionsBitField(permissions),
    };
}

/** The pretend people used in the test, plus the real caller (and optionally another real member). */
export function buildPersonas(guild, guildConfig, caller, extra = null) {
    const personas = [];
    if (caller) personas.push({ key: 'you', label: 'You', userId: caller.id, member: caller });
    if (extra) personas.push({ key: 'them', label: 'Them', userId: extra.id, member: extra });

    personas.push({ key: 'member', label: 'Member', userId: '100000000000000001', member: makeTestMember(guild, '100000000000000001') });
    personas.push({
        key: 'manage',
        label: 'ManageServer',
        userId: '100000000000000002',
        member: makeTestMember(guild, '100000000000000002', { permissions: [...BASIC, P.ManageGuild] }),
    });

    const modRole = typeof guildConfig?.modRole === 'string' ? guildConfig.modRole : guildConfig?.modRole?.id;
    if (modRole) {
        personas.push({ key: 'mod', label: 'ModRole', userId: '100000000000000004', member: makeTestMember(guild, '100000000000000004', { roleIds: [modRole] }) });
    }

    personas.push({ key: 'admin', label: 'Admin', userId: '100000000000000003', member: makeTestMember(guild, '100000000000000003', { permissions: [P.Administrator] }) });

    const owner = getBotOwners()[0];
    if (owner) personas.push({ key: 'owner', label: 'BotOwner', userId: owner, member: makeTestMember(guild, owner) });
    return personas;
}

const describeRule = (rule) => {
    if (!rule) return 'a rule';
    if (rule.mode === 'admins') return 'administrators only';
    const parts = [];
    if (rule.roleIds?.length) parts.push(`roles ${rule.roleIds.map((id) => `<@&${id}>`).join(' ')}`);
    if (rule.userIds?.length) parts.push(`users ${rule.userIds.map((id) => `<@${id}>`).join(' ')}`);
    return parts.join(' + ') || 'nobody (no roles/users chosen)';
};

/**
 * Would this person be allowed to run this command? Mirrors the real order of checks.
 * @returns {{allowed: boolean, step: string, reason: string}}
 */
export async function evaluateCommandAccess({ client, guild, guildConfig, member, userId, command, accessKey, category }) {
    const owner = isBotOwner(userId);

    if (isMaintenanceMode() && !owner) {
        return { allowed: false, step: 'maintenance', reason: 'the bot is in maintenance mode' };
    }
    if (!owner && !isCommandCategoryEnabled(category)) {
        return { allowed: false, step: 'category', reason: 'this category is switched off in the bot config' };
    }
    if (!owner && !isCommandEnabledInConfig(guildConfig, accessKey, category)) {
        return { allowed: false, step: 'dashboard', reason: 'turned off in the /commands dashboard' };
    }

    const access = await checkCommandAccess(client, guild.id, accessKey, member, userId, guild, category);
    if (!access.allowed) {
        return { allowed: false, step: 'rule', reason: `blocked by an access rule (only ${describeRule(access.rule)})` };
    }

    if (!owner) {
        const required = getCommandDefaultPermissions(command?.data);
        if (required != null && !memberMeetsCommandPermissions(member, required, { guildConfig, commandCategory: category })) {
            const names = new PermissionsBitField(required).toArray().join(', ');
            return { allowed: false, step: 'discord', reason: `needs the Discord permission: ${names}` };
        }
    }

    return { allowed: true, step: 'ok', reason: owner ? 'bot owner' : 'allowed' };
}

export async function runAccessTest(client, guild, caller, { extraMember = null } = {}) {
    const guildConfig = await getGuildConfig(client, guild.id);
    const snapshot = getCommandAccessSnapshot(client, guildConfig);
    const personas = buildPersonas(guild, guildConfig, caller, extraMember);

    const categories = [];
    for (const category of snapshot.categories) {
        const counts = Object.fromEntries(personas.map((persona) => [persona.key, 0]));
        const blockedForYou = [];

        for (const entry of category.commands) {
            const command = client.commands.get(entry.name.split(' ')[0]);
            const results = await Promise.all(
                personas.map((persona) =>
                    evaluateCommandAccess({
                        client, guild, guildConfig, member: persona.member, userId: persona.userId,
                        command, accessKey: entry.name, category: command?.category ?? category.key,
                    }),
                ),
            );
            results.forEach((result, index) => {
                if (result.allowed) counts[personas[index].key] += 1;
            });
            if (personas[0].key === 'you' && !results[0].allowed) blockedForYou.push({ name: entry.name, reason: results[0].reason });
        }
        categories.push({ key: category.key, name: category.displayName, total: category.commands.length, counts, blockedForYou });
    }

    return { guildConfig, snapshot, personas, categories };
}

/** Detailed answer for one command (by name, e.g. "ban" or "bypass lock"). */
export async function testOneCommand(client, guild, caller, name, { extraMember = null } = {}) {
    const guildConfig = await getGuildConfig(client, guild.id);
    const snapshot = getCommandAccessSnapshot(client, guildConfig);
    const wanted = name.trim().toLowerCase().replace(/^\//, '');

    let entry = null;
    let categoryName = null;
    for (const category of snapshot.categories) {
        const found = category.commands.find((command) => command.name.toLowerCase() === wanted);
        if (found) { entry = found; categoryName = category.displayName; break; }
    }
    if (!entry) return null;

    const command = client.commands.get(entry.name.split(' ')[0]);
    const personas = buildPersonas(guild, guildConfig, caller, extraMember);
    const results = [];
    for (const persona of personas) {
        results.push({
            persona,
            ...(await evaluateCommandAccess({
                client, guild, guildConfig, member: persona.member, userId: persona.userId,
                command, accessKey: entry.name, category: command?.category ?? categoryName,
            })),
        });
    }

    const required = getCommandDefaultPermissions(command?.data);
    const ownRule = guildConfig.commandPermissions?.[entry.name.toLowerCase()] || guildConfig.commandPermissions?.[entry.name.split(' ')[0].toLowerCase()];
    const catKey = (command?.category ?? '').toString().toLowerCase();
    const categoryRule = guildConfig.categoryPermissions?.[catKey];

    return {
        entry,
        categoryName,
        discordPermission: required != null ? new PermissionsBitField(required).toArray().join(', ') : null,
        ruleText: ownRule ? `command rule: ${describeRule(ownRule)}` : categoryRule ? `category rule: ${describeRule(categoryRule)}` : 'none',
        dashboardEnabled: isCommandEnabledInConfig(guildConfig, entry.name, command?.category ?? categoryName),
        results,
    };
}

/**
 * Checks that the saved rules really behave the way they say: people they list get in, outsiders don't.
 */
export async function verifyRules(client, guild) {
    const guildConfig = await getGuildConfig(client, guild.id);
    const outsider = makeTestMember(guild, '100000000000000001');
    const manage = makeTestMember(guild, '100000000000000002', { permissions: [...BASIC, P.ManageGuild] });
    const admin = makeTestMember(guild, '100000000000000003', { permissions: [P.Administrator] });

    const lines = [];
    const problems = [];

    const verify = async (label, accessKey, category, rule) => {
        const check = (member, userId) => checkCommandAccess(client, guild.id, accessKey, member, userId, guild, category);
        const failures = [];

        const outside = await check(outsider, outsider.id);
        if (outside.allowed && rule.mode !== 'everyone') failures.push('a normal member got in');

        const adminResult = await check(admin, admin.id);
        if (!adminResult.allowed) failures.push('an administrator was blocked');

        if (rule.mode === 'admins') {
            if (!(await check(manage, manage.id)).allowed) failures.push('a Manage Server member was blocked');
        }
        for (const roleId of rule.roleIds || []) {
            if (!guild.roles.cache.has(roleId)) { problems.push(`${label}: role <@&${roleId}> no longer exists`); continue; }
            const member = makeTestMember(guild, '100000000000000010', { roleIds: [roleId] });
            if (!(await check(member, member.id)).allowed) failures.push(`holder of <@&${roleId}> was blocked`);
        }
        for (const userId of rule.userIds || []) {
            const member = makeTestMember(guild, userId);
            if (!(await check(member, userId)).allowed) failures.push(`listed user <@${userId}> was blocked`);
        }
        if ((rule.mode === 'roles' || rule.mode === 'users' || rule.mode === 'custom') && !(rule.roleIds?.length || rule.userIds?.length)) {
            problems.push(`${label}: no roles/users chosen, so only administrators can use it`);
        }

        lines.push({ label, who: describeRule(rule), ok: failures.length === 0, failures });
        if (failures.length) problems.push(`${label}: ${failures.join('; ')}`);
    };

    for (const [category, rule] of Object.entries(guildConfig.categoryPermissions || {})) {
        await verify(`category ${category}`, '__access_test__', category, rule);
    }
    for (const [name, rule] of Object.entries(guildConfig.commandPermissions || {})) {
        await verify(`/${name}`, name, null, rule);
    }

    // Who may open the /commands dashboard?
    const dashLine = { label: 'dashboard access' };
    try {
        const memberAllowed = await canAccessDashboard({ client, guildId: guild.id, guild, user: { id: outsider.id }, member: outsider });
        const adminAllowed = await canAccessDashboard({ client, guildId: guild.id, guild, user: { id: admin.id }, member: admin });
        dashLine.text = `normal member: ${memberAllowed ? 'can open' : 'cannot open'}; administrator: ${adminAllowed ? 'can open' : 'cannot open'}`;
        if (!adminAllowed) problems.push('dashboard access: an administrator would be blocked from the dashboard');
    } catch (error) {
        dashLine.text = `could not be checked (${error.message})`;
    }

    return { lines, problems, dashLine, ruleCount: lines.length };
}

/** Ask each owner-only chat command to run as a stranger, using fake messages that send nothing. */
export async function probeOwnerCommands(client, guild, handlers) {
    const strangerId = '100000000000000009';
    const results = [];

    for (const { command, handler, ownerSafe } of handlers) {
        const probe = async (userId) => {
            const replies = [];
            const message = {
                id: `probe-${userId}`,
                author: { id: userId, bot: false, tag: 'probe#0000' },
                guild,
                channelId: 'probe',
                member: null,
                content: command,
                reply: async (payload) => { replies.push(typeof payload === 'string' ? payload : (payload?.content ?? JSON.stringify(payload))); },
            };
            try {
                await handler.execute(message, client);
                return { replies, error: null };
            } catch (error) {
                return { replies, error: error.message };
            }
        };

        const stranger = await probe(strangerId);
        const strangerBlocked = !stranger.error && (stranger.replies.length === 0 || stranger.replies.every((text) => /owner/i.test(text)));

        let ownerOk = null;
        const owner = getBotOwners()[0];
        if (ownerSafe && owner) {
            const run = await probe(owner);
            ownerOk = !run.error && run.replies.length > 0;
        }

        results.push({ command, strangerBlocked, ownerOk, error: stranger.error });
    }
    return results;
}
