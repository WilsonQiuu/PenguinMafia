const {
    MessageFlags,
    SlashCommandBuilder
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    scheduledGiveawayPayoutsPaused,
    skipQueuedScheduledGiveawayPayouts,
    setScheduledGiveawayPayoutsPaused
} = require('../utils/scheduledGiveawayPayouts.js');
const {
    isDon
} = require('../utils/staff.js');

function pausedLine(paused) {
    return paused
        ? '⏸️ Scheduled daily, weekly, and monthly giveaway payouts are currently **paused**.'
        : '▶️ Scheduled daily, weekly, and monthly giveaway payouts are currently **active**.';
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('pausedailygiveaways')
        .setDescription('Pause scheduled daily, weekly, and monthly giveaway payouts. Owner only.')
        .addStringOption(option =>
            option
                .setName('action')
                .setDescription('Pause, resume, or check scheduled giveaway payouts.')
                .setRequired(false)
                .addChoices(
                    {
                        name: 'Pause',
                        value: 'pause'
                    },
                    {
                        name: 'Resume',
                        value: 'resume'
                    },
                    {
                        name: 'Status',
                        value: 'status'
                    }
                )
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        if (!isDon(interaction.user.id)) {
            await interaction.editReply('❌ Only the owner can use `/pausedailygiveaways`.');
            return;
        }

        const action = interaction.options.getString('action') || 'pause';

        try {
            if (action === 'status') {
                const paused = await scheduledGiveawayPayoutsPaused(sql);
                await interaction.editReply(pausedLine(paused));
                return;
            }

            const paused = action === 'pause';
            const state = await setScheduledGiveawayPayoutsPaused(paused, sql);
            const skipped = paused
                ? await skipQueuedScheduledGiveawayPayouts(sql)
                : null;

            await interaction.editReply(
                paused
                    ? (
                        '⏸️ Scheduled daily, weekly, and monthly giveaway payouts are now **paused**.\n\n' +
                        'Skipped scheduled payouts will **not** be paid retroactively after resume.\n' +
                        `Queued daily payout jobs skipped: **${skipped.skippedHourlyJobs}**\n` +
                        `Monthly rewards cancelled before payout: **${skipped.cancelledMonthlyRewards}**`
                    )
                    : (
                        '▶️ Scheduled daily, weekly, and monthly giveaway payouts are now **active**.\n\n' +
                        'Only future scheduled winners will be paid. Past skipped winners will not be paid retroactively.'
                    )
            );

            if (state.paused !== paused) {
                console.warn(
                    `Scheduled giveaway payout pause state mismatch: requested=${paused}, saved=${state.paused}`
                );
            }
        } catch (error) {
            logCommandError(interaction, '/pausedailygiveaways', error);
            await interaction.editReply(
                `❌ **Pause daily giveaways failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
