const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    createDonationPaymentRequest,
    giveawayPaymentBotUser
} = require('../utils/giveaways.js');
const {
    formatDonationAmount,
    parseDonationAmount
} = require('../utils/donations.js');
const {
    formattedMinecraftIgn,
    linkedAccountLabel
} = require('../utils/payouts.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('donate')
        .setDescription('Create a donation payment request for the Minecraft bot.')
        .addStringOption(option =>
            option
                .setName('amount')
                .setDescription('Amount to donate, like 500, 10k, 2.5m, 1b, or 1t')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        let amount;

        try {
            amount = parseDonationAmount(interaction.options.getString('amount'));
        } catch (error) {
            await interaction.editReply(`❌ ${error.message}`);
            return;
        }

        try {
            const playerRows = await sql`
                select
                    discord_id,
                    discord_username,
                    discord_display_name,
                    minecraft_ign,
                    minecraft_edition
                from players
                where discord_id = ${interaction.user.id}
                    and status = 'active'
                    and welcome_completed = true
                limit 1
            `;
            const player = playerRows[0];

            if (!player) {
                await interaction.editReply(
                    '❌ You need to finish welcome before donating through the Minecraft bot.'
                );
                return;
            }

            if (!player.minecraft_ign || !player.minecraft_edition) {
                await interaction.editReply(
                    '❌ Link your Minecraft account first with `/penguinlink ign:<your ign> edition:<java or bedrock>` before donating through the Minecraft bot.'
                );
                return;
            }

            const donorMinecraftIgn = formattedMinecraftIgn(player);
            const paymentBotUser = giveawayPaymentBotUser();

            await createDonationPaymentRequest({
                guildId: interaction.guild.id,
                donorDiscordId: interaction.user.id,
                donorMinecraftIgn,
                paymentBotUser,
                amount
            }, sql);

            await interaction.editReply(
                `✅ Donation request created.\n\n` +
                `To complete it, pay the Minecraft bot at least **${formatDonationAmount(amount)}** from your linked account:\n` +
                `\`\`\`\n/pay ${paymentBotUser} ${formatDonationAmount(amount)}\n\`\`\`\n` +
                `Linked account: **${linkedAccountLabel(player)}**\n\n` +
                `Once the bot sees that payment from **${donorMinecraftIgn}**, it will add the full amount paid to your donation total.\n` +
                `Payments sent without a pending \`/donate\` or \`/giveaway\` request are logged, but they do not count as donations.`
            );
        } catch (error) {
            logCommandError(interaction, '/donate', error);

            await interaction.editReply(
                `❌ Donate failed.\n\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
