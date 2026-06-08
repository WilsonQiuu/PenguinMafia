const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    getVotesForPlayer,
    playerName
} = require('../utils/elections.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('electionvotes')
        .setDescription('Check who voted for a player in the active election.')
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

        if (!process.env.DON_DISCORD_ID || interaction.user.id !== process.env.DON_DISCORD_ID) {
            await interaction.editReply('❌ Only the Don can inspect election vote receipts.');
            return;
        }

        const playerUser = interaction.options.getUser('player');

        try {
            const result = await getVotesForPlayer(playerUser.id, sql);
            const voterLines = result.voters.length > 0
                ? result.voters.slice(0, 25).map(voter => {
                    return `- **${playerName(voter, voter.discord_id)}** <@${voter.discord_id}>: **${voter.votes}** vote${voter.votes === 1 ? '' : 's'} (${voter.rank_name})`;
                }).join('\n')
                : 'No penguins are voting for this player yet.';

            await interaction.editReply(
                `# 🧾 Votes For ${playerUser.username}\n\n` +
                `Total: **${result.total}** vote${result.total === 1 ? '' : 's'}\n\n` +
                `${voterLines}`
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
