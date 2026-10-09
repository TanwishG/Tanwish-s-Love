import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
} from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { isBotOwner } from '../../config/bot.js';
import {
  disableCategory,
  enableCategory,
  disableCommand,
  enableCommand,
  resolveCategoryChoice,
  buildCommandRegistry,
  isProtectedCommand,
} from '../../services/commandAccessService.js';
import {
  getCommandRestrictions,
  setCommandRoles,
  setCommandUsers,
  clearCommandRestrictions,
} from '../../services/commandRoleService.js';
import {
  buildDashboardView,
  handleDashboardComponent,
  createDashboardCollectorFilter,
  isCommandAccessCustomId,
} from './modules/commands_dashboard.js';

const DASHBOARD_TIMEOUT_MS = 10 * 60 * 1000;

function buildCategoryChoices(client) {
  const registry = buildCommandRegistry(client);
  return [...registry.values()]
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .slice(0, 25)
    .map((category) => ({
      name: `${category.icon} ${category.displayName}`.slice(0, 100),
      value: category.key,
    }));
}

async function ensureManageGuild(interaction) {
  if (isBotOwner(interaction.user?.id)) {
    return true;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await replyUserError(interaction, {
      type: ErrorTypes.PERMISSION,
      message: 'You need the **Manage Server** permission to manage commands.',
    });
    return false;
  }

  return true;
}

