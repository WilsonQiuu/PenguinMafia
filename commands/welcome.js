const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const {
    logCommandError
} = require('../utils/logging.js');
const {
    deliverOnboardingForMember
} = require('../utils/onboarding.js');
const {
    isDon
} = require('../utils/staff.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('welcome')
        .setDescription('Resend the welcome tutorial in DMs.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('Player to resend the tutorial to (Don only)')
                .setRequired(false)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const targetUser = interaction.options.getUser('player') || interaction.user;

        if (targetUser.id !== interaction.user.id && !isDon(interaction.user.id)) {
            await interaction.editReply('❌ Only the Don can resend another player’s welcome tutorial.');
            return;
        }

        try {
            const member = targetUser.id === interaction.user.id
                ? interaction.member
                : await interaction.guild.members.fetch(targetUser.id);
            const delivery = await deliverOnboardingForMember(member, {
                refresh: true
            });

            if (!delivery.delivered) {
                const detail = delivery.dmBlocked
                    ? `${targetUser} must enable **Direct Messages** in this server’s Privacy Settings, then run \`/welcome\` again.`
                    : `Discord returned: \`${delivery.error?.message || 'Unknown delivery error'}\``;

                await interaction.editReply(
                    `❌ **Welcome DM could not be delivered.**\n\n${detail}`
                );
                return;
            }

            await interaction.editReply(
                `✅ A fresh welcome tutorial was sent to ${targetUser} in ${delivery.channel}.`
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
