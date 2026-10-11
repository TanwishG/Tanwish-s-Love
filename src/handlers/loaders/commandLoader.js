import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createHash } from 'node:crypto';
import { Collection, Routes } from 'discord.js';
import { logger } from '../../utils/logger.js';
import botConfig from '../../config/bot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAX_COMMANDS = 100;
const COMMAND_COUNT_WARN_THRESHOLD = 90;

function getSubcommandInfo(commandData) {
    const subcommands = [];
    
    if (commandData.options) {
        for (const option of commandData.options) {
if (option.type === 1) {
                subcommands.push(option.name);
} else if (option.type === 2) {
                if (option.options) {
                    for (const subOption of option.options) {
if (subOption.type === 1) {
                            subcommands.push(`${option.name}/${subOption.name}`);
                        }
                    }
                }
            }
        }
    }
    
    return subcommands;
}

async function getAllFiles(directory, fileList = []) {
    const files = await fs.readdir(directory, { withFileTypes: true });
    
    for (const file of files) {
        const filePath = path.join(directory, file.name);
        
        if (file.isDirectory()) {
            if (file.name === 'modules') {
                continue;
            }
            await getAllFiles(filePath, fileList);
        } else if (file.name.endsWith('.js')) {
            fileList.push(filePath);
        }
    }
    
    return fileList;
}

export async function loadCommands(client) {
    client.commands = new Collection();
    const commandsPath = path.join(__dirname, '../../commands');
    const commandFiles = await getAllFiles(commandsPath);
    
    logger.info(`Found ${commandFiles.length} command files to load`);
    
    const uniqueCommandNames = new Set();
    
    for (const filePath of commandFiles) {
        try {
            const normalizedPath = filePath.replace(/\\/g, '/');
            
            const commandName = path.basename(filePath, '.js');
            const commandDir = path.dirname(filePath);
            const category = path.basename(commandDir);
            
            const commandModule = await import(`file://${filePath}`);
            const command = commandModule.default || commandModule;
            
            if (!command.data || !command.execute) {
                logger.warn(`Command at ${filePath} is missing required "data" or "execute" property.`);
                continue;
            }
            
            command.category = category;
            command.filePath = normalizedPath;
            
            const primaryCommandName = command.data.name;
            
            if (!uniqueCommandNames.has(primaryCommandName)) {
                uniqueCommandNames.add(primaryCommandName);
                
                client.commands.set(primaryCommandName, command);
            }
            
            const subcommands = getSubcommandInfo(command.data.toJSON());
            
            logger.info(`Loaded command: ${primaryCommandName} from ${normalizedPath} (category: ${category})`);
            
            if (subcommands.length > 0) {
                logger.info(`  - Subcommands: ${subcommands.join(', ')}`);
            }
            
        } catch (error) {
            logger.error(`Error loading command from ${filePath}:`, error);
        }
    }
    
    const commandsWithSubcommands = Array.from(client.commands.values()).filter(cmd => {
        const subcommands = getSubcommandInfo(cmd.data.toJSON());
        return subcommands.length > 0;
    });
    
    const totalSubcommands = commandsWithSubcommands.reduce((total, cmd) => {
        return total + getSubcommandInfo(cmd.data.toJSON()).length;
    }, 0);
    
    const uniqueCommands = new Set();
    for (const [name, command] of client.commands.entries()) {
        if (command.data && command.data.name) {
            uniqueCommands.add(command.data.name);
        }
    }
    
    logger.info(`Loaded ${uniqueCommands.size} commands`);
    return client.commands;
}

function collectCommandPayloads(client) {
    const commands = [];
    let totalSubcommands = 0;
    const registeredNames = new Set();

    for (const command of client.commands.values()) {
        if (!command.data || typeof command.data.toJSON !== 'function') {
            logger.warn(`Command missing data or toJSON method: ${command}`);
            continue;
        }

        const commandName = command.data.name;
        logger.debug(`Processing command for registration: ${commandName}`);

        if (registeredNames.has(commandName)) {
            logger.debug(`Skipping duplicate command: ${commandName}`);
            continue;
        }

        registeredNames.add(commandName);
        const commandJson = command.data.toJSON();
        commands.push(commandJson);
        totalSubcommands += getSubcommandInfo(commandJson).length;

        if (process.env.NODE_ENV !== 'production') {
            logger.debug(`Registering command: ${commandName}`);
        }
    }

    return { commands, totalSubcommands };
}

