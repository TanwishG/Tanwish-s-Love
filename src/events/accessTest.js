// "!test" - checks who can use which commands, including the bot-owner-only ones.
//
//   !test                    -> full report
//   !test <command>          -> details for one command, e.g. !test ban   or   !test bypass lock
//   !test <command> @member  -> also checks that specific person
//   !test @member            -> full report that also includes that person
//
// Needs Manage Server (or being the bot owner). Replace "!" with your server's prefix.

import { Events } from 'discord.js';
import { getBotOwners, getCommandPrefix, isBotOwner, isMaintenanceMode } from '../config/bot.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { probeOwnerCommands, runAccessTest, testOneCommand, verifyRules } from '../services/accessTestService.js';
import ownerPresence from './ownerPresence.js';
import slashDiagnostics from './slashDiagnostics.js';
import { createEmbed } from '../utils/embeds.js';
import { logger } from '../utils/logger.js';

const OK = '`ALLOWED`';
const NO = '`BLOCKED`';
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

async function resolveMember(message, token) {
    const mentioned = message.mentions?.members?.first();
    if (mentioned) return mentioned;
    if (/^\d{15,22}$/.test(token || '')) return message.guild.members.fetch(token).catch(() => null);
    return null;
}

export default {
    name: Events.MessageCreate,
    async execute(message, client) {
        try {
            if (message.author.bot || !message.guild || !message.content) return;

            const guildConfig = await getGuildConfig(client, message.guild.id).catch(() => null);
            const prefix = guildConfig?.prefix || getCommandPrefix();
            const [head, ...rest] = message.content.trim().split(/\s+/);
            if (head.toLowerCase() !== `${prefix}test` || client.commands?.has('test')) return;

            const allowed = isBotOwner(message.author.id)
                || message.member?.permissions?.has('ManageGuild')
                || message.member?.permissions?.has('Administrator');
            if (!allowed) {
                await message.reply('You need the **Manage Server** permission to use this command.');
                return;
            }

            await message.channel?.sendTyping?.().catch(() => {});
            const caller = message.member || (await message.guild.members.fetch(message.author.id).catch(() => null));
            const mention = message.mentions?.members?.first() ?? null;
            const textArgs = rest.filter((token) => !/^<@!?\d+>$/.test(token));
            const extraMember = mention ?? (await resolveMember(message, textArgs.at(-1)));
            const nameParts = extraMember && !mention && /^\d{15,22}$/.test(textArgs.at(-1) || '') ? textArgs.slice(0, -1) : textArgs;
            const commandName = nameParts.join(' ');

            // ---------- one command ----------
            if (commandName) {
                const detail = await testOneCommand(client, message.guild, caller, commandName, { extraMember });
                if (!detail) {
                    await message.reply(`I could not find a command called \`${commandName}\`. Run \`${prefix}test\` for the full report.`);
                    return;
                }

                const lines = detail.results.map(({ persona, allowed: isAllowed, reason }) =>
                    `${isAllowed ? OK : NO} **${persona.label}** - ${reason}`);

                await message.reply({
                    embeds: [createEmbed({
                        title: `Access test: /${detail.entry.name}`,
                        description: lines.join('\n'),
                        color: 'info',
                        fields: [
                            { name: 'Category', value: detail.categoryName || 'unknown', inline: true },
                            { name: 'Dashboard', value: detail.dashboardEnabled ? 'turned on' : 'turned off', inline: true },
                            { name: 'Discord permission', value: detail.discordPermission || 'none needed', inline: true },
                            { name: 'Access rule', value: clip(detail.ruleText, 1000), inline: false },
                        ],
                        footer: 'Member = no permissions, ManageServer = has Manage Server, Admin = Administrator, BotOwner = listed in OWNER_IDS',
                    })],
                    allowedMentions: { parse: [], repliedUser: false },
                });
                return;
            }

            // ---------- full report ----------
            const report = await runAccessTest(client, message.guild, caller, { extraMember });
            const rules = await verifyRules(client, message.guild);

            const probes = await probeOwnerCommands(client, message.guild, [
                { command: `${prefix}slashcheck`, handler: slashDiagnostics, ownerSafe: false },
                { command: `${prefix}slashhere`, handler: slashDiagnostics, ownerSafe: false },
                { command: `${prefix}presence`, handler: ownerPresence, ownerSafe: true },
                { command: `${prefix}status`, handler: ownerPresence, ownerSafe: true },
                { command: `${prefix}activity`, handler: ownerPresence, ownerSafe: true },
            ]);

            const problems = [...rules.problems];
            const owners = getBotOwners();
            if (owners.length === 0) problems.push('OWNER_IDS is empty, so nobody can use the owner-only commands');
            if (isMaintenanceMode()) problems.push('maintenance mode is ON, so only the bot owner can use commands');
            for (const probe of probes) {
                if (!probe.strangerBlocked) problems.push(`${probe.command}: a non-owner was NOT blocked`);
                if (probe.ownerOk === false) problems.push(`${probe.command}: did not respond for the owner`);
            }
            const disabled = report.categories.filter((c) => c.total > 0 && c.counts.member === 0 && c.counts.admin === 0);
            for (const c of disabled) problems.push(`category ${c.name}: nobody except the bot owner can use it`);

            const total = report.categories.reduce((n, c) => n + c.total, 0);
            const personaNames = report.personas.map((p) => p.label).join(', ');

            const blockedForYou = report.categories.flatMap((c) => c.blockedForYou.map((b) => `/${b.name} - ${b.reason}`));

            const summary = createEmbed({
                title: 'Access test',
                description: [
                    `Checked **${total}** commands (including subcommands) in **${report.categories.length}** categories as: ${personaNames}.`,
                    'This runs the same checks the bot uses for real: maintenance mode, category switch, dashboard on/off, access rules, then the command\'s Discord permission.',
                ].join('\n'),
                color: problems.length ? 'warning' : 'success',
                fields: [
                    {
                        name: problems.length ? `Problems found (${problems.length})` : 'Problems found',
                        value: problems.length ? clip(problems.slice(0, 12).map((p) => `- ${p}`).join('\n'), 1000) : 'None. Everything behaved as configured.',
                        inline: false,
                    },
                    {
                        name: `Blocked for you (${blockedForYou.length})`,
                        value: blockedForYou.length ? clip(blockedForYou.slice(0, 8).join('\n') + (blockedForYou.length > 8 ? `\n...and ${blockedForYou.length - 8} more` : ''), 1000) : 'Nothing. You can use every command.',
                        inline: false,
                    },
                ],
            });

            const matrix = createEmbed({
                title: 'Who can use what',
                description: clip(report.categories.map((c) =>
                    `**${c.name}** (${c.total}): ${report.personas.map((p) => `${p.label} ${c.counts[p.key]}`).join(' | ')}`,
                ).join('\n'), 4000),
                color: 'info',
                footer: 'Numbers = how many commands in the category that person may use. Use !test <command> for the reason behind a single command.',
            });

            const ownerLines = probes.map((probe) => {
                const stranger = probe.strangerBlocked ? 'non-owners blocked' : 'NON-OWNERS CAN USE IT';
                const owner = probe.ownerOk === null ? '' : probe.ownerOk ? ', owner works' : ', OWNER DID NOT WORK';
                return `${probe.strangerBlocked && probe.ownerOk !== false ? OK : NO} \`${probe.command}\` - ${stranger}${owner}`;
            });
            const ownerEmbed = createEmbed({
                title: 'Owner-only commands',
                description: [
                    `You are ${isBotOwner(message.author.id) ? '**recognised as the bot owner**' : '**not** the bot owner'}. Owner IDs configured: **${owners.length}**.`,
                    '',
                    ...ownerLines,
                    '',
                    'The bot owner skips: maintenance mode, command cooldowns, dashboard on/off, access rules, and the command\'s Discord permission check.',
                ].join('\n'),
                color: probes.every((p) => p.strangerBlocked) && owners.length > 0 ? 'success' : 'warning',
            });

            const embeds = [summary, matrix, ownerEmbed];

            const ruleLines = rules.lines.map((line) => `${line.ok ? OK : NO} **${line.label}** - ${line.who}${line.ok ? '' : ` (${line.failures.join('; ')})`}`);
            ruleLines.push(`**${rules.dashLine.label}** - ${rules.dashLine.text}`);
            embeds.push(createEmbed({
                title: `Access rules check (${rules.ruleCount})`,
                description: rules.ruleCount
                    ? clip(ruleLines.join('\n'), 4000)
                    : `No access rules are set, so nothing is restricted by rules.\n${ruleLines.at(-1)}`,
                color: 'info',
            }));

            await message.reply({ embeds, allowedMentions: { parse: [], repliedUser: false } });
        } catch (error) {
            logger.error('Error in !test handler:', error);
            await message.reply('Something went wrong while running the test. Check the console for details.').catch(() => {});
        }
    },
};
