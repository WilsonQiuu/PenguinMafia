const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    formatCents
} = require('../utils/donations.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    payOutstandingCommissions
} = require('../utils/commissionPayments.js');
const {
    playerName
} = require('../utils/payouts.js');
const {
    isDon
} = require('../utils/staff.js');

function totalCents(results, status) {
    return results
        .filter(result => result.status === status)
        .reduce((total, result) => total + result.amountCents, 0n);
}

function resultLine(result) {
    const player = result.player || {};
    const name = player.discord_id
        ? `<@${player.discord_id}>`
        : playerName(player);
    const target = result.minecraftName
        ? ` -> ${result.minecraftName}`
        : '';
    const reason = result.reason
        ? ` (${result.reason})`
        : '';

    return `- ${name}${target}: **${formatCents(result.amountCents)}**${reason}`;
}

function previewResults(results, limit = 6) {
    if (results.length === 0) {
        return 'None';
    }

    const preview = results
        .slice(0, limit)
        .map(resultLine)
        .join('\n');
    const remaining = results.length - limit;

    return remaining > 0
        ? `${preview}\n- ...and ${remaining} more`
        : preview;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('payallcommissions')
        .setDescription('Pay every linked unpaid commission balance. Don only.'),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        if (!isDon(interaction.user.id)) {
            await interaction.editReply('Only the Don can use `/payallcommissions`.');
            return;
        }

        try {
            const summary = await payOutstandingCommissions(sql, {
                actorId: interaction.user.id,
                actorTag: interaction.user.tag || interaction.user.username,
                source: 'Discord /payallcommissions'
            });

            if (summary.totalPlayers === 0) {
                await interaction.editReply('There are no unpaid commissions right now.');
                return;
            }

            const paid = summary.results.filter(result => result.status === 'paid');
            const skipped = summary.results.filter(result => result.status === 'skipped');
            const failed = summary.results.filter(result => result.status === 'failed');
            const paidTotal = totalCents(summary.results, 'paid');
            const failedTotal = totalCents(summary.results, 'failed') + totalCents(summary.results, 'skipped');

            let message =
                `**Pay All Commissions Complete**\n\n` +
                `Paid: **${paid.length}** player${paid.length === 1 ? '' : 's'} (**${formatCents(paidTotal)}**)\n` +
                `Still unpaid: **${failed.length + skipped.length}** player${failed.length + skipped.length === 1 ? '' : 's'} (**${formatCents(failedTotal)}**)\n\n` +
                `**Paid**\n${previewResults(paid)}\n\n` +
                `**Needs /penguinlink**\n${previewResults(skipped)}\n\n` +
                `**Failed**\n${previewResults(failed)}`;

            if (message.length > 1900) {
                message = `${message.slice(0, 1850)}\n\nOutput trimmed. Check bot logs for the full payment details.`;
            }

            await interaction.editReply(message);
        } catch (error) {
            logCommandError(interaction, '/payallcommissions', error);
            await interaction.editReply(
                `Pay all commissions failed.\n\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