function validateCommands(commands) {
    const validationErrors = [];

    for (const cmd of commands) {
        if (cmd.name && cmd.name.length > 32) {
            validationErrors.push(`Command ${cmd.name} has name longer than 32 chars: "${cmd.name}" (${cmd.name.length} chars)`);
        }
        if (cmd.description && cmd.description.length > 100) {
            validationErrors.push(`Command ${cmd.name} has description longer than 100 chars: "${cmd.description}" (${cmd.description.length} chars)`);
        }

        if (!cmd.options) {
            continue;
        }

        for (const option of cmd.options) {
            if (option.name && option.name.length > 32) {
                validationErrors.push(`Command ${cmd.name} option ${option.name} has name longer than 32 chars: "${option.name}" (${option.name.length} chars)`);
            }
            if (option.description && option.description.length > 100) {
                validationErrors.push(`Command ${cmd.name} option ${option.name} has description longer than 100 chars: "${option.description}" (${option.description.length} chars)`);
            }

            if (option.choices) {
                for (const choice of option.choices) {
                    if (choice.name && choice.name.length > 100) {
                        validationErrors.push(`Command ${cmd.name} option ${option.name} choice ${choice.name} has name longer than 100 chars: "${choice.name}" (${choice.name.length} chars)`);
                    }
                    if (choice.value && choice.value.length > 100) {
                        validationErrors.push(`Command ${cmd.name} option ${option.name} choice ${choice.name} has value longer than 100 chars: "${choice.value}" (${choice.value.length} chars)`);
                    }
                }
            }

            if (!option.options) {
                continue;
            }

            for (const subOption of option.options) {
                if (subOption.name && subOption.name.length > 32) {
                    validationErrors.push(`Command ${cmd.name} subcommand ${option.name} option ${subOption.name} has name longer than 32 chars: "${subOption.name}" (${subOption.name.length} chars)`);
                }
                if (subOption.description && subOption.description.length > 100) {
                    validationErrors.push(`Command ${cmd.name} subcommand ${option.name} option ${subOption.name} has description longer than 100 chars: "${subOption.description}" (${subOption.description.length} chars)`);
                }

                if (!subOption.choices) {
                    continue;
                }

                for (const choice of subOption.choices) {
                    if (choice.name && choice.name.length > 100) {
                        validationErrors.push(`Command ${cmd.name} subcommand ${option.name} option ${subOption.name} choice ${choice.name} has name longer than 100 chars: "${choice.name}" (${choice.name.length} chars)`);
                    }
                    if (choice.value && choice.value.length > 100) {
                        validationErrors.push(`Command ${cmd.name} subcommand ${option.name} option ${subOption.name} choice ${choice.name} has value longer than 100 chars: "${choice.value}" (${choice.value.length} chars)`);
                    }
                }
            }
        }
    }

    if (validationErrors.length > 0) {
        logger.error('Command validation failed. Errors:');
        validationErrors.forEach((error) => logger.error(`  - ${error}`));
        throw new Error(`Command validation failed with ${validationErrors.length} errors`);
    }
}

function prepareCommandsForRegistration(commands) {
    if (commands.length >= COMMAND_COUNT_WARN_THRESHOLD) {
        logger.warn(`Command count (${commands.length}) is near Discord's ${MAX_COMMANDS} global command limit`);
    }

    if (commands.length <= MAX_COMMANDS) {
        return commands;
    }

    logger.warn(`Command count (${commands.length}) exceeds Discord limit (${MAX_COMMANDS}), truncating...`);
    const truncated = commands.slice(0, MAX_COMMANDS);
    logger.info(`Truncated to ${truncated.length} commands for registration`);
    return truncated;
}

