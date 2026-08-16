const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const {
    logCommandError
} = require('../utils/logging.js');
const {
    startTestOnboardingInDm
} = require('../utils/onboarding.js');
const {
    isDon
} = require('../utils/staff.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('welcome')
        .setDescription('Open a test welcome flow in your DMs. Don only.'),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        if (!isDon(interaction.user.id)) {
            await interaction.editReply('❌ Only the Don can use `/welcome` to preview the flow.');
            return;
        }

        try {
            const channel = await startTestOnboardingInDm(interaction.user);

            await interaction.editReply(
                `✅ **Test welcome flow opened** in ${channel}.\n\n` +
                `Finish the flow and the bot cleans the DM up automatically. ` +
                `If anything is left behind, tap **✕** on any message to remove it.`
            );
        } catch (error) {
            logCommandError(interaction, '/welcome', error);

            await interaction.editReply(
                `❌ **Welcome failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
