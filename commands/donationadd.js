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
    postDonationEvent
} = require('../utils/events.js');
const {
    formatDonationAmount,
    parseDonationAmount
} = require('../utils/donations.js');
const {
    isDon
} = require('../utils/staff.js');

const DEFAULT_RANK_NAME = 'Penguin Soldier';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('donationadd')
        .setDescription('Add donations to a player. Owner only.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player receiving donations')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('amount')
                .setDescription('Amount to add, like 500, 10k, 2.5m, 1b, or 1t')
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

        if (!isDon(interaction.user.id)) {
            await interaction.editReply(
                '❌ Only the owner can use this command.'
            );
            return;
        }

        const playerUser = interaction.options.getUser('player');
        const playerMember = interaction.options.getMember('player');
        let amount;

        try {
            amount = parseDonationAmount(interaction.options.getString('amount'));
        } catch (error) {
            await interaction.editReply(`❌ ${error.message}`);
            return;
        }

        if (playerUser.bot) {
            await interaction.editReply(
                '❌ You cannot add donations to a bot.'
            );
            return;
        }

        const playerDisplayName =
            playerMember?.displayName ||
            playerUser.globalName ||
            playerUser.username;

        try {
            const rows = await sql`
                insert into players (
                    discord_id,
                    discord_username,
                    discord_display_name,
                    minecraft_ign,
                    parent_discord_id,
                    claims_available,
                    donations,
                    rank_name,
                    status
                )
                values (
                    ${playerUser.id},
                    ${playerUser.username},
                    ${playerDisplayName},
                    null,
                    null,
                    0,
                    ${amount.toString()}::bigint,
                    ${DEFAULT_RANK_NAME},
                    'active'
                )
                on conflict (discord_id) do update
                set
                    discord_username = excluded.discord_username,
                    discord_display_name = excluded.discord_display_name,
                    donations = players.donations + excluded.donations,
                    updated_at = now()
                returning donations
            `;

            await interaction.editReply(
                `✅ **Donations added!**\n\n` +
                `Player: ${playerUser} \`${playerUser.id}\`\n` +
                `Added: **${formatDonationAmount(amount)}**\n` +
                `New total: **${formatDonationAmount(rows[0].donations)}**`
            );

            const eventPosted = await postDonationEvent(interaction.guild, {
                playerId: playerUser.id,
                amount,
                newTotal: rows[0].donations
            }).catch(error => {
                console.error('Promotion event channel post failed after /donationadd:');
                console.error(error);
                return false;
            });

            if (!eventPosted) {
                await interaction.followUp({
                    content: '⚠️ Donation was added, but I could not post it in the configured promotion events channel. Check the channel ID.',
                    flags: MessageFlags.Ephemeral
                });
            }

            const leaderboardUpdated = await updateDonationLeaderboardForGuild(interaction.guild, sql).catch(error => {
                console.error('Donation leaderboard refresh failed after /donationadd:');
                console.error(error);
                return false;
            });

            if (!leaderboardUpdated) {
                await interaction.followUp({
                    content: '⚠️ Donation was added, but I could not refresh the configured top donators channel. Check the channel ID.',
                    flags: MessageFlags.Ephemeral
                });
            }
        } catch (error) {
            logCommandError(interaction, '/donationadd', error);

            await interaction.editReply(
                `❌ **Donation add failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
