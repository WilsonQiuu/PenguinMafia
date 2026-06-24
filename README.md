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
BOT_USER=Ash_L567

# Optional. Leave unset to auto-detect the server version.
MINECRAFT_VERSION=1.21.4

# Optional payment confirmation settings.
MINECRAFT_PAYMENT_TIMEOUT_MS=30000
MINECRAFT_BALANCE_TIMEOUT_MS=30000
MINECRAFT_PAYMENT_SPACING_MS=3000
MINECRAFT_PAYOUT_CONNECT_TIMEOUT_MS=120000
GIVEAWAY_ANNOUNCEMENT_CHANNEL_ID=1498442322638147604

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
reconnect
quit
```

Example payment:

```text
pay PenguinPlayer 100m
```

This sends `/pay PenguinPlayer 100m` to Minecraft chat. The Don can also control the same client from Discord with `/bot start`, `/bot bal`, `/bot pay`, `/bot msg`, `/bot home`, and `/bot quit`. Discord `/bot pay` accepts either a linked Discord user or a typed Minecraft username; linked Bedrock accounts are paid with the leading `.` automatically. `/bot bal` sends `/bal` and waits for the server balance response. `/bot home` sends `/home 1` in Minecraft. Run the Discord bot with `npm run start`; do not run the standalone `npm run minecraft` process at the same time.

After sending a payment, the bot waits up to 30 seconds for the server's chat response. It reports the payment as completed only when a success response mentions the player, reports a known failure response, or warns that confirmation timed out. Only one payment can wait for confirmation at a time. Server messages are logged with timestamps and their raw packet contents for troubleshooting.

Giveaways are funded by player payments to `BOT_USER`. When a player runs `/giveaway amount duration`, the bot requires at least `1m`, checks that their Minecraft account is linked, tells them to pay `/pay BOT_USER amount`, and adds the giveaway to one shared active-giveaways board only after it sees an incoming payment from that linked Java or Bedrock IGN for at least the requested amount. If the Don hosts a giveaway and the bot balance already covers the amount, the giveaway starts immediately without requiring a new payment. Each funded giveaway also pings the giveaway role in `GIVEAWAY_ANNOUNCEMENT_CHANNEL_ID`, and the active giveaway board has a button players can use to add the giveaway ping role. When a giveaway ends, the result posts immediately and the bot tries to pay the winner payout tree from Minecraft with at least 3 seconds between payment commands. If the Minecraft bot is offline, it attempts to connect first. Any giveaway payout that cannot be sent because the recipient is unlinked, missing an edition, invalid, or the payment fails is added to unpaid commissions for later `/payallcommissions`.

If your server uses unusual payment messages, you can optionally provide case-insensitive regular expressions in `.env`:

```env
MINECRAFT_PAYMENT_SUCCESS_PATTERN=paid|sent|payment complete
MINECRAFT_PAYMENT_FAILURE_PATTERN=insufficient funds|player not found|payment failed
MINECRAFT_BALANCE_COMMAND=/bal
MINECRAFT_BALANCE_PATTERN=balance[^0-9$]*\$?\s*([\d,]+(?:\.\d+)?\s*[kmbt]?)
```

When the Twilio account credentials, destination, and either a Messaging Service SID or sending number are present, the bot sends Microsoft’s one-click login link with the device code prefilled when a new login is required. It also alerts when the Minecraft client fails before successfully signing in, gets kicked, or disconnects unexpectedly after spawning. Planned stops from `/bot quit` and clean process-manager shutdowns such as Railway restarts do not send SMS alerts. Failed payments do not send alerts. Twilio trial accounts require the destination number to be verified in the Twilio Console.

On Discord startup, the bot creates or repairs a private `🤖-bot-logs` channel visible only to the configured Don and the Discord bot. It records Minecraft startup and shutdown events, unexpected disconnects, errors, payment results, private messages sent by the bot, and private messages received from Minecraft players.

After an unexpected disconnect, the Minecraft bot randomly waits between 5 and 15 minutes before reconnecting automatically. The chosen delay is shown in the private bot-log channel. The Don can use `/bot start` during that waiting period to reconnect immediately, or `/bot quit` to cancel automatic reconnecting.

On startup, the bot will:

- prepare the database schema
- create or update Penguin and Staff roles
- ensure managed channels for leaderboards, promotion events, and mod logs
- deploy slash commands
- sync members and onboarding state

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
- `/giveaway`
- `/commissions`
- `/payallcommissions`
- `/clearcommission`
- `/donationadd`
- `/donationssub`

Staff and moderation commands:

- `/staffpromote`
- `/staffdemote`
- `/verify`
- `/kick`
- `/ban`
- `/unban`
- `/remove`

Utility commands:

- `/setup`
- `/reset`
- `/penguinlink`
- `/welcome`
- `/recruit`
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
