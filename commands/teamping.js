const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    fetchPlayerTeam,
    pingTeamRole
} = require('../utils/teams.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('teamping')
        .setDescription('Ping your team role in the team channel. 60s cooldown.'),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        try {
            const team = await fetchPlayerTeam(sql, interaction.user.id);

            if (!team) {
                await interaction.editReply('❌ You are not on a team.');
                return;
            }

            const result = await pingTeamRole(interaction.guild, team);

            if (result.sent) {
                await interaction.editReply(`✅ Pinged **${team.name}** in <#${team.channel_id}>.`);
            } else {
                await interaction.editReply(`❌ ${result.reason}`);
            }
        } catch (error) {
            logCommandError(interaction, '/teamping', error);

            await interaction.editReply(
                `❌ **Team ping failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
