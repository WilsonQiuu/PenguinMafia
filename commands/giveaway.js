const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const { logCommandError } = require('../utils/logging.js');
const {
    APPROVED_GIVEAWAY_HOSTS,
    createSponsoredGiveawayRequest,
    GIVEAWAY_CHANNEL_ID,
    parseGiveawayDuration,
    sendSponsoredGiveawayHostRequest,
    startFundedGiveaway,
    validateGiveawayDurationForAmount
} = require('../utils/giveaways.js');
const {
    formatDonationAmount,
    parseDonationAmount
} = require('../utils/donations.js');
const { isDon } = require('../utils/staff.js');

const MIN_GIVEAWAY_AMOUNT = 1_000_000n;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('giveaway')
        .setDescription('Start or sponsor a timed money giveaway.')
        .addStringOption(option =>
            option
                .setName('amount')
                .setDescription('Amount to give away, minimum 1m')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('duration')
                .setDescription('30m, 1h, 1d, 1w. Larger prize pools unlock longer timers.')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('payment_host')
                .setDescription('Who is online and ready to receive your payment?')
                .addChoices(...APPROVED_GIVEAWAY_HOSTS.map(host => ({
                    name: host.minecraftIgn,
                    value: host.discordId
                })))
        ),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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
            validateGiveawayDurationForAmount(amount, durationMs);

            const sponsorRows = await sql`
                select discord_id, minecraft_ign, minecraft_edition
                from players
                where discord_id = ${interaction.user.id}
                    and status = 'active'
                    and welcome_completed = true
                limit 1
            `;
            const sponsor = sponsorRows[0];

            if (!sponsor) {
                await interaction.editReply('❌ You need to finish welcome before starting a giveaway.');
                return;
            }

            const giveawayChannel = interaction.guild.channels.cache.get(GIVEAWAY_CHANNEL_ID) ||
                await interaction.guild.channels.fetch(GIVEAWAY_CHANNEL_ID).catch(() => null);

            if (!giveawayChannel?.isTextBased()) {
                await interaction.editReply(
                    `❌ The configured giveaway channel <#${GIVEAWAY_CHANNEL_ID}> could not be found.`
                );
                return;
            }

            if (isDon(interaction.user.id)) {
                await sql`
                    update giveaway_payment_requests
                    set status = 'cancelled', updated_at = now()
                    where guild_id = ${interaction.guild.id}
                        and sponsor_discord_id = ${interaction.user.id}
                        and status in ('awaiting_acceptance', 'pending_payment')
                `;
                await startFundedGiveaway(interaction.guild, {
                    guildId: interaction.guild.id,
                    channelId: giveawayChannel.id,
                    hostDiscordId: interaction.user.id,
                    sponsorDiscordId: interaction.user.id,
                    amount,
                    durationMs
                }, sql);

                await interaction.editReply(
                    `✅ Giveaway started instantly for **${formatDonationAmount(amount)}** in <#${giveawayChannel.id}>.`
                );
                return;
            }

            const selectedHostId = interaction.options.getString('payment_host');
            const selectedHost = APPROVED_GIVEAWAY_HOSTS.find(host => host.discordId === selectedHostId);

            if (!selectedHost) {
                await interaction.editReply(
                    '❌ Choose **itsWSQ** or **rainbowbeltzz** as the payment host. Pick the player who is online and ready to accept your payment.'
                );
                return;
            }

            const request = await createSponsoredGiveawayRequest({
                guildId: interaction.guild.id,
                channelId: giveawayChannel.id,
                sponsorDiscordId: interaction.user.id,
                hostDiscordId: selectedHost.discordId,
                hostMinecraftIgn: selectedHost.minecraftIgn,
                amount,
                durationMs
            }, sql);

            try {
                await sendSponsoredGiveawayHostRequest(interaction.guild, request);
            } catch (error) {
                await sql`
                    update giveaway_payment_requests
                    set status = 'failed', updated_at = now()
                    where id = ${request.id}
                        and status = 'awaiting_acceptance'
                `;
                throw error;
            }
            await interaction.editReply(
                `✅ Request sent to <@${selectedHost.discordId}>. They must accept before you receive payment instructions.\n\n` +
                `Only pay after the bot DMs you the correct command.`
            );
        } catch (error) {
            logCommandError(interaction, '/giveaway', error);
            await interaction.editReply(`❌ Giveaway failed.\n\n\`\`\`\n${error.message}\n\`\`\``);
        }
    }
};
