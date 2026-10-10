import axios from 'axios';
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';
import { logger } from '../utils/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIME = '18:00';
const MAX_USED_QUESTIONS = 500;
const OPENTDB_URL = 'https://opentdb.com/api.php';

function decodeHtml(value = '') {
  return String(value)
    .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function normalizeAnswer(value = '') {
  return decodeHtml(value).normalize('NFKC').toLowerCase()
    .replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function questionKey(question) {
  return normalizeAnswer(question.question);
}

function getToday(timeZone = 'Asia/Kolkata') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function timeMatches(time, now = new Date()) {
  const [hour, minute] = String(time || DEFAULT_TIME).split(':').map(Number);
  return now.getHours() === hour && now.getMinutes() === minute;
}

function isAdmin(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

async function fetchFreshQuestion(config) {
  const used = new Set(Array.isArray(config.qotd?.usedQuestionKeys) ? config.qotd.usedQuestionKeys : []);
  // Open Trivia DB difficulty=easy or medium only; exclude hard questions entirely.
  for (const difficulty of ['easy', 'medium']) {
    try {
      const response = await axios.get(OPENTDB_URL, {
        params: { amount: 50, type: 'multiple', difficulty }, timeout: 10000,
        headers: { 'User-Agent': 'TanwishsLove-QOTD/1.0' },
      });
      const results = response.data?.results || [];
      const fresh = results.filter((entry) => {
        if (!entry.question || !entry.correct_answer || !Array.isArray(entry.incorrect_answers)) return false;
        const key = questionKey({ question: entry.question });
        return key && !used.has(key);
      });
      if (fresh.length) {
        const entry = fresh[Math.floor(Math.random() * fresh.length)];
        const level = difficulty === 'easy' ? 1 : 2;
        return {
          question: decodeHtml(entry.question), answer: decodeHtml(entry.correct_answer),
          alternatives: entry.incorrect_answers.map(decodeHtml), category: decodeHtml(entry.category || 'General Knowledge'),
          difficulty: level, source: 'Open Trivia DB', key: questionKey({ question: entry.question }),
        };
      }
    } catch (error) {
      logger.warn(`QOTD trivia source request failed (${difficulty}): ${error.message}`);
    }
  }
  throw new Error('Could not find an unused easy/medium question from the trivia source. Try again later.');
}

function makeQuestionEmbed(question, guild) {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🧠 Question of the Day')
    .setDescription(`**${question.question}**\n\nReply in this channel with your answer. The first correct answer wins!`)
    .addFields(
      { name: 'Difficulty', value: `${question.difficulty}/4 · ${question.difficulty === 1 ? 'Easy' : 'Easy–Medium'}`, inline: true },
      { name: 'Category', value: question.category || 'General Knowledge', inline: true },
      { name: 'Prize', value: '🏆 QOTD Winner role for 24 hours', inline: false },
    )
    .setFooter({ text: `${guild.name} • Question source: ${question.source}` })
    .setTimestamp();
}

async function publishQuestion(client, guild, config, { manual = false } = {}) {
  const qotd = config.qotd || {};
  const channel = guild.channels.cache.get(qotd.channelId);
  const role = guild.roles.cache.get(qotd.roleId);
  if (!channel?.isTextBased?.() || !channel.send) throw new Error('QOTD channel is missing or is not a text channel. Run /qotd setup again.');
  if (!role) throw new Error('QOTD winner role is missing. Run /qotd setup again.');
  if (!guild.members.me?.permissionsIn(channel).has(PermissionFlagsBits.SendMessages)
    || !guild.members.me?.permissionsIn(channel).has(PermissionFlagsBits.EmbedLinks)) {
    throw new Error('I need Send Messages and Embed Links permissions in the QOTD channel.');
  }
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('I need Manage Roles permission to award the QOTD winner role.');
  if (role.position >= guild.members.me.roles.highest.position) throw new Error('Move the QOTD Winner role below my highest role so I can award it.');

  const question = await fetchFreshQuestion(config);
  const sent = await channel.send({ embeds: [makeQuestionEmbed(question, guild)], allowedMentions: { parse: [] } });
  const today = getToday(qotd.timeZone || 'Asia/Kolkata');
  const usedQuestionKeys = [...(qotd.usedQuestionKeys || []), question.key].slice(-MAX_USED_QUESTIONS);
  await updateGuildConfig(client, guild.id, {
    qotd: {
      ...qotd, enabled: qotd.enabled !== false, channelId: channel.id, roleId: role.id,
      time: qotd.time || DEFAULT_TIME, maxDifficulty: Math.min(2, Math.max(1, Number(qotd.maxDifficulty || 2))),
      lastPostedDate: today,
      activeQuestion: { ...question, messageId: sent.id, channelId: channel.id, postedAt: Date.now(), winnerId: null },
      usedQuestionKeys,
    },
  });
  logger.info(`QOTD posted in guild ${guild.id} (${question.source}, difficulty ${question.difficulty})`);
  return sent;
}

async function removeExpiredWinnerRoles(client, guild, qotd) {
  const expiries = Array.isArray(qotd.roleExpiries) ? qotd.roleExpiries : [];
  const remaining = [];
  for (const entry of expiries) {
    if (!entry?.userId || !entry?.roleId || !Number.isFinite(entry.expiresAt)) continue;
    if (entry.expiresAt > Date.now()) { remaining.push(entry); continue; }
    const member = await guild.members.fetch(entry.userId).catch(() => null);
    const role = guild.roles.cache.get(entry.roleId);
    if (member && role && member.roles.cache.has(role.id)) {
      await member.roles.remove(role, 'QOTD winner role expired').catch((error) => logger.warn(`Could not remove expired QOTD role: ${error.message}`));
    }
  }
  if (remaining.length !== expiries.length) {
    await updateGuildConfig(client, guild.id, { qotd: { ...qotd, roleExpiries: remaining } });
  }
}

export async function handleQotdMessage(message, client) {
  if (!message.guild || message.author.bot || !message.content || !client.user) return;
  const config = await getGuildConfig(client, message.guild.id);
  const qotd = config.qotd || {};
  const active = qotd.activeQuestion;
  if (!qotd.enabled || !active || active.winnerId || message.channelId !== active.channelId) return;
  if (normalizeAnswer(message.content) !== normalizeAnswer(active.answer)) return;
  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  const role = message.guild.roles.cache.get(qotd.roleId);
  if (!member || !role) return;
  if (!message.guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= message.guild.members.me.roles.highest.position) {
    logger.warn(`QOTD winner role cannot be assigned in guild ${message.guild.id}; check role permissions/hierarchy.`);
    return;
  }
  await member.roles.add(role, 'First correct QOTD answer');
  const roleExpiries = [...(qotd.roleExpiries || []).filter((entry) => !(entry.userId === member.id && entry.roleId === role.id)),
    { userId: member.id, roleId: role.id, expiresAt: Date.now() + DAY_MS }];
  await updateGuildConfig(client, message.guild.id, {
    qotd: { ...qotd, activeQuestion: { ...active, winnerId: member.id }, roleExpiries },
  });
  await message.channel.send({
    content: `🏆 ${member} got the first correct answer and won ${role}! The role will be removed in 24 hours.`,
    allowedMentions: { users: [member.id], roles: [] },
  });
  const questionMessage = await message.channel.messages.fetch(active.messageId).catch(() => null);
  if (questionMessage) {
    const embed = EmbedBuilder.from(questionMessage.embeds[0] || new EmbedBuilder())
      .setFooter({ text: `Winner: ${member.user.tag} • Answer: ${active.answer}` });
    await questionMessage.edit({ embeds: [embed] }).catch(() => {});
  }
}

export async function runQotdScheduler(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await getGuildConfig(client, guild.id);
      const qotd = config.qotd || {};
      await removeExpiredWinnerRoles(client, guild, qotd);
      if (!qotd.enabled || !qotd.channelId || !qotd.roleId) continue;
      const now = new Date();
      const timeZone = qotd.timeZone || 'Asia/Kolkata';
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
      const today = getToday(timeZone);
      if (parts !== (qotd.time || DEFAULT_TIME) || qotd.lastPostedDate === today) continue;
      await publishQuestion(client, guild, config);
    } catch (error) {
      logger.warn(`QOTD scheduled task failed for guild ${guild.id}: ${error.message}`);
    }
  }
}

export function initializeQotd(client, cron) {
  client.on('messageCreate', (message) => handleQotdMessage(message, client).catch((error) => logger.error('QOTD answer handler failed:', error)));
  cron.schedule('* * * * *', () => runQotdScheduler(client));
  // Retry role expiry and missed schedules soon after startup; last-posted date prevents duplicates.
  setTimeout(() => runQotdScheduler(client).catch((error) => logger.warn(`QOTD startup check failed: ${error.message}`)), 5000);
}

export async function setupQotd(client, guildId, { channelId, roleId, time, maxDifficulty }) {
  const config = await getGuildConfig(client, guildId);
  const normalizedTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(time || '') ? time : null;
  if (!normalizedTime) throw new Error('Use 24-hour time like 18:30.');
  const max = Number(maxDifficulty);
  if (!Number.isInteger(max) || max < 1 || max > 4) throw new Error('Maximum difficulty must be from 1 to 4. For an all-ages server, levels 1–2 are recommended; the source only supplies easy/medium questions.');
  await updateGuildConfig(client, guildId, {
    qotd: { ...(config.qotd || {}), enabled: true, channelId, roleId, time: normalizedTime,
      timeZone: 'Asia/Kolkata', maxDifficulty: Math.min(max, 2), usedQuestionKeys: config.qotd?.usedQuestionKeys || [],
      roleExpiries: config.qotd?.roleExpiries || [], lastPostedDate: config.qotd?.lastPostedDate || null },
  });
  return { time: normalizedTime, maxDifficulty: Math.min(max, 2) };
}

export async function postQotdNow(client, guild) {
  const config = await getGuildConfig(client, guild.id);
  if (!config.qotd?.channelId || !config.qotd?.roleId) throw new Error('Run /qotd setup first to select a channel and winner role.');
  return publishQuestion(client, guild, config, { manual: true });
}

export async function getQotdStatus(client, guildId) {
  const config = await getGuildConfig(client, guildId);
  const qotd = config.qotd || {};
  return { enabled: Boolean(qotd.enabled), channelId: qotd.channelId || null, roleId: qotd.roleId || null,
    time: qotd.time || DEFAULT_TIME, timeZone: qotd.timeZone || 'Asia/Kolkata',
    maxDifficulty: qotd.maxDifficulty || 2, lastPostedDate: qotd.lastPostedDate || null,
    hasActiveQuestion: Boolean(qotd.activeQuestion && !qotd.activeQuestion.winnerId) };
}
