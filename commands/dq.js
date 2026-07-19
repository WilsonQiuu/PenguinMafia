const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    updateCaptainSpeedLeaderboardForGuild
} = require('../utils/leaderboards.js');
const {
    isDon
} = require('../utils/staff.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('dq')
        .setDescription('Disqualify a player from the captain speed leaderboard. Don only.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player to disqualify')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        if (!isDon(interaction.user.id)) {
            await interaction.editReply('❌ Only the Don can use `/dq`.');
            return;
        }

        try {
            const target = interaction.options.getUser('player');
            const rows = await sql`
                select
                    captain_leaderboard_disqualified,
                    reached_captain_at
                from players
                where discord_id = ${target.id}
                limit 1
            `;

            const player = rows[0];

            if (!player) {
                await interaction.editReply('❌ That player is not in the database.');
                return;
            }

            if (!player.reached_captain_at) {
                await interaction.editReply('❌ That player has not reached Captain rank.');
                return;
            }

            const newStatus = !player.captain_leaderboard_disqualified;

            await sql`
                update players
                set
                    captain_leaderboard_disqualified = ${newStatus},
                    updated_at = now()
                where discord_id = ${target.id}
            `;

            await updateCaptainSpeedLeaderboardForGuild(interaction.guild, sql).catch(() => {});

            await interaction.editReply(
                newStatus
                    ? `✅ **${target.username}** has been disqualified from the captain speed leaderboard.`
                    : `✅ **${target.username}** has been re-qualified for the captain speed leaderboard.`
            );
        } catch (error) {
            logCommandError(interaction, '/dq', error);

            await interaction.editReply(
                `❌ **DQ failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