async function registerGlobalCommands(client, clientId, commands, totalSubcommands) {
    if (!clientId) {
        throw new Error('CLIENT_ID is required for slash command registration');
    }

    if (!client.rest) {
        throw new Error('Discord REST client is not available for slash command registration');
    }

    logger.info(`Preparing to register ${totalSubcommands + commands.length} commands globally`);
    logger.info('Validating commands before registration...');
    validateCommands(commands);
    logger.info('Command validation passed');

    const commandsToRegister = prepareCommandsForRegistration(commands);

    if (botConfig.commands?.deleteCommands) {
        logger.info('Clearing existing global commands before registration...');
        await client.rest.put(`/applications/${clientId}/commands`, { body: [] });
    }

    if (commands.length > MAX_COMMANDS) {
        const dropped = commands.slice(MAX_COMMANDS).map((command) => `/${command.name}`).join(', ');
        logger.error(`⚠️ ${commands.length} commands exist but Discord allows only ${MAX_COMMANDS}. NOT registered: ${dropped}`);
    }

    logger.info(`Registering ${commandsToRegister.length} global commands...`);

    // If Discord rate-limits this request the REST library waits silently. Say so out loud.
    const onRateLimit = (info) => {
        const seconds = Math.ceil((info.timeToReset || 0) / 1000);
        logger.warn(`⏳ Discord rate limit while registering commands (${info.method} ${info.route}): must wait ${seconds}s (~${Math.round(seconds / 60)} min).`);
        if (seconds > 600) {
            logger.warn('⏳ That is a long wait: Discord limits how many command changes one bot can make per day. Do NOT restart the bot repeatedly. Wait, or try again tomorrow.');
        }
    };
    client.rest.on?.('rateLimited', onRateLimit);
    const waitNotice = setInterval(() => {
        logger.warn('Still waiting for Discord to accept the command registration (rate limit or connection problem)...');
    }, 30_000);

    try {
        await client.rest.put(`/applications/${clientId}/commands`, { body: commandsToRegister });
    } finally {
        clearInterval(waitNotice);
        client.rest.off?.('rateLimited', onRateLimit);
    }
    logger.info(`Successfully registered ${commandsToRegister.length} global commands`);

    // Ask Discord what it actually has now, so a silent problem shows up in the log.
    try {
        const registered = await client.rest.get(`/applications/${clientId}/commands`);
        const names = new Set(registered.map((command) => command.name));
        logger.info(`Discord now lists ${registered.length} global slash commands (/commands present: ${names.has('commands')}, /tts present: ${names.has('tts')})`);
        logger.info(`If slash commands still do not show in a server, re-invite the bot with: https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=8`);
    } catch (verifyError) {
        logger.warn(`Could not verify registered commands: ${verifyError.message}`);
    }
    logger.info('Global commands may take up to an hour to appear in all servers on first deploy');
}

/** The exact list of commands that is sent to Discord (already trimmed to Discord's limit). */
export function getRegistrationPayload(client) {
    const { commands } = collectCommandPayloads(client);
    return prepareCommandsForRegistration(commands);
}

const GUILD_TIMEOUT_MS = 60_000;
const inviteLink = (id) => `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot%20applications.commands&permissions=8`;

