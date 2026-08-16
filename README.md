# Penguin Mafia Bot

A Discord bot for managing the Penguin Mafia recruit tree, ranks, staff moderation, commissions, leaderboards, welcome onboarding, and promotion events.

## Features

- Penguin rank system with recruit-based promotions
- Staff rank system with ban points
- Welcome onboarding and Minecraft IGN linking
- Recruit trees with `/tree` and visual graphs with `/graph`
- Commission tracking and payout calculation
- Donation and weekly recruit leaderboards
- Promotion, donation, and first-recruit announcements
- Minecraft-style VC levels with voice-call time tracked to the second
- Moderation commands and structured mod logs
- PostgreSQL database storage

## Requirements

- Node.js 18 or newer
- npm
- A Discord bot application
- A PostgreSQL database, such as Supabase

## Setup

Install dependencies:

```bash
npm install
```

Create a `.env` file in the project root:

```env
CLIENT_ID=your_discord_application_id
GUILD_ID=your_discord_server_id
BOT_TOKEN=your_discord_bot_token

BOT_STATUS=online
ACTIVITY_TYPE=PLAYING
ACTIVITY_NAME=Discord

DON_DISCORD_ID=your_discord_user_id
WELCOME_CHANNEL_ID=your_welcome_channel_id

DATABASE_URL=your_postgres_connection_string
```

Never commit `.env`. This repo's `.gitignore` already excludes it.

## Running Locally

```bash
npm run start
```

## Minecraft Payment Bot

The Minecraft client uses Microsoft device-code authentication and can send simple chat commands, including `/pay`. It can run inside the Discord bot for `/bot` commands or as a standalone terminal process for testing.

Add these values to `.env`:

```env
MINECRAFT_HOST=play.example.net
MINECRAFT_PORT=25565
MINECRAFT_EMAIL=your_microsoft_account_email
MINECRAFT_AUTO_START=true
BOT_USER=Ash_L567

# Optional. Leave unset to auto-detect the server version.
MINECRAFT_VERSION=1.21.4

# Optional payment confirmation settings.
MINECRAFT_PAYMENT_TIMEOUT_MS=30000
MINECRAFT_BALANCE_TIMEOUT_MS=30000
MINECRAFT_PAYMENT_SPACING_MS=3000
MINECRAFT_PAYOUT_CONNECT_TIMEOUT_MS=120000
GIVEAWAY_ANNOUNCEMENT_CHANNEL_ID=1498442322638147604
GIVEAWAY_WINNER_CHANNEL_ID=1536602944605134958

# Optional Twilio sign-in alerts. Use E.164 phone numbers with a leading +.
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_MESSAGING_SERVICE_SID=MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
MINECRAFT_ALERT_TO=+15557654321

# Alternatively, use a Twilio phone number instead of a Messaging Service:
# TWILIO_FROM_NUMBER=+15551234567

# Optional. Defaults to 15 minutes to prevent repeated sign-in alerts.
MINECRAFT_ALERT_COOLDOWN_MS=900000

# Optional after the private channel is created. Name lookup works without it.
BOT_LOG_CHANNEL_ID=your_private_bot_log_channel_id
```

For standalone terminal testing, start it with:

```bash
npm run minecraft
```

On the first run, follow the Microsoft device-login instructions printed in the terminal. Authentication tokens are cached locally in `.minecraft-bot-auth/` and are excluded from Git.

Terminal commands:

```text
help
status
say <message>
msg <player> <message>
pay <player> <amount>
bal
cobble [start|stop|status]
unstuck
reconnect
quit
```

Example payment:

```text
pay PenguinPlayer 100m
```

This sends `/pay PenguinPlayer 100m` to Minecraft chat. The Don can also control the same client from Discord with `/bot start`, `/bot bal`, `/bot pay`, `/bot msg`, `/bot home`, `/bot cobble`, `/bot unstuck`, and `/bot quit`. Discord `/bot pay` accepts either a linked Discord user or a typed Minecraft username; linked Bedrock accounts are paid with the leading `.` automatically. `/bot bal` tries the configured balance command aliases, defaults to `/balance`, `/money`, then `/bal`, and waits for the server balance response. `/bot home` sends `/home 1` in Minecraft. `/bot cobble` starts cobble mode, which taps left/right/forward/back, looks straight up, holds sneak, holds use item, and repeatedly mines the block in the bot's crosshair until `/bot cobble action:stop`, `/bot quit`, death, or disconnect. `/bot unstuck` releases all held controls, stops cobble mode, enables physics, and reports the bot's current position and velocity. Run the Discord bot with `npm run start`; do not run the standalone `npm run minecraft` process at the same time.

After sending a payment, the bot waits up to 30 seconds for the server's chat response. It checks the bot balance before and after the payment, reports known failure responses quickly, and treats the payment as sent if the balance dropped even when chat confirmation failed. Payment and balance commands share one queue, so later payouts wait for the active payment confirmation instead of being failed immediately. Server messages are logged with timestamps and their raw packet contents for troubleshooting.

