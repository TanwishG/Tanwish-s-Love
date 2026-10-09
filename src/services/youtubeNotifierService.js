import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const DATA_FILE = path.join(DATA_DIR, 'youtube-notifier.json');
const POLL_MS = Math.max(60_000, Number(process.env.YOUTUBE_POLL_MS) || 120_000);
let timer = null;
let busy = false;
let state = { guilds: {} };

async function loadState() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.guilds && typeof parsed.guilds === 'object') state = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') logger.warn('YouTube notifier could not load state; starting empty.', { error: error.message });
    try { await fs.mkdir(DATA_DIR, { recursive: true }); await saveState(); } catch (saveError) {
      logger.warn('YouTube notifier state file is not writable; settings may not survive restarts.', { error: saveError.message });
    }
  }
}
async function saveState() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temp = `${DATA_FILE}.tmp`;
  await fs.writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(temp, DATA_FILE);
}
function guildState(guildId) {
  if (!state.guilds[guildId]) state.guilds[guildId] = { destinationChannelId: null, subscriptions: {} };
  const g = state.guilds[guildId];
  if (!g.subscriptions || typeof g.subscriptions !== 'object') g.subscriptions = {};
  return g;
}
function cleanChannelId(input) {
  const match = String(input).match(/(?:youtube\.com\/channel\/)?(UC[a-zA-Z0-9_-]{20,})/);
  return match?.[1] || null;
}
export async function resolveYouTubeChannel(input) {
  const text = String(input).trim();
  const direct = cleanChannelId(text);
  if (direct) return direct;
  // Handle and custom URLs are resolved from the public channel page when possible.
  let url;
  try { url = new URL(text.startsWith('@') ? `https://www.youtube.com/${text}` : text); }
  catch { throw new Error('Enter a YouTube channel URL or its UC… channel ID.'); }
  if (!/(^|\.)youtube\.com$/i.test(url.hostname)) throw new Error('Please provide a youtube.com channel URL.');
  const response = await fetch(url.href, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TanwishLoveBot/1.0)' }, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error('Could not open that YouTube channel page. Try its UC… channel ID instead.');
  const html = await response.text();
  const match = html.match(/"channelId"\s*:\s*"(UC[a-zA-Z0-9_-]{20,})"/) || html.match(/itemprop="channelId"\s+content="(UC[a-zA-Z0-9_-]{20,})"/);
  if (!match) throw new Error('Could not resolve that channel URL. Please use the channel ID starting with UC.');
  return match[1];
}
function xmlDecode(s='') {
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'");
}
function parseFeed(xml) {
  const items = [];
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = match[1];
    const id = entry.match(/<yt:videoId>([\s\S]*?)<\/yt:videoId>/)?.[1]?.trim();
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim();
    const link = entry.match(/<link\s+rel="alternate"\s+href="([^"]+)"/i)?.[1] || (id ? `https://www.youtube.com/watch?v=${id}` : null);
    const author = entry.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/)?.[1]?.trim();
    const published = entry.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim();
    if (id && title) items.push({ id, title: xmlDecode(title), link: xmlDecode(link || ''), author: xmlDecode(author || 'YouTube'), published });
  }
  return items;
}
async function fetchFeed(channelId) {
  const response = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TanwishLoveBot/1.0)' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`YouTube RSS returned HTTP ${response.status}`);
  return parseFeed(await response.text());
}
export async function setDestination(guildId, channelId) {
  guildState(guildId).destinationChannelId = channelId;
  await saveState();
}
export async function addSubscription(guildId, channelId) {
  const g = guildState(guildId);
  if (g.subscriptions[channelId]) return { added: false, channelId };
  const entries = await fetchFeed(channelId);
  // Start from the current newest item to avoid flooding old videos on first add.
  g.subscriptions[channelId] = { channelId, lastVideoId: entries[0]?.id || null, channelTitle: entries[0]?.author || channelId, addedAt: new Date().toISOString() };
  await saveState();
  return { added: true, channelId, channelTitle: g.subscriptions[channelId].channelTitle };
}
export async function removeSubscription(guildId, channelId) {
  const g = guildState(guildId);
  const existed = Boolean(g.subscriptions[channelId]);
  delete g.subscriptions[channelId];
  await saveState();
  return existed;
}
export function listSubscriptions(guildId) {
  const g = guildState(guildId);
  return { destinationChannelId: g.destinationChannelId, subscriptions: Object.values(g.subscriptions) };
}
async function poll(client) {
  if (busy) return;
  busy = true;
  try {
    let changed = false;
    for (const [guildId, g] of Object.entries(state.guilds)) {
      if (!g.destinationChannelId || !Object.keys(g.subscriptions || {}).length) continue;
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      const channel = await guild.channels.fetch(g.destinationChannelId).catch(() => null);
      if (!channel?.isTextBased?.() || !channel.send) continue;
      for (const sub of Object.values(g.subscriptions)) {
        try {
          const entries = await fetchFeed(sub.channelId);
          if (!entries.length) continue;
          if (!sub.lastVideoId) { sub.lastVideoId = entries[0].id; changed = true; continue; }
          const newestFirst = entries.slice(0, 15);
          const oldIndex = newestFirst.findIndex((entry) => entry.id === sub.lastVideoId);
          const newEntries = (oldIndex >= 0 ? newestFirst.slice(0, oldIndex) : []).reverse();
          for (const entry of newEntries) {
            const embed = new EmbedBuilder().setColor(0xFF0000).setTitle(entry.title.slice(0, 256)).setURL(entry.link).setAuthor({ name: entry.author.slice(0, 256), url: `https://www.youtube.com/channel/${sub.channelId}` }).setDescription(`[Watch on YouTube](${entry.link})`).setTimestamp(entry.published ? new Date(entry.published) : new Date());
            await channel.send({ content: '📺 **New YouTube upload!**', embeds: [embed] });
          }
          if (sub.lastVideoId !== entries[0].id) { sub.lastVideoId = entries[0].id; changed = true; }
        } catch (error) { logger.warn('YouTube notifier feed check failed.', { guildId, channelId: sub.channelId, error: error.message }); }
      }
    }
    if (changed) await saveState();
  } catch (error) { logger.error('YouTube notifier polling failed.', { error: error.message }); }
  finally { busy = false; }
}
export async function startYouTubeNotifier(client) {
  if (timer) return;
  await loadState();
  timer = setInterval(() => poll(client), POLL_MS);
  timer.unref?.();
  logger.info(`YouTube notifier started (poll interval ${Math.round(POLL_MS / 1000)}s).`);
  // First poll after interval to avoid sending old items at startup.
}
