const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    updateDonationLeaderboardForGuild
} = require('../utils/leaderboards.js');
const {
    formatDonationAmount,
    parseDonationAmount
} = require('../utils/donations.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('donationssub')
        .setDescription('Subtract donations from a player. Don only.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player losing donations')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('amount')
                .setDescription('Amount to subtract, like 500, 10k, 2.5m, 1b, or 1t')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const donDiscordId = process.env.DON_DISCORD_ID;

        if (!donDiscordId) {
            await interaction.editReply(
                '❌ DON_DISCORD_ID is missing from your `.env` file.'
            );
            return;
        }

        if (interaction.user.id !== donDiscordId) {
            await interaction.editReply(
                '❌ Only the Don can use this command.'
            );
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

        if (playerUser.bot) {
            await interaction.editReply(
                '❌ You cannot subtract donations from a bot.'
            );
            return;
        }

        try {
            const rows = await sql`
                update players
                set
                    donations = donations - ${amount.toString()}::bigint,
                    updated_at = now()
                where discord_id = ${playerUser.id}
                    and donations >= ${amount.toString()}::bigint
                returning donations
            `;

            if (rows.length === 0) {
                const existingRows = await sql`
                    select donations
                    from players
                    where discord_id = ${playerUser.id}
                    limit 1
                `;

                if (existingRows.length === 0) {
                    await interaction.editReply(
                        `❌ ${playerUser} is not in the database yet.`
                    );
                    return;
                }

                await interaction.editReply(
                    `❌ Cannot subtract **${formatDonationAmount(amount)}** donations from ${playerUser} because their total is only **${formatDonationAmount(existingRows[0].donations)}**.`
                );
                return;
            }

            await interaction.editReply(
                `✅ **Donations subtracted!**\n\n` +
                `Player: ${playerUser} \`${playerUser.id}\`\n` +
                `Subtracted: **${formatDonationAmount(amount)}**\n` +
                `New total: **${formatDonationAmount(rows[0].donations)}**`
            );

            const leaderboardUpdated = await updateDonationLeaderboardForGuild(interaction.guild, sql).catch(error => {
                console.error('Donation leaderboard refresh failed after /donationssub:');
                console.error(error);
                return false;
            });

            if (!leaderboardUpdated) {
                await interaction.followUp({
                    content: '⚠️ Donations were subtracted, but I could not refresh `💎-top-donators`. Run `/setup` if that channel is missing.',
                    flags: MessageFlags.Ephemeral
                });
            }
        } catch (error) {
            logCommandError(interaction, '/donationssub', error);

            await interaction.editReply(
                `❌ **Donation subtract failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
