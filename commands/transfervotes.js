const {
    MessageFlags,
    SlashCommandBuilder
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    transferReceivedElectionVotes
} = require('../utils/elections.js');

function buildCommand(name) {
    return new SlashCommandBuilder()
        .setName(name)
        .setDescription('Transfer votes you received before the final 12 election hours.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The penguin receiving the votes cast for you')
                .setRequired(true)
        );
}

async function execute(interaction) {
    await interaction.deferReply({
        flags: MessageFlags.Ephemeral
    });

    const targetUser = interaction.options.getUser('player');

    if (targetUser.bot) {
        await interaction.editReply('❌ Bots cannot receive election votes.');
        return;
    }

    try {
        const result = await transferReceivedElectionVotes(interaction.guild, interaction.user, targetUser, sql);

        await interaction.editReply(
            `🔁 **Votes transferred!**\n\n` +
            `The votes cast for you were moved to ${targetUser}.\n\n` +
            `Transferred: **${result.totalWeight}** vote${result.totalWeight === 1 ? '' : 's'} from **${result.voterCount}** voter${result.voterCount === 1 ? '' : 's'}.`
        );
    } catch (error) {
        logCommandError(interaction, `/${interaction.commandName}`, error);
        await interaction.editReply(
            `❌ **Vote transfer failed.**\n\n` +
            `Error:\n\`\`\`\n${error.message}\n\`\`\``
        );
    }
}

module.exports = {
    data: buildCommand('transfervotes'),
    execute,
    buildCommand,
    executeTransferVotes: execute
};
