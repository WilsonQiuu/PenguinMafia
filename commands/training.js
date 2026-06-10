const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const {
    logCommandError
} = require('../utils/logging.js');
const {
    TRAINER_ROLE_NAME,
    ensureTrainerRole
} = require('../utils/bootstrap.js');
const {
    startTrainerTrainingForMember
} = require('../utils/trainerOnboarding.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('training')
        .setDescription('Open the Penguin Mafia staged trainer training.'),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        try {
            const { trainerRole } = await ensureTrainerRole(interaction.guild);

            if (!interaction.member.roles.cache.has(trainerRole.id)) {
                await interaction.editReply(
                    `❌ Only **${TRAINER_ROLE_NAME}** members can use \`/training\`.`
                );
                return;
            }

            const channel = await startTrainerTrainingForMember(interaction.member);

            await interaction.editReply(
                `✅ Training opened in ${channel}.\n\n` +
                `Use \`/training\` anytime to come back to the trainer guide.`
            );
        } catch (error) {
            logCommandError(interaction, '/training', error);

            await interaction.editReply(
                `❌ **Training failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
