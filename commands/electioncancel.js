const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    endElection
} = require('../utils/elections.js');

function isDon(userId) {
    return process.env.DON_DISCORD_ID && userId === process.env.DON_DISCORD_ID;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('electioncancel')
        .setDescription('Cancel the active election and return the board to starting-soon mode. Don only.'),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        if (!isDon(interaction.user.id)) {
            await interaction.editReply('❌ Only the Don can cancel the election.');
            return;
        }

        try {
            await endElection(interaction.guild, interaction.user.id, sql, 'cancelled');
            await interaction.editReply('✅ **Election cancelled.** The board now shows the cancelled election message.');
        } catch (error) {
            logCommandError(interaction, '/electioncancel', error);
            await interaction.editReply(
                `❌ **Could not cancel election.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
