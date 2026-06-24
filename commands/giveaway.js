const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    createGiveawayPaymentRequest,
    GIVEAWAY_CHANNEL_ID,
    giveawayPaymentBotUser,
    parseGiveawayDuration
} = require('../utils/giveaways.js');
const {
    formattedMinecraftIgn,
    linkedAccountLabel
} = require('../utils/payouts.js');
const {
    formatDonationAmount,
    parseDonationAmount
} = require('../utils/donations.js');

const MIN_GIVEAWAY_AMOUNT = 1_000_000n;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('giveaway')
        .setDescription('Request a paid timed money giveaway.')
        .addStringOption(option =>
            option
                .setName('amount')
                .setDescription('Amount to give away, minimum 1m')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('duration')
                .setDescription('How long it runs: 30m, 1h, 1 hour, 2h 30m, or 1d')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        let amount;
        let durationMs;

        try {
            amount = parseDonationAmount(interaction.options.getString('amount'));
            durationMs = parseGiveawayDuration(interaction.options.getString('duration'));
        } catch (error) {
            await interaction.editReply(`❌ ${error.message}`);
            return;
        }

        if (amount < MIN_GIVEAWAY_AMOUNT) {
            await interaction.editReply(
                `❌ Giveaway amount must be at least **${formatDonationAmount(MIN_GIVEAWAY_AMOUNT)}**.`
            );
            return;
        }

        try {
            const hostRows = await sql`
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
            const host = hostRows[0];

            if (!host) {
                await interaction.editReply(
                    '❌ You need to finish welcome before hosting a giveaway.'
                );
                return;
            }

            if (!host.minecraft_ign || !host.minecraft_edition) {
                await interaction.editReply(
                    '❌ Link your Minecraft account first with `/link` before hosting a paid giveaway.'
                );
                return;
            }

            const hostMinecraftIgn = formattedMinecraftIgn(host);
            const paymentBotUser = giveawayPaymentBotUser();
            const giveawayChannel = interaction.guild.channels.cache.get(GIVEAWAY_CHANNEL_ID) ||
                (await interaction.guild.channels.fetch(GIVEAWAY_CHANNEL_ID).catch(() => null));

            if (!giveawayChannel?.isTextBased()) {
                await interaction.editReply(
                    `❌ The configured giveaway channel <#${GIVEAWAY_CHANNEL_ID}> could not be found or is not a text channel.`
                );
                return;
            }

            await createGiveawayPaymentRequest({
                guildId: interaction.guild.id,
                channelId: giveawayChannel.id,
                hostDiscordId: interaction.user.id,
                hostMinecraftIgn,
                paymentBotUser,
                amount,
                durationMs
            }, sql);

            await interaction.editReply(
                `✅ Giveaway request created.\n\n` +
                `To host it, pay the Minecraft bot at least **${formatDonationAmount(amount)}** from your linked account:\n` +
                `\`\`\`\n/pay ${paymentBotUser} ${formatDonationAmount(amount)}\n\`\`\`\n` +
                `Linked account: **${linkedAccountLabel(host)}**\n\n` +
                `Once the bot sees that payment from **${hostMinecraftIgn}**, it will post the giveaway in <#${giveawayChannel.id}>.`
            );
        } catch (error) {
            logCommandError(interaction, '/giveaway', error);

            await interaction.editReply(
                `❌ Giveaway failed.\n\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
