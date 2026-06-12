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
        .setName('vote')
        .setDescription('Vote for the next Penguin Mafia DON.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The penguin receiving all of your votes')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const targetUser = interaction.options.getUser('player');

        if (targetUser.bot) {
            await interaction.editReply('❌ Bots cannot become the next Don. The ice council refuses.');
            return;
        }

        try {
            const result = await castElectionVote(interaction.guild, interaction.user, targetUser, sql);

            await interaction.editReply(
                `✅ **Vote locked in!**\n\n` +
                `You sent **${result.weight}** vote${result.weight === 1 ? '' : 's'} to ${targetUser} because you are **${result.rankName}**.\n\n` +
                `You can change your own vote any time with \`/vote\`.`
            );
        } catch (error) {
            logCommandError(interaction, '/vote', error);
            await interaction.editReply(
                `❌ **Vote failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
