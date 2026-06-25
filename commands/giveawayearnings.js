const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    formatCents
} = require('../utils/donations.js');
const {
    logCommandError
} = require('../utils/logging.js');

function playerName(player, fallback = 'Unknown Player') {
    return player.discord_display_name ||
        player.discord_username ||
        fallback;
}

function minecraftAccountLine(player) {
    if (!player.minecraft_ign) {
        return 'Minecraft account: `Not linked`';
    }

    const edition = player.minecraft_edition === 'bedrock'
        ? 'Bedrock'
        : player.minecraft_edition === 'java'
            ? 'Java'
            : 'Edition not set';
    const ign = player.minecraft_edition === 'bedrock' && !player.minecraft_ign.startsWith('.')
        ? `.${player.minecraft_ign}`
        : player.minecraft_ign;

    return `Minecraft account: \`${ign}\` (${edition})`;
}

function countLine(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('giveawayearnings')
        .setDescription('Check total money earned from giveaway wins and giveaway commissions.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player to check. Don only for other players.')
                .setRequired(false)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const donDiscordId = process.env.DON_DISCORD_ID;
        const requestedUser = interaction.options.getUser('player') || interaction.user;

        if (
            requestedUser.id !== interaction.user.id &&
            (!donDiscordId || interaction.user.id !== donDiscordId)
        ) {
            await interaction.editReply(
                '❌ Only the Don can check another player’s giveaway earnings.'
            );
            return;
        }

        try {
            const playerRows = await sql`
                select
                    discord_id,
                    discord_username,
                    discord_display_name,
                    minecraft_ign,
                    minecraft_edition
                from players
                where discord_id = ${requestedUser.id}
                limit 1
            `;

            if (playerRows.length === 0) {
                await interaction.editReply(
                    `${requestedUser} is not in the database yet.`
                );
                return;
            }

            const player = playerRows[0];
            const rows = await sql`
                select
                    coalesce(sum(amount_cents) filter (where is_winner = true), 0)::text as direct_cents,
                    coalesce(sum(amount_cents) filter (where is_winner = false), 0)::text as commission_cents,
                    coalesce(sum(amount_cents), 0)::text as total_cents,
                    count(*) filter (where is_winner = true)::int as direct_payouts,
                    count(*) filter (where is_winner = false)::int as commission_payouts,
                    count(*)::int as total_payouts
                from giveaway_payout_jobs
                where guild_id = ${interaction.guild.id}
                    and recipient_discord_id = ${requestedUser.id}
                    and status in ('paid', 'credited')
            `;
            const earnings = rows[0] || {};

            await interaction.editReply(
                `🎁 **Giveaway Earnings**\n\n` +
                `Player: **${playerName(player, requestedUser.username)}**\n` +
                `${minecraftAccountLine(player)}\n\n` +
                `Direct giveaway wins: **${formatCents(earnings.direct_cents || 0)}** ` +
                `(${countLine(earnings.direct_payouts || 0, 'payout')})\n` +
                `Giveaway commissions: **${formatCents(earnings.commission_cents || 0)}** ` +
                `(${countLine(earnings.commission_payouts || 0, 'payout')})\n` +
                `Total giveaway earnings: **${formatCents(earnings.total_cents || 0)}** ` +
                `(${countLine(earnings.total_payouts || 0, 'payout')})\n\n` +
                `Includes completed giveaway payouts that were either paid in Minecraft or credited to unpaid commissions.`
            );
        } catch (error) {
            logCommandError(interaction, '/giveawayearnings', error);

            await interaction.editReply(
                `❌ **Giveaway earnings command failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