Don giveaways start immediately without checking any Minecraft bot balance. Other players use `/giveaway amount duration payment_host` and choose either `itsWSQ` or `rainbowbeltzz`, based on who is online and ready to receive payment. The selected host must accept the request before the sponsor receives the exact `/pay` instruction, then the host confirms receipt to start the giveaway. The sponsor receives donation credit, while the accepted payment host is responsible for payouts and receives copy-ready Minecraft `/pay` commands when the giveaway ends. New giveaway payouts are manual and are not queued for automatic payment. Giveaway flow messages include an X button so their recipient or the Don can remove them after they are no longer needed.

If your server uses unusual payment messages, you can optionally provide case-insensitive regular expressions in `.env`:

```env
MINECRAFT_PAYMENT_SUCCESS_PATTERN=paid|sent|payment complete
MINECRAFT_PAYMENT_FAILURE_PATTERN=insufficient funds|player not found|could not find|not online|does not exist|payment failed
MINECRAFT_BALANCE_COMMANDS=/balance,/money,/bal
MINECRAFT_BALANCE_COMMAND_TIMEOUT_MS=8000
MINECRAFT_BALANCE_PATTERN=balance[^0-9$]*\$?\s*([\d,]+(?:\.\d+)?\s*[kmbt]?)
```

When the Discord bot starts, it automatically starts the Minecraft client if `MINECRAFT_HOST` and `MINECRAFT_EMAIL` are configured. Set `MINECRAFT_AUTO_START=false` to disable this. That means a Railway process restart brings the Minecraft bot back online without needing `/bot start`.

When the Twilio account credentials, destination, and either a Messaging Service SID or sending number are present, the bot sends Microsoft’s one-click login link with the device code prefilled when a new login is required. It also alerts when the Minecraft client fails before successfully signing in, gets kicked, or disconnects unexpectedly after spawning. Planned stops from `/bot quit` and clean process-manager shutdowns such as Railway restarts do not send SMS alerts. Failed payments do not send alerts. Twilio trial accounts require the destination number to be verified in the Twilio Console.

On Discord startup, the bot creates or repairs a private `🤖-bot-logs` channel visible only to the configured Don and the Discord bot. It records Minecraft startup and shutdown events, unexpected disconnects, errors, payment results, private messages sent by the bot, and private messages received from Minecraft players.

After an unexpected disconnect, the Minecraft bot randomly waits between 5 and 15 minutes before reconnecting automatically. The chosen delay is shown in the private bot-log channel. The Don can use `/bot start` during that waiting period to reconnect immediately, or `/bot quit` to cancel automatic reconnecting.

On startup, the bot will:

- prepare the database schema
- create or update Penguin and Staff roles
- ensure managed channels for leaderboards, promotion events, and mod logs
- deploy slash commands
- skip full member/onboarding sync unless `FULL_STARTUP_SYNC=true`
- send incomplete-welcome reminders and clean stale welcome channels every Saturday at 12:00 PM Eastern Time

## Discord Bot Setup

In the Discord Developer Portal, enable these privileged gateway intents:

- Server Members Intent
- Message Content Intent

When inviting the bot, use these scopes:

- `bot`
- `applications.commands`

The bot needs permissions for roles, channels, moderation logs, nicknames, invites, and slash commands. Administrator is simplest for a private server; otherwise grant the specific permissions your server policy allows.

## Main Commands

Recruit and rank commands:

- `/join`
- `/recruits`
- `/tree`
- `/graph`
- `/info`
- `/eligible`
- `/promote`
- `/demote`
- `/give`
- `/removerecruiter`
- `/claimall`

Money and donation commands:

- `/pay`
- `/bot bal`
- `/donate`
- `/giveaway`
- `/aura`
- `/commissions`
- `/payoutnotifications`
- `/payallcommissions`
- `/clearcommission`
- `/donationadd`
- `/donationssub`

Staff and moderation commands:

- `/staffpromote`
- `/staffdemote`
- `/verify`
- `/vouche`
- `/unvouche`
- `/veto`
- `/unveto`
- `/kick`
- `/ban`
- `/bantree`
- `/unban`
- `/remove`

Utility commands:

- `/setup`
- `/vchours [player]`
- `/vclogging action:Enable|Disable|Status` (owner only)
- `/reset`
- `/penguinlink`
- `/welcome`
- `/recruit`
- `/vouches`
- `/ping`

## Hosting

For always-on hosting, use a VPS or any service that supports long-running Node.js apps.

Example with `pm2`:

```bash
npm install -g pm2
pm2 start index.js --name penguin-mafia
pm2 save
pm2 startup
```

After changing `.env` or updating code, restart the bot:

```bash
pm2 restart penguin-mafia
```

## Security Notes

- Reset your bot token immediately if it is ever shared or committed.
- Keep `.env` private.
- Use a database password that is not reused anywhere else.
- Give Don-only commands only to the Discord ID configured in `DON_DISCORD_ID`.

## Project Structure

```text
commands/        Slash command handlers
utils/           Shared bot logic
db.js            PostgreSQL connection
index.js         Bot startup, events, command deployment
package.json     Dependencies and npm scripts
```
