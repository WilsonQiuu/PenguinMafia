const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    requestTeamCreation
} = require('../utils/teams.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('createteam')
        .setDescription('Request a private team for your recruit tree. Emperor Penguins only.')
        .addStringOption(option =>
            option
                .setName('name')
                .setDescription('Team name')
                .setRequired(true)
                .setMaxLength(50)
        )
        .addStringOption(option =>
            option
                .setName('color')
                .setDescription('Team role color as hex, like #7A5CFF')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        try {
            const playerRows = await sql`
                select rank_name
                from players
                where discord_id = ${interaction.user.id}
                limit 1
            `;
            const player = playerRows[0];

            if (!player) {
                await interaction.editReply('❌ You are not in the Penguin Mafia database yet.');
                return;
            }

            if (player.rank_name !== 'Emperor Penguin') {
                await interaction.editReply('❌ Only **Emperor Penguins** can use `/createteam`.');
                return;
            }

            const request = await requestTeamCreation(interaction, {
                name: interaction.options.getString('name'),
                color: interaction.options.getString('color')
            }, sql);

            await interaction.editReply(
                `✅ **Team request sent to the Don.**\n\n` +
                `Team: **${request.name}**\n` +
                `The team role, private team channel, and DB team assignment will be created if the Don approves it.`
            );
        } catch (error) {
            logCommandError(interaction, '/createteam', error);

            await interaction.editReply(
                `❌ **Team request failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
