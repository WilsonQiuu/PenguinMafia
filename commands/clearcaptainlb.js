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
        .setName('clearcaptainlb')
        .setDescription('Reset the monthly captain speed leaderboard. Owner only.'),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        if (!isDon(interaction.user.id)) {
            await interaction.editReply('❌ Only the owner can use `/clearcaptainlb`.');
            return;
        }

        try {
            await sql.begin(async transaction => {
                await transaction`
                    update captain_speed_runs
                    set counts_for_monthly = false
                    where counts_for_monthly = true
                        and date_trunc('month', reached_captain_at at time zone 'UTC') =
                            date_trunc('month', now() at time zone 'UTC')
                `;

                await transaction`
                    update players
                    set reached_captain_at = null
                    where reached_captain_at is not null
                `;
            });

            await updateCaptainSpeedLeaderboardForGuild(interaction.guild, sql).catch(() => {});

            await interaction.editReply(
                '✅ This month’s Captain speed leaderboard has been cleared. All-time records were preserved.'
            );
        } catch (error) {
            logCommandError(interaction, '/clearcaptainlb', error);

            await interaction.editReply(
                `❌ **Clear failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
