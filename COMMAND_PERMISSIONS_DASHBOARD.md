# Command permissions dashboard

This feature extends the existing Discord-native `/commands dashboard` and stores settings in the bot's existing guild configuration storage (PostgreSQL in this project). It does not require separate website hosting or a Railway-only service, so it can also run on a self-managed Oracle Cloud VM.

## Deploy

1. Back up the repository and database before deploying.
2. Upload/merge the changed source files to your GitHub repository.
3. Deploy/restart the bot so it re-registers the updated `/commands` slash-command definition.
4. Ensure the bot's existing PostgreSQL configuration is available on the host. Do not commit `.env` or secrets.

## Using the dashboard (no typing needed)

1. Run `/commands dashboard`.
2. Pick a category, then press **Who can use these commands**.
3. Pick a command from the first dropdown, then choose **Everyone**, **Server administrators only**, or **Specific roles / users**. For the last option, two extra pickers appear for roles and users.
4. **Allow everyone** removes the restriction. Changes apply immediately.
5. On the first screen, **Who can open this dashboard** controls who may use the dashboard itself.

Only members with Manage Server (and the server owner / bot owner) can change these settings.

## Usage (typed commands, still available)

- `/commands dashboard` — open the existing interactive command/category enable-disable dashboard.
- `/commands permission command:<command> mode:<everyone|admins|roles|users> [role] [user]` — set who may use a command. Choose `roles` and one role, or `users` and one user. Repeat to add more roles/users. Choose `everyone` or `admins` to replace the allow-list.
- `/commands dashboard-access mode:<admins|everyone|roles|users> [role] [user]` — configure who may open the dashboard. Repeat with the same mode to add more roles/users. Only the server owner, users with Manage Server/Administrator, and configured bot owner can change this policy.

## Important permission behavior

- New servers default to dashboard access for server administrators (`Manage Server`) and the configured bot owner.
- The server owner, server administrators, and configured bot owner retain access to the dashboard.
- A custom command rule is an additional access gate. It does not remove a command's built-in/native permission requirements or its own safety checks. For example, allowing a role to use a moderation command does not bypass the command's native moderation permission checks.
- Protected recovery commands (`/commands` and `/configwizard`) cannot be assigned a custom command rule.
- Custom access rules apply to both slash commands and prefix commands when that command supports prefix execution.

## Oracle Cloud notes

Use the same supported Node.js version (22.12+), environment variables, and database connection on Oracle as on Railway. Keep `OWNER_IDS` and database credentials in the server's environment or a protected `.env` file outside Git. Make a PostgreSQL backup before migrating hosts.

## Hosting without PostgreSQL (e.g. bot-hosting.com)

If no `POSTGRES_URL`, `DATABASE_URL` or `POSTGRES_HOST` is set, the bot automatically stores its data in `data/bot-data.json` (and the YouTube notifier in `data/youtube-notifier.json`).

- Keep the `data/` folder when you update the bot. Do not delete or overwrite it; it holds all your settings.
- It is excluded from Git on purpose, so uploads from GitHub never replace it.
- Optional environment variables: `DATA_DIR` (change the folder) and `DATABASE_MODE=memory` (turn saving off).
- A copy of the previous save is kept as `bot-data.json.bak`.