/** "guild" (default): register in each server. "global": one worldwide registration. */
export function getCommandScope() {
    return String(botConfig.commands?.scope || 'guild').toLowerCase() === 'global' ? 'global' : 'guild';
}

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: Discord did not answer within ${Math.round(ms / 1000)}s (probably rate limited)`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Registers (or removes) the slash commands in ONE server. Instant, and uses a separate Discord
 * limit from global registration. Skips the request when nothing changed since last time.
 */
export async function registerCommandsForGuild(client, guildId, options = {}) {
    const { clientId = client.user?.id, force = false, remove = false, timeoutMs = GUILD_TIMEOUT_MS, payload = null } = options;
    const route = Routes.applicationGuildCommands(clientId, guildId);
    const hashKey = `bot:command_hash:${guildId}`;

    if (remove) {
        await withTimeout(client.rest.put(route, { body: [] }), timeoutMs, 'Removing server commands');
        try { await client.db?.delete(hashKey); } catch { /* ignore */ }
        return { status: 'removed', count: 0 };
    }

    const body = payload ?? getRegistrationPayload(client);
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');

    if (!force) {
        let stored = null;
        try { stored = await client.db?.get(hashKey, null); } catch { /* ignore */ }
        if (stored === hash) {
            try {
                const current = await withTimeout(client.rest.get(route), timeoutMs, 'Checking server commands');
                if (current.length === body.length) return { status: 'unchanged', count: body.length };
            } catch {
                // could not verify: fall through and register again
            }
        }
    }

    await withTimeout(client.rest.put(route, { body }), timeoutMs, 'Registering server commands');
    try { await client.db?.set(hashKey, hash); } catch { /* ignore */ }
    return { status: 'registered', count: body.length };
}

export async function registerCommandsForAllGuilds(client, options = {}) {
    const clientId = options.clientId || client.user?.id;
    const guilds = [...client.guilds.cache.values()];
    const payload = getRegistrationPayload(client);

    logger.info(`Command scope: per-server. Registering ${payload.length} commands in ${guilds.length} server(s)...`);

    const onRateLimit = (info) => {
        logger.warn(`Discord rate limit while registering commands (${info.method} ${info.route}): waiting ${Math.ceil((info.timeToReset || 0) / 1000)}s`);
    };
    client.rest.on?.('rateLimited', onRateLimit);

    let registered = 0;
    let failed = 0;
    try {
        for (const guild of guilds) {
            try {
                const result = await registerCommandsForGuild(client, guild.id, { clientId, payload, timeoutMs: options.timeoutMs });
                registered += 1;
                logger.info(`Commands in "${guild.name}": ${result.count} (${result.status})`);
            } catch (error) {
                failed += 1;
                logger.warn(`Could not register commands in "${guild.name}" (${guild.id}): ${error.message}`);
                if (error.status === 403 || error.code === 50001) {
                    logger.warn(`The bot lacks the "applications.commands" permission there. Re-invite it with: ${inviteLink(clientId)}`);
                }
            }
        }
    } finally {
        client.rest.off?.('rateLimited', onRateLimit);
    }

    logger.info(`Per-server command registration finished: ${registered} ok, ${failed} failed`);
    return { registered, failed };
}

export async function registerCommands(client, options = {}) {
    const { clientId = null } = options;

    try {
        const { commands, totalSubcommands } = collectCommandPayloads(client);

        if (getCommandScope() === 'guild') {
            // Validated now; the actual registration happens per server once the bot is ready.
            validateCommands(commands);
            const prepared = prepareCommandsForRegistration(commands);
            if (commands.length > MAX_COMMANDS) {
                const dropped = commands.slice(MAX_COMMANDS).map((command) => `/${command.name}`).join(', ');
                logger.error(`${commands.length} commands exist but Discord allows only ${MAX_COMMANDS}. NOT registered: ${dropped}`);
            }
            logger.info(`Command scope: per-server (${prepared.length} commands). They are registered in each server when the bot is ready.`);
            return;
        }

        await registerGlobalCommands(client, clientId, commands, totalSubcommands);
    } catch (error) {
        logger.error(`❌ Slash command registration FAILED: ${error.message}`);
        if (error.rawError?.errors) {
            logger.error(`Discord says: ${JSON.stringify(error.rawError.errors).slice(0, 1500)}`);
        }
        logger.error('Slash commands will not appear or update until this is fixed (prefix commands still work).');
        throw error;
    }
}

export async function reloadCommand(client, commandName) {
    const command = client.commands.get(commandName);
    
    if (!command) {
        return { success: false, message: `Command "${commandName}" not found` };
    }
    
    try {
        const commandPath = path.resolve(command.filePath);
        const moduleUrl = pathToFileURL(commandPath);
        moduleUrl.searchParams.set('t', Date.now().toString());

        const newCommand = (await import(moduleUrl.href)).default;
        
        client.commands.set(commandName, newCommand);
        
        logger.info(`Reloaded command: ${commandName}`);
        return { success: true, message: `Successfully reloaded command "${commandName}"` };
    } catch (error) {
        logger.error(`Error reloading command "${commandName}":`, error);
        return { success: false, message: `Error reloading command: ${error.message}` };
    }
}