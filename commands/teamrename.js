const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    formatTeamColor,
    renameTeam
} = require('../utils/teams.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('teamrename')
        .setDescription('Rename your team and update its color.')
        .addStringOption(option =>
            option
                .setName('name')
                .setDescription('New team name')
                .setRequired(true)
                .setMaxLength(50)
        )
        .addStringOption(option =>
            option
                .setName('color')
                .setDescription('New team color name or hex, like yellow, red, purple, or #7A5CFF')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        try {
            const result = await renameTeam(
                interaction.guild,
                interaction.user.id,
                interaction.options.getString('name'),
                interaction.options.getString('color'),
                sql
            );
            const warningLine = result.syncFailures.length > 0
                ? `\n\n⚠️ Discord sync warning:\n${result.syncFailures.map(failure => `- ${failure}`).join('\n')}`
                : '';

            await interaction.editReply(
                `✅ **Team renamed.**\n\n` +
                `Team: **${result.team.name}**\n` +
                `Color: **${formatTeamColor(result.team.color)}**\n` +
                `Channel: ${result.team.channel_id ? `<#${result.team.channel_id}>` : 'not set'}${warningLine}`
            );
        } catch (error) {
            logCommandError(interaction, '/teamrename', error);

            await interaction.editReply(
                `❌ **Team rename failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
