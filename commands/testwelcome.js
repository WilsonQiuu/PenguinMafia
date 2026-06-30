const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const {
    logCommandError
} = require('../utils/logging.js');
const {
    startOnboardingForMember
} = require('../utils/onboarding.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('testwelcome')
        .setDescription('Open a private welcome preview flow.'),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        try {
            const channel = await startOnboardingForMember(interaction.member, {
                isTest: true
            });

            await interaction.editReply(
                `✅ Welcome preview opened in ${channel}.`
            );
        } catch (error) {
            logCommandError(interaction, '/testwelcome', error);

            await interaction.editReply(
                `❌ **Welcome preview failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
