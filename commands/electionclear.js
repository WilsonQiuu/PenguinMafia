const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    clearLatestFinishedElectionBoard
} = require('../utils/elections.js');

function isDon(userId) {
    return process.env.DON_DISCORD_ID && userId === process.env.DON_DISCORD_ID;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('electionclear')
        .setDescription('Clear the finished election board back to the starting-soon message. Don only.'),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        if (!isDon(interaction.user.id)) {
            await interaction.editReply('❌ Only the Don can clear the election board.');
            return;
        }

        try {
            await clearLatestFinishedElectionBoard(interaction.guild, sql);
            await interaction.editReply('✅ **Election board cleared.** The channel now shows the starting-soon election message.');
        } catch (error) {
            logCommandError(interaction, '/electionclear', error);
            await interaction.editReply(
                `❌ **Could not clear election board.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