export default {
  data: new SlashCommandBuilder()
    .setName('commands')
    .setDescription('Manage bot commands, permissions, and who can use what')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('dashboard')
        .setDescription('Open the interactive command permissions and access dashboard'),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('permissions')
        .setDescription('View who can use a specific command')
        .addStringOption((option) =>
          option
            .setName('command')
            .setDescription('Command name')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('restrict')
        .setDescription('Restrict who can use a command to specific role(s) or user(s)')
        .addStringOption((option) =>
          option
            .setName('command')
            .setDescription('Command name to restrict')
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addRoleOption((option) =>
          option
            .setName('role')
            .setDescription('Role that may use this command')
            .setRequired(false),
        )
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('Specific user who may use this command')
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('unrestrict')
        .setDescription('Reset a command so anyone with base permissions can use it')
        .addStringOption((option) =>
          option
            .setName('command')
            .setDescription('Command name to reset')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('disable')
        .setDescription('Disable a command or entire category in this server')
        .addStringOption((option) =>
          option
            .setName('scope')
            .setDescription('Disable a single command or a whole category')
            .setRequired(true)
            .addChoices(
              { name: 'Category', value: 'category' },
              { name: 'Command', value: 'command' },
            ),
        )
        .addStringOption((option) =>
          option
            .setName('target')
            .setDescription('Category or command name')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('enable')
        .setDescription('Enable a command or entire category in this server')
        .addStringOption((option) =>
          option
            .setName('scope')
            .setDescription('Enable a single command or a whole category')
            .setRequired(true)
            .addChoices(
              { name: 'Category', value: 'category' },
              { name: 'Command', value: 'command' },
            ),
        )
        .addStringOption((option) =>
          option
            .setName('target')
            .setDescription('Category or command name')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    ),
  category: 'Core',

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const query = focused.value.toLowerCase();

    // Autocomplete for command option in restrict / unrestrict / permissions
    if (focused.name === 'command') {
      const registry = buildCommandRegistry(interaction.client);
      const allCommands = [];
      for (const category of registry.values()) {
        for (const command of category.commands) {
          if (!isProtectedCommand(command.name)) {
            allCommands.push(command.name);
          }
        }
      }
      const choices = allCommands
        .filter((name) => name.toLowerCase().includes(query))
        .slice(0, 25)
        .map((name) => ({ name: `/${name}`, value: name }));
      return interaction.respond(choices);
    }

    if (focused.name !== 'target') {
      return interaction.respond([]);
    }

    const scope = interaction.options.getString('scope');

    if (scope === 'category') {
      const choices = buildCategoryChoices(interaction.client)
        .filter((choice) => choice.name.toLowerCase().includes(query) || choice.value.includes(query))
        .slice(0, 25);
      return interaction.respond(choices);
    }

    // For command scope, get all commands including subcommands
    const registry = buildCommandRegistry(interaction.client);
    const allCommands = [];

    const matchedCategory = resolveCategoryChoice(interaction.client, query);

    if (matchedCategory) {
      for (const command of matchedCategory.commands) {
        if (!isProtectedCommand(command.name)) {
          allCommands.push(command.name);
        }
      }
    } else {
      for (const category of registry.values()) {
        for (const command of category.commands) {
          if (!isProtectedCommand(command.name)) {
            allCommands.push(command.name);
          }
        }
      }
    }

    const choices = allCommands
      .filter((name) => name.toLowerCase().includes(query))
      .slice(0, 25)
      .map((name) => ({ name: `/${name}`, value: name }));

    return interaction.respond(choices);
  },

  async execute(interaction, config, client) {
    if (!(await ensureManageGuild(interaction))) {
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    // 1. Dashboard Subcommand
    if (subcommand === 'dashboard') {
      const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferred) {
        return;
      }

      const view = await buildDashboardView(client, interaction.guildId, interaction.guild, 'overview');
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [view.embed],
        components: view.components,
      });

      const replyMessage = await interaction.fetchReply().catch(() => null);
      if (!replyMessage) {
        return;
      }

      const collector = replyMessage.createMessageComponentCollector({
        filter: createDashboardCollectorFilter(interaction.user.id, interaction.guildId),
        time: DASHBOARD_TIMEOUT_MS,
      });

      collector.on('collect', async (componentInteraction) => {
        try {
          if (!isCommandAccessCustomId(componentInteraction.customId)) {
            return;
          }
          await handleDashboardComponent(componentInteraction, client);
        } catch (error) {
          logger.error('Command access dashboard interaction failed', {
            error: error.message,
            customId: componentInteraction.customId,
            guildId: interaction.guildId,
          });
          await replyUserError(componentInteraction, {
            type: ErrorTypes.UNKNOWN,
            message: error.message || 'Failed to update command access.',
          }).catch(() => {});
        }
      });

      collector.on('end', async () => {
        const finalView = await buildDashboardView(client, interaction.guildId, interaction.guild, 'overview');
        const disabledComponents = finalView.components.map((row) => {
          const newRow = row.toJSON();
          newRow.components = newRow.components.map((component) => ({ ...component, disabled: true }));
          return newRow;
        });

        await replyMessage.edit({ components: disabledComponents }).catch(() => {});
      });

      return;
    }

    // 2. Permissions Subcommand — View who can use a command
    if (subcommand === 'permissions') {
      const commandName = interaction.options.getString('command').toLowerCase().trim();
      const restrictions = await getCommandRestrictions(client, interaction.guildId);

      const roles = restrictions.commandRoles?.[commandName] || [];
      const users = restrictions.commandUsers?.[commandName] || [];

      const rolesText = roles.length > 0 ? roles.map((id) => `<@&${id}>`).join(', ') : '`Unrestricted` (all roles)';
      const usersText = users.length > 0 ? users.map((id) => `<@${id}>`).join(', ') : '`Unrestricted` (all users)';

      const embed = new EmbedBuilder()
        .setTitle(`🔐 Permissions for /${commandName}`)
        .setDescription(`Access settings for **/${commandName}** in **${interaction.guild.name}**.`)
        .setColor(roles.length || users.length ? 0xFEE75C : 0x57F287)
        .addFields(
          { name: 'Allowed Roles', value: rolesText, inline: false },
          { name: 'Allowed Users', value: usersText, inline: false },
        )
        .setFooter({ text: 'Bot owners, server owner, and Admins can always use any command.' });

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // 3. Restrict Subcommand — Set allowed role or user for a command
    if (subcommand === 'restrict') {
      const commandName = interaction.options.getString('command').toLowerCase().trim();
      const role = interaction.options.getRole('role');
      const user = interaction.options.getUser('user');

      if (!role && !user) {
        return replyUserError(interaction, {
          type: ErrorTypes.VALIDATION,
          message: 'Please provide at least a `role` or a `user` to restrict the command to.',
        });
      }

      const restrictions = await getCommandRestrictions(client, interaction.guildId);
      const existingRoles = restrictions.commandRoles?.[commandName] || [];
      const existingUsers = restrictions.commandUsers?.[commandName] || [];

      if (role && !existingRoles.includes(role.id)) {
        existingRoles.push(role.id);
        await setCommandRoles(client, interaction.guildId, commandName, existingRoles);
      }

      if (user && !existingUsers.includes(user.id)) {
        existingUsers.push(user.id);
        await setCommandUsers(client, interaction.guildId, commandName, existingUsers);
      }

      const updatedRoles = (role ? `<@&${role.id}>` : '') + (role && user ? ' and ' : '') + (user ? `<@${user.id}>` : '');

      return interaction.reply({
        embeds: [
          successEmbed(
            'Command Restricted',
            `\`/${commandName}\` is now restricted! Added ${updatedRoles} to allowed access.\n\nUse \`/commands permissions ${commandName}\` to see current permissions.`,
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    // 4. Unrestrict Subcommand — Clear restrictions
    if (subcommand === 'unrestrict') {
      const commandName = interaction.options.getString('command').toLowerCase().trim();
      await clearCommandRestrictions(client, interaction.guildId, commandName);

      return interaction.reply({
        embeds: [
          successEmbed(
            'Restrictions Cleared',
            `All role and user restrictions for \`/${commandName}\` have been cleared. Anyone with base permissions can use it.`,
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    // 5. Enable / Disable Subcommand
    const scope = interaction.options.getString('scope');
    const target = interaction.options.getString('target');
    const isDisable = subcommand === 'disable';

    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) {
      return;
    }

    if (scope === 'category') {
      const category = resolveCategoryChoice(client, target);
      if (!category) {
        return await replyUserError(interaction, {
          type: ErrorTypes.UNKNOWN,
          message: `No category matched \`${target}\`. Use \`/commands dashboard\` to browse categories.`,
        });
      }

      if (isDisable) {
        await disableCategory(client, interaction.guildId, category.key);
        return InteractionHelper.safeEditReply(interaction, {
          embeds: [
            successEmbed(
              'Category Disabled',
              `All **${category.displayName}** commands are now disabled.\nProtected commands remain available.`,
            ),
          ],
        });
      }

      await enableCategory(client, interaction.guildId, category.key);
      return InteractionHelper.safeEditReply(interaction, {
        embeds: [
          successEmbed(
            'Category Enabled',
            `**${category.displayName}** commands are now enabled (except individually disabled commands).`,
          ),
        ],
      });
    }

    const commandName = target.toLowerCase();
    if (isDisable) {
      await disableCommand(client, interaction.guildId, commandName);
      return InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('Command Disabled', `\`/${commandName}\` is now disabled in this server.`)],
      });
    }

    await enableCommand(client, interaction.guildId, commandName);
    return InteractionHelper.safeEditReply(interaction, {
      embeds: [successEmbed('Command Enabled', `\`/${commandName}\` is now enabled in this server.`)],
    });
  },
};
