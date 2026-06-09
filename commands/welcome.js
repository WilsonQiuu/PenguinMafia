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
        .setName('welcome')
        .setDescription('Open a private test welcome flow.'),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        try {
            const channel = await startOnboardingForMember(interaction.member, {
                isTest: true
            });

            await interaction.editReply(
                `✅ Test welcome flow opened in ${channel}.\n\n` +
                `This is test mode, so finishing it will not give you the Penguin Soldier role or change your welcome data.`
            );
        } catch (error) {
            logCommandError(interaction, '/welcome', error);

            await interaction.editReply(
                `❌ **Welcome test failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
