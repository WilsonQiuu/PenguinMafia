const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    rejoinActiveElection
} = require('../utils/elections.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('electionjoin')
        .setDescription('Rejoin the active election as a candidate. Lost votes are not restored.'),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        try {
            await rejoinActiveElection(interaction.guild, interaction.user.id, sql);

            await interaction.editReply(
                `✅ **You are back in the election!**\n\n` +
                `Penguins can vote for you again, but any votes you lost when you left are gone. Fresh campaign, fresh snow.`
            );
        } catch (error) {
            logCommandError(interaction, '/electionjoin', error);
            await interaction.editReply(
                `❌ **Could not rejoin election.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
