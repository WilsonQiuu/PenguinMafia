const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    castElectionVote
} = require('../utils/elections.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('transfervotes')
        .setDescription('Move all of your election votes to another penguin.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The penguin receiving your vote power')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const targetUser = interaction.options.getUser('player');

        if (targetUser.bot) {
            await interaction.editReply('❌ Bots cannot receive election votes.');
            return;
        }

        try {
            const result = await castElectionVote(interaction.guild, interaction.user, targetUser, sql, {
                forceTransferMessage: true
            });

            await interaction.editReply(
                `🔁 **Votes transferred!**\n\n` +
                `Your **${result.weight}** vote${result.weight === 1 ? '' : 's'} now belong to ${targetUser}.\n\n` +
                `Rank power used: **${result.rankName}**.`
            );
        } catch (error) {
            logCommandError(interaction, '/transfervotes', error);
            await interaction.editReply(
                `❌ **Vote transfer failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
