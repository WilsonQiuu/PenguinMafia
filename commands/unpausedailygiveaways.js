const {
    MessageFlags,
    SlashCommandBuilder
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    setScheduledGiveawayPayoutsPaused
} = require('../utils/scheduledGiveawayPayouts.js');
const {
    isDon
} = require('../utils/staff.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unpausedailygiveaways')
        .setDescription('Resume future scheduled giveaway payouts. Owner only.'),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        if (!isDon(interaction.user.id)) {
            await interaction.editReply('❌ Only the owner can use `/unpausedailygiveaways`.');
            return;
        }

        try {
            await setScheduledGiveawayPayoutsPaused(false, sql);
            await interaction.editReply(
                '▶️ Scheduled daily, weekly, and monthly giveaway payouts are now **active**.\n\n' +
                'Only future scheduled winners will be paid. Past skipped winners will not be paid retroactively.'
            );
        } catch (error) {
            logCommandError(interaction, '/unpausedailygiveaways', error);
            await interaction.editReply(
                `❌ **Unpause daily giveaways failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
