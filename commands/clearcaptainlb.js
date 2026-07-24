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
            await sql`
                update players
                set reached_captain_at = null
                where reached_captain_at is not null
            `;

            await updateCaptainSpeedLeaderboardForGuild(interaction.guild, sql).catch(() => {});

            await interaction.editReply('✅ Captain speed leaderboard has been cleared for everyone.');
        } catch (error) {
            logCommandError(interaction, '/clearcaptainlb', error);

            await interaction.editReply(
                `❌ **Clear failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
