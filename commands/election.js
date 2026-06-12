const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    ELECTION_LEADERBOARD_CHANNEL_ID,
    getActiveElection,
    getElectionScores
} = require('../utils/elections.js');

function medal(index) {
    return ['🥇', '🥈', '🥉'][index] || `**${index + 1}.**`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('election')
        .setDescription('Check the current Penguin Mafia DON election.'),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        try {
            const election = await getActiveElection(sql);

            if (!election) {
                await interaction.editReply('🐧 No active election right now. The ballot box is napping.');
                return;
            }

            const scores = await getElectionScores(election.id, sql);
            const endsAt = Math.floor(new Date(election.ends_at).getTime() / 1000);
            const topLines = scores.length > 0
                ? scores.slice(0, 10).map((player, index) => {
                    return `${medal(index)} <@${player.discord_id}> - **${player.votes}** vote${player.votes === 1 ? '' : 's'}`;
                }).join('\n')
                : 'No votes yet. The first splash is still waiting.';

            await interaction.editReply(
                `# 🗳️ Penguin Mafia DON Election\n\n` +
                `Voting ends <t:${endsAt}:R>.\n` +
                `Leaderboard: <#${ELECTION_LEADERBOARD_CHANNEL_ID}>\n\n` +
                `Use \`/vote player:@Player\` to cast your vote.\n` +
                `Use \`/transfervotes player:@Player\` to transfer votes cast for you.\n\n` +
                `## Top Penguins\n${topLines}`
            );
        } catch (error) {
            logCommandError(interaction, '/election', error);
            await interaction.editReply(
                `❌ **Election check failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
