# QOTD, dashboard-controlled `/lock`, and owner-only `/bypass lock`

This build includes:

1. `/qotd setup`, `/qotd status`, and `/qotd post` for daily family-friendly trivia.
2. Command Permissions displays the current mode and configured roles/users. `/lock` is explicitly included in the individual command selector even if the bot has more than 25 commands.
3. `/lock` is controlled by `/commands dashboard` → **Command Permissions** → **Moderation** (bulk category rule), or by selecting `/lock` in the individual command-permission selector. Its default is **Server administrators** until configured.
4. `/bypass lock channel user:@Member` or `/bypass lock channel role:@Role` is a separate command reserved for bot owners configured in `OWNER_IDS`.

## Configure bot owners

Set `OWNER_IDS` in the hosting environment (or local `.env`) to comma-separated Discord user IDs:

```env
OWNER_IDS=123456789012345678,234567890123456789
```

Use your actual Discord user IDs. Do not put bot tokens or other secrets in this value. Restart the bot after changing it. The `isBotOwner()` helper reads this setting from `src/config/bot.js`.

## Use `/lock` and configure access

- `/lock` — denies `SendMessages` to `@everyone` in the current channel.
- Open `/commands dashboard` → **Command Permissions** → choose **Moderation** to set a permission mode for commands in that category, including `/lock`.
- To configure `/lock` individually, use the individual command permission selector and choose `/lock`.
- Until configured, `/lock` defaults to **Server administrators**.
- Bot owners and server owners retain the existing bypass behavior in the permission system. The dashboard controls who else may use it.

The Discord command picker may still show `/lock` to members who are not allowed to execute it because this dashboard uses runtime permission checks; the bot will deny execution according to the configured mode. The bot needs **Manage Channels** in the channel being locked.

## Use owner-only lock bypass

- `/bypass lock channel:#channel user:@Member` — lets that member send messages in the selected locked channel.
- `/bypass lock channel:#channel role:@Role` — lets members with that role send messages in the selected locked channel.
- Choose exactly one of `user` or `role` for each invocation. The `@everyone` role cannot be selected.
- Only IDs listed in `OWNER_IDS` can use `/bypass`. This command is excluded from dashboard permission changes.
- The bypass adds an explicit `SendMessages: true` overwrite for the selected target in that channel. Remove that overwrite through the channel's permission settings to revoke the bypass.

`/unlock` remains a separate existing command and was not changed by this feature.

## Use QOTD

- `/qotd setup` — choose a text channel, winner role, and daily time in India Standard Time.
- `/qotd status` — view configuration.
- `/qotd post` — publish a fresh question immediately.

The bot needs Send Messages and Embed Links in the QOTD channel, plus Manage Roles; the winner role must be below the bot's highest role. Questions come from Open Trivia DB and are limited to easy/medium (difficulty 1–2/4). Used question keys and pending role expirations are stored in the existing guild config persistence.

Role expiry is persisted as a timestamp and checked by the scheduler, which normally removes expired roles within about a minute after the 24-hour mark; Discord/API delays can affect exact timing. Questions are fetched from an external API, so a temporary source outage can prevent a scheduled post.

## Safe test steps

1. Back up your project.
2. Set `OWNER_IDS` in the hosting environment.
3. Run the syntax checks listed in `README-INSTALL.md` if using the patch.
4. Test in a private Discord server: confirm `/lock` appears in the Moderation permission category and individual command selector; configure its access mode; verify a disallowed member is denied.
5. Test `/bypass lock` as a bot owner and confirm a selected user/role can send messages in the locked channel.
6. Test QOTD setup, posting, winner role assignment, and expiration.
7. Deploy to the live host only after testing. This patch does not deploy anything by itself.
