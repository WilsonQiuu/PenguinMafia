const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    createGiveaway,
    GIVEAWAY_CHANNEL_ID,
    parseGiveawayDuration,
    renderGiveaway,
    renderGiveawayHostControls
} = require('../utils/giveaways.js');
const {
    parseDonationAmount
} = require('../utils/donations.js');
const {
    getRankIndex
} = require('../utils/ranks.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('giveaway')
        .setDescription('Host a timed money giveaway. Penguin General or higher.')
        .addStringOption(option =>
            option
                .setName('amount')
                .setDescription('Amount to give away, like 500, 10k, 2.5m, 1b, or 1t')
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

        try {
            const hostRows = await sql`
                select rank_name
                from players
                where discord_id = ${interaction.user.id}
                    and status = 'active'
                    and welcome_completed = true
                limit 1
            `;
            const host = hostRows[0];
            const hostRank = host ? getRankIndex(host.rank_name) : undefined;
            const generalRank = getRankIndex('Penguin General');

            if (hostRank === undefined || hostRank < generalRank) {
                await interaction.editReply(
                    '❌ You need to be a registered Penguin General or Emperor Penguin to host a giveaway.'
                );
                return;
            }

            const giveawayChannel = interaction.guild.channels.cache.get(GIVEAWAY_CHANNEL_ID) ||
                (await interaction.guild.channels.fetch(GIVEAWAY_CHANNEL_ID).catch(() => null));

            if (!giveawayChannel?.isTextBased()) {
                await interaction.editReply(
                    `❌ The configured giveaway channel <#${GIVEAWAY_CHANNEL_ID}> could not be found or is not a text channel.`
                );
                return;
            }

            const giveaway = await createGiveaway({
                guildId: interaction.guild.id,
                channelId: giveawayChannel.id,
                hostDiscordId: interaction.user.id,
                amount,
                durationMs
            }, sql);
            let giveawayMessage;

            try {
                giveawayMessage = await giveawayChannel.send(renderGiveaway(giveaway, 0, null, {
                    pingGiveawayRole: true
                }));

                await sql`
                    update giveaways
                    set message_id = ${giveawayMessage.id}
                    where id = ${giveaway.id}
                `;
            } catch (error) {
                await sql`
                    update giveaways
                    set
                        status = 'cancelled',
                        ended_at = now()
                    where id = ${giveaway.id}
                `;
                throw error;
            }

            try {
                const hostControls = renderGiveawayHostControls(giveaway);

                await interaction.editReply({
                    ...hostControls,
                    content:
                        `✅ Giveaway posted in <#${giveawayChannel.id}>.\n` +
                        `[Open Giveaway](${giveawayMessage.url})\n\n` +
                        `${hostControls.content}`
                });
            } catch (error) {
                console.warn(`Giveaway ${giveaway.id} was posted, but its private host controls could not be sent.`);
                console.warn(error);
            }
        } catch (error) {
            logCommandError(interaction, '/giveaway', error);

            await interaction.editReply(
                `❌ Giveaway failed.\n\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
