# Category permission modes + bot permission report

These changes are applied on top of the working V2 project.

## Command Permissions dashboard
- The category permissions screen lists the currently saved mode for every command category.
- The category dropdown also shows each category's current mode.
- When a category is selected, the embed shows its effective mode and a count of commands in each mode.
- A category shows `Mixed` when its commands use different modes and `Default` when none has a saved custom rule. `/lock` retains its existing default of Server admins.

## `!perms` and `/perms`
- Reports bot permissions available in the current server and channel.
- Marks common baseline permissions with a star and explains what each feature-specific permission is used for.
- Separates missing bot role/server permissions from permissions blocked by the current channel's overwrites.
- Does not require granting Administrator to run the report. Only grant optional permissions for features the server uses.

## Apply
Use this ZIP as a replacement for V3/V4, keeping your working V2 project backed up. It contains V2 plus these two additions. Restart the bot and test in a private server first.
