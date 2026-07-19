const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    getVotesForPlayer
} = require('../utils/elections.js');
const {
    isDon
} = require('../utils/staff.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('electionvotes')
        .setDescription('Check anonymous vote totals for a player in the active election.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player to inspect')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        if (!isDon(interaction.user.id)) {
            await interaction.editReply('❌ Only the Don can inspect election vote receipts.');
            return;
        }

        const playerUser = interaction.options.getUser('player');

        try {
            const result = await getVotesForPlayer(playerUser.id, sql);
            const voteLine = result.voterCount > 0
                ? `Anonymous voters: **${result.voterCount}**`
                : 'No anonymous votes are on this player yet.';

            await interaction.editReply(
                `# 🧾 Anonymous Votes For ${playerUser.username}\n\n` +
                `Total: **${result.total}** vote${result.total === 1 ? '' : 's'}\n\n` +
                `${voteLine}`
            );
        } catch (error) {
            logCommandError(interaction, '/electionvotes', error);
            await interaction.editReply(
                `❌ **Vote inspection failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
