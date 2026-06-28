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

function playerName(player, fallback = 'Unknown Player') {
    return player.discord_display_name ||
        player.discord_username ||
        fallback;
}

function minecraftAccountLine(player) {
    if (!player.minecraft_ign) {
        return 'Minecraft account: `Not linked`';
    }

    const edition = player.minecraft_edition === 'bedrock'
        ? 'Bedrock'
        : player.minecraft_edition === 'java'
            ? 'Java'
            : 'Edition not set';
    const ign = player.minecraft_edition === 'bedrock' && !player.minecraft_ign.startsWith('.')
        ? `.${player.minecraft_ign}`
        : player.minecraft_ign;

    return `Minecraft account: \`${ign}\` (${edition})`;
}

function countLine(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('giveawayearnings')
        .setDescription('Check total money earned from giveaways and hourly recruiter rewards.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player to check.')
                .setRequired(false)
        ),

    async execute(interaction) {
        await interaction.deferReply();

        const requestedUser = interaction.options.getUser('player') || interaction.user;

        try {
            const playerRows = await sql`
                select
                    discord_id,
                    discord_username,
                    discord_display_name,
                    minecraft_ign,
                    minecraft_edition
                from players
                where discord_id = ${requestedUser.id}
                limit 1
            `;

            if (playerRows.length === 0) {
                await interaction.editReply(
                    `${requestedUser} is not in the database yet.`
                );
                return;
            }

            const player = playerRows[0];
            const rows = await sql`
                with earnings as (
                    select
                        'giveaway' as source,
                        amount_cents,
                        is_winner
                    from giveaway_payout_jobs
                    where guild_id = ${interaction.guild.id}
                        and recipient_discord_id = ${requestedUser.id}
                        and status in ('paid', 'credited')

                    union all

                    select
                        'hourly' as source,
                        amount_cents,
                        is_winner
                    from hourly_recruit_reward_payout_jobs
                    where guild_id = ${interaction.guild.id}
                        and recipient_discord_id = ${requestedUser.id}
                        and status in ('paid', 'credited')
                )
                select
                    coalesce(sum(amount_cents) filter (where is_winner = true), 0)::text as direct_cents,
                    coalesce(sum(amount_cents) filter (where is_winner = false), 0)::text as commission_cents,
                    coalesce(sum(amount_cents) filter (where source = 'giveaway' and is_winner = true), 0)::text as giveaway_direct_cents,
                    coalesce(sum(amount_cents) filter (where source = 'hourly' and is_winner = true), 0)::text as hourly_direct_cents,
                    coalesce(sum(amount_cents) filter (where source = 'giveaway' and is_winner = false), 0)::text as giveaway_commission_cents,
                    coalesce(sum(amount_cents) filter (where source = 'hourly' and is_winner = false), 0)::text as hourly_commission_cents,
                    coalesce(sum(amount_cents), 0)::text as total_cents,
                    count(*) filter (where is_winner = true)::int as direct_payouts,
                    count(*) filter (where is_winner = false)::int as commission_payouts,
                    count(*) filter (where source = 'giveaway' and is_winner = true)::int as giveaway_direct_payouts,
                    count(*) filter (where source = 'hourly' and is_winner = true)::int as hourly_direct_payouts,
                    count(*) filter (where source = 'giveaway' and is_winner = false)::int as giveaway_commission_payouts,
                    count(*) filter (where source = 'hourly' and is_winner = false)::int as hourly_commission_payouts,
                    count(*)::int as total_payouts
                from earnings
            `;
            const earnings = rows[0] || {};

            await interaction.editReply(
                `🎁 **Giveaway + Hourly Reward Earnings**\n\n` +
                `Player: **${playerName(player, requestedUser.username)}**\n` +
                `${minecraftAccountLine(player)}\n\n` +
                `Direct earnings: **${formatCents(earnings.direct_cents || 0)}** ` +
                `(${countLine(earnings.direct_payouts || 0, 'payout')})\n` +
                `- Giveaway wins: **${formatCents(earnings.giveaway_direct_cents || 0)}** ` +
                `(${countLine(earnings.giveaway_direct_payouts || 0, 'payout')})\n` +
                `- Hourly recruiter wins: **${formatCents(earnings.hourly_direct_cents || 0)}** ` +
                `(${countLine(earnings.hourly_direct_payouts || 0, 'payout')})\n` +
                `Commission earnings: **${formatCents(earnings.commission_cents || 0)}** ` +
                `(${countLine(earnings.commission_payouts || 0, 'payout')})\n` +
                `- Giveaway commissions: **${formatCents(earnings.giveaway_commission_cents || 0)}** ` +
                `(${countLine(earnings.giveaway_commission_payouts || 0, 'payout')})\n` +
                `- Hourly reward commissions: **${formatCents(earnings.hourly_commission_cents || 0)}** ` +
                `(${countLine(earnings.hourly_commission_payouts || 0, 'payout')})\n` +
                `Total earnings: **${formatCents(earnings.total_cents || 0)}** ` +
                `(${countLine(earnings.total_payouts || 0, 'payout')})\n\n` +
                `Hourly top-recruiter winners count as direct earnings. Recruiter-chain payouts count as commissions.`
            );
        } catch (error) {
            logCommandError(interaction, '/giveawayearnings', error);

            await interaction.editReply(
                `❌ **Giveaway earnings command failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
