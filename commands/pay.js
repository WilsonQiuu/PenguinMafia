const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    formatCents,
    parseDonationAmount
} = require('../utils/donations.js');
const {
    calculatePayout,
    formatPayoutLine,
    playerName
} = require('../utils/payouts.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('pay')
        .setDescription('Simulate how a payment would be split through the commission chain.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player receiving the base payment')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('amount')
                .setDescription('Payment amount, like 500, 10k, 2.5m, 1b, or 1t')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const donDiscordId = process.env.DON_DISCORD_ID;

        if (!donDiscordId) {
            await interaction.editReply('❌ DON_DISCORD_ID is missing from your `.env` file.');
            return;
        }

        const playerUser = interaction.options.getUser('player');
        let amount;

        try {
            amount = parseDonationAmount(interaction.options.getString('amount'));
        } catch (error) {
            await interaction.editReply(`❌ ${error.message}`);
            return;
        }

        try {
            const result = await calculatePayout(playerUser.id, amount, donDiscordId, sql);

            if (!result) {
                await interaction.editReply(`${playerUser} is not in the database yet.`);
                return;
            }

            const payoutLines = result.payouts.map(formatPayoutLine);
            let message =
                `🧮 **Payment Simulation**\n\n` +
                `Player: **${playerName(result.player, playerUser.username)}**\n` +
                `Amount: **${formatCents(result.totalAmountCents)}**\n\n` +
                `**Payouts**\n` +
                `${payoutLines.join('\n')}\n\n` +
                `Total paid: **${formatCents(result.totalPaidCents)}**\n\n` +
                `Simulation only. No commissions, balances, or player records were changed.`;

            if (result.stoppedAtFinalRank) {
                message += `\nFinal rank reached: **yes**`;
            }

            if (message.length > 1900) {
                message = `${message.slice(0, 1850)}\n\nOutput too long. Showing partial payout chain.`;
            }

            await interaction.editReply(message);
        } catch (error) {
            logCommandError(interaction, '/pay', error);
            await interaction.editReply(
                `❌ **Pay command failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
