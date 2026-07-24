const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    formatCents
} = require('../utils/donations.js');
const {
    isDon
} = require('../utils/staff.js');

function playerName(player, fallback = 'Unknown Player') {
    return player.minecraft_ign ||
        player.discord_display_name ||
        player.discord_username ||
        fallback;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('clearcommission')
        .setDescription('Clear a player’s unpaid commissions. Owner only.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player whose unpaid commissions should be cleared')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const donDiscordId = process.env.DON_DISCORD_ID;

        if (!donDiscordId) {
            await interaction.editReply(
                '❌ DON_DISCORD_ID is missing from your `.env` file.'
            );
            return;
        }

        if (!isDon(interaction.user.id)) {
            await interaction.editReply(
                '❌ Only the owner can use `/clearcommission`.'
            );
            return;
        }

        const playerUser = interaction.options.getUser('player');

        if (playerUser.bot) {
            await interaction.editReply(
                '❌ You cannot clear commissions for a bot.'
            );
            return;
        }

        try {
            const rows = await sql`
                with old_balance as (
                    select
                        discord_id,
                        unpaid_commissions
                    from players
                    where discord_id = ${playerUser.id}
                    limit 1
                )
                update players player
                set
                    unpaid_commissions = 0,
                    updated_at = now()
                from old_balance
                where player.discord_id = old_balance.discord_id
                returning
                    player.discord_id,
                    player.discord_username,
                    player.discord_display_name,
                    player.minecraft_ign,
                    player.unpaid_commissions as new_unpaid_commissions,
                    old_balance.unpaid_commissions as cleared_commissions
            `;

            if (rows.length === 0) {
                await interaction.editReply(
                    `❌ ${playerUser} is not in the database yet.`
                );
                return;
            }

            const player = rows[0];

            await interaction.editReply(
                `✅ **Unpaid commissions cleared.**\n\n` +
                `Player: **${playerName(player, playerUser.username)}**\n` +
                `Cleared amount: **${formatCents(player.cleared_commissions)}**\n` +
                `New unpaid commissions: **${formatCents(player.new_unpaid_commissions)}**`
            );
        } catch (error) {
            logCommandError(interaction, '/clearcommission', error);

            await interaction.editReply(
                `❌ **Clear commission failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
