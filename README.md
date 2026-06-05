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
- `/commissions`
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
- `/link`
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

