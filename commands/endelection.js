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
const {
    isDon
} = require('../utils/staff.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('endelection')
        .setDescription('End the active Penguin Mafia DON election now. Owner only.'),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        if (!isDon(interaction.user.id)) {
            await interaction.editReply('❌ Only the owner can end the election.');
            return;
        }

        try {
            await endElection(interaction.guild, interaction.user.id, sql, 'ended');
            await interaction.editReply('✅ **Election ended.** The winner message is now on the leaderboard ice.');
        } catch (error) {
            logCommandError(interaction, '/endelection', error);
            await interaction.editReply(
                `❌ **Could not end election.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
