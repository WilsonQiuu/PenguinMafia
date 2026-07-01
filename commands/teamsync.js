const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    syncAllTeamRoles
} = require('../utils/teams.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('teamsync')
        .setDescription('Re-sync all Discord team roles from the database. Don only.'),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        if (!process.env.DON_DISCORD_ID || interaction.user.id !== process.env.DON_DISCORD_ID) {
            await interaction.editReply('❌ Only the Don can use `/teamsync`.');
            return;
        }

        try {
            const result = await syncAllTeamRoles(interaction.guild, sql);

            await interaction.editReply(
                `✅ **Team roles synced.**\n\n` +
                `Members checked: **${result.checked}**\n` +
                `Roles added: **${result.added}**\n` +
                `Roles removed: **${result.removed}**\n` +
                `Failures: **${result.failed}**\n\n` +
                `The weekly team leaderboard was refreshed too.`
            );
        } catch (error) {
            logCommandError(interaction, '/teamsync', error);

            await interaction.editReply(
                `❌ **Team sync failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
