# QOTD and owner-only /lock bypass feature

This build includes three changes:

1. `/qotd setup`, `/qotd status`, and `/qotd post` for a daily family-friendly trivia question.
2. Command Permissions shows the current mode and the actual configured roles/users.
3. `/lock` is guarded so only IDs configured in `OWNER_IDS` can execute it. Optional `bypass_role` and `bypass_member` options receive explicit `SendMessages: true` channel overwrites while `@everyone` is denied.

## Configure bot owners

Set `OWNER_IDS` in the hosting environment (or local `.env`) to comma-separated Discord user IDs, without spaces being necessary:

```env
OWNER_IDS=123456789012345678,234567890123456789
```

Use your actual Discord user IDs. Do not put bot tokens or other secrets in this value. Restart the bot after changing it. The `isBotOwner()` helper reads this setting from `src/config/bot.js`.

Discord does not support a slash-command visibility allowlist based on a bot's `OWNER_IDS`. Therefore `/lock` may appear in the command picker, but the code rejects every invocation whose user ID is not in `OWNER_IDS` before performing any action. Do not remove that runtime guard.

## Use the lock bypass

- `/lock` — deny `SendMessages` to `@everyone`.
- `/lock bypass_role:@Role` — also explicitly allow that role to send messages.
- `/lock bypass_member:@Member` — also explicitly allow that member to send messages.
- Both options can be provided together.
- If the channel is already locked, running `/lock` with a bypass option updates/adds the exception; running it without options reports that it is already locked.

The bot needs **Manage Channels**. The selected role/member exceptions apply to the current channel only. `/unlock` remains a separate existing command and was not changed by this feature.

## Use QOTD

- `/qotd setup` — choose a text channel, winner role, and daily time in India Standard Time.
- `/qotd status` — view configuration.
- `/qotd post` — publish a fresh question immediately.

The bot needs Send Messages and Embed Links in the QOTD channel, plus Manage Roles; the winner role must be below the bot's highest role. Questions come from Open Trivia DB and are limited to easy/medium (difficulty 1–2/4) for an all-ages server. Used question keys and pending role expirations are stored in the existing guild config persistence.

Role expiry is persisted as a timestamp and checked by the scheduler, which normally removes expired roles within about a minute after the 24-hour mark; Discord/API delays can affect exact timing. Questions are fetched from an external API, so a temporary source outage can prevent a scheduled post.

## Safe test steps

1. Keep a backup of your original project.
2. Run `node --check` on the modified files.
3. Set `OWNER_IDS` and test `/lock` in a private test server. Verify a non-owner is denied and that a selected role/member can still send messages while everyone else cannot.
4. Configure QOTD in the test server and verify posting, winner role assignment, and expiration.
5. Deploy to your live host only after the test succeeds.
