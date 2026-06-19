const {
    SlashCommandBuilder
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    createGiveaway,
    renderGiveaway
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
        .addIntegerOption(option =>
            option
                .setName('hours')
                .setDescription('How many hours the giveaway will run')
                .setMinValue(1)
                .setMaxValue(720)
                .setRequired(true)
        ),

    async execute(interaction) {
        let amount;

        try {
            amount = parseDonationAmount(interaction.options.getString('amount'));
        } catch (error) {
            await interaction.reply({
                content: `❌ ${error.message}`,
                ephemeral: true
            });
            return;
        }

        const hours = interaction.options.getInteger('hours');

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
                await interaction.reply({
                    content: '❌ You need to be a registered Penguin General or Emperor Penguin to host a giveaway.',
                    ephemeral: true
                });
                return;
            }

            const giveaway = await createGiveaway({
                guildId: interaction.guild.id,
                channelId: interaction.channel.id,
                hostDiscordId: interaction.user.id,
                amount,
                hours
            }, sql);

            try {
                await interaction.reply(renderGiveaway(giveaway, 0, null, {
                    pingGiveawayRole: true
                }));
                const message = await interaction.fetchReply();

                await sql`
                    update giveaways
                    set message_id = ${message.id}
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
        } catch (error) {
            logCommandError(interaction, '/giveaway', error);

            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({
                    content: `❌ Giveaway failed.\n\n\`\`\`\n${error.message}\n\`\`\``,
                    ephemeral: true
                });
            } else {
                await interaction.reply({
                    content: `❌ Giveaway failed.\n\n\`\`\`\n${error.message}\n\`\`\``,
                    ephemeral: true
                });
            }
        }
    }
};
