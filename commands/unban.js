const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const {
    logCommandError
} = require('../utils/logging.js');

function parseDiscordId(input) {
    const match = input.trim().match(/^(?:<@!?)?(\d{17,20})>?$/);
    return match ? match[1] : null;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unban')
        .setDescription('Unban a user from Discord only. Don only.')
        .addStringOption(option =>
            option
                .setName('player')
                .setDescription('The player mention or Discord ID to unban')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const donDiscordId = process.env.DON_DISCORD_ID;

        if (!donDiscordId) {
            await interaction.editReply(
                '❌ DON_DISCORD_ID is missing from your `.env` file.'
            );
            return;
        }

        if (interaction.user.id !== donDiscordId) {
            await interaction.editReply(
                '❌ Only the Don can use this command.'
            );
            return;
        }

        const playerInput = interaction.options.getString('player');
        const playerDiscordId = parseDiscordId(playerInput);

        if (!playerDiscordId) {
            await interaction.editReply(
                '❌ Please provide a valid player mention or Discord ID.'
            );
            return;
        }

        try {
            await interaction.guild.bans.remove(
                playerDiscordId,
                `Penguin Mafia Discord unban requested by ${interaction.user.tag || interaction.user.username}`
            );

            await interaction.editReply(
                `✅ **Discord unban complete.**\n\n` +
                `User ID: \`${playerDiscordId}\`\n\n` +
                `No database data was restored.`
            );
        } catch (error) {
            logCommandError(interaction, '/unban', error);

            await interaction.editReply(
                `❌ **Unban command failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
