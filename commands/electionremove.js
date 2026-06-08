const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    removePlayerFromActiveElection
} = require('../utils/elections.js');

function isDon(userId) {
    return process.env.DON_DISCORD_ID && userId === process.env.DON_DISCORD_ID;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('electionremove')
        .setDescription('Leave the election, or remove another player if you are the Don.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('Player to remove from the election. Don only for other players.')
                .setRequired(false)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const playerUser = interaction.options.getUser('player') || interaction.user;

        if (playerUser.id !== interaction.user.id && !isDon(interaction.user.id)) {
            await interaction.editReply('❌ You can only remove yourself from the election. Only the Don can remove another player.');
            return;
        }

        try {
            await removePlayerFromActiveElection(interaction.guild, playerUser.id, interaction.user.id, sql);

            await interaction.editReply(
                `✅ **Election updated.**\n\n` +
                `${playerUser} has left the candidate ice. Votes for them were removed, and the leaderboard refreshed silently.`
            );
        } catch (error) {
            logCommandError(interaction, '/electionremove', error);
            await interaction.editReply(
                `❌ **Election remove failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
