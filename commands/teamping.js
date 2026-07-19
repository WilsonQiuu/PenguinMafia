const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    fetchEffectiveTeamBucket,
    pingTeamRole
} = require('../utils/teams.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('teamping')
        .setDescription('Ping your team role in this channel. 60s cooldown.'),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        try {
            const team = await fetchEffectiveTeamBucket(sql, interaction.user.id, interaction.guild.id);

            if (!team) {
                await interaction.editReply('❌ You are not on a team.');
                return;
            }

            const result = await pingTeamRole(interaction.guild, team, interaction.channel);

            if (result.sent) {
                await interaction.editReply(`✅ Pinged **${team.name}** in this channel.`);
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
