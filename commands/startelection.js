const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    startElection
} = require('../utils/elections.js');
const {
    isDon
} = require('../utils/staff.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('startelection')
        .setDescription('Start a 24-hour Penguin Mafia DON election. Owner only.'),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        if (!isDon(interaction.user.id)) {
            await interaction.editReply('❌ Only the owner can start an election.');
            return;
        }

        try {
            const election = await startElection(interaction.guild, interaction.user.id, sql);
            const endsAt = Math.floor(new Date(election.ends_at).getTime() / 1000);

            await interaction.editReply(
                `✅ **Election ${election.restarted ? 'restarted' : 'started'}!**\n\n` +
                `${election.restarted ? 'The old active election was cancelled and all votes have been reset.\n\n' : ''}` +
                `The colony has been pinged, the ballot box is open, and voting ends <t:${endsAt}:R>.`
            );
        } catch (error) {
            logCommandError(interaction, '/startelection', error);
            await interaction.editReply(
                `❌ **Could not start election.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
