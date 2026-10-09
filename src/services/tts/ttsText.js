// Turns a Discord message into something that sounds sensible when read aloud.

export const MAX_SPOKEN_CHARS = 300;

const COMMON_EXPRESSIONS = new Set(['lmao', 'lol', 'rofl', 'omg', 'wtf', 'brb', 'afk', 'smh', 'gg']);

export function prepareMessageText(message) {
    let text = message.content || '';

    // Short chat expressions are read without the "<name> said," prefix.
    const isExpression = COMMON_EXPRESSIONS.has(text.trim().toLowerCase());

    text = text.replace(/https?:\/\/\S+/gi, 'a link');

    for (const user of message.mentions.users.values()) {
        const member = message.guild?.members.cache.get(user.id);
        const name = member?.displayName || user.username;
        text = text.replaceAll(`<@${user.id}>`, `at ${name}`).replaceAll(`<@!${user.id}>`, `at ${name}`);
    }
    for (const role of message.mentions.roles.values()) {
        text = text.replaceAll(`<@&${role.id}>`, `at ${role.name}`);
    }
    for (const channel of message.mentions.channels.values()) {
        text = text.replaceAll(`<#${channel.id}>`, channel.name);
    }

    // Custom emoji: <:name:id> / <a:name:id> -> "emoji name"
    text = text.replace(/<a?:(\w+):\d+>/g, 'emoji $1');
    // Anything that is still a raw mention (users not in cache, @everyone, ...)
    text = text.replace(/<[@#][!&]?\d+>/g, '').replace(/@(everyone|here)/g, 'at $1');

    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > MAX_SPOKEN_CHARS) text = `${text.slice(0, MAX_SPOKEN_CHARS)}...`;

    // Nothing pronounceable (only symbols / emoji)? Skip it.
    if (!/[\p{L}\p{N}]/u.test(text)) return null;

    return { text, isExpression };
}

/** Google TTS accepts roughly 200 characters per request, so split on sentences, then words. */
export function splitTextIntoChunks(text, maxLength = 200) {
    const chunks = [];
    let current = '';
    const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];

    for (let sentence of sentences) {
        sentence = sentence.trim();
        if (!sentence) continue;

        if (sentence.length > maxLength) {
            if (current) {
                chunks.push(current);
                current = '';
            }
            while (sentence.length > maxLength) {
                let splitAt = sentence.lastIndexOf(' ', maxLength);
                if (splitAt <= 0) splitAt = maxLength;
                chunks.push(sentence.slice(0, splitAt).trim());
                sentence = sentence.slice(splitAt).trim();
            }
            current = sentence;
        } else if ((current ? `${current} ${sentence}` : sentence).length <= maxLength) {
            current = current ? `${current} ${sentence}` : sentence;
        } else {
            if (current) chunks.push(current);
            current = sentence;
        }
    }

    if (current) chunks.push(current);
    return chunks;
}
