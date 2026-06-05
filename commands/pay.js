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

function playerName(player, fallback = 'Unknown Player') {
    return player.discord_display_name ||
        player.discord_username ||
        fallback;
}

function payoutName(player, fallback = 'Unknown Player') {
    return player.minecraft_ign ||
        player.discord_display_name ||
        player.discord_username ||
        fallback;
}

function parseRateBasisPoints(rate) {
    const [wholePart, decimalPart = ''] = String(rate).split('.');
    const decimals = decimalPart.padEnd(2, '0').slice(0, 2);

    return BigInt(wholePart) * 100n + BigInt(decimals);
}

function formatRate(basisPoints) {
    const whole = basisPoints / 100n;
    const decimals = basisPoints % 100n;

    if (decimals === 0n) {
        return `${whole}%`;
    }

    return `${whole}.${decimals.toString().padStart(2, '0').replace(/0+$/, '')}%`;
}

function payoutCents(amount, rateBasisPoints) {
    return (amount * rateBasisPoints) / 100n;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('pay')
        .setDescription('Show commission payout math. Don runs record unpaid commissions.')
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
            await interaction.editReply(
                '❌ DON_DISCORD_ID is missing from your `.env` file.'
            );
            return;
        }

        const isDon = interaction.user.id === donDiscordId;

        const playerUser = interaction.options.getUser('player');
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
                    p.discord_id,
                    p.discord_username,
                    p.discord_display_name,
                    p.minecraft_ign,
                    p.parent_discord_id,
                    p.rank_name,
                    r.commission_rate,
                    r.is_perm
                from players p
                join ranks r
                    on p.rank_name = r.name
                where p.discord_id = ${playerUser.id}
                limit 1
            `;

            if (playerRows.length === 0) {
                await interaction.editReply(
                    `${playerUser} is not in the database yet.`
                );
                return;
            }

            const parentRows = await sql`
                with recursive parents as (
                    select
                        parent.discord_id,
                        parent.discord_username,
                        parent.discord_display_name,
                        parent.minecraft_ign,
                        parent.parent_discord_id,
                        parent.rank_name,
                        r.commission_rate,
                        r.is_perm,
                        1 as depth
                    from players child
                    join players parent
                        on child.parent_discord_id = parent.discord_id
                    join ranks r
                        on parent.rank_name = r.name
                    where child.discord_id = ${playerUser.id}

                    union all

                    select
                        parent.discord_id,
                        parent.discord_username,
                        parent.discord_display_name,
                        parent.minecraft_ign,
                        parent.parent_discord_id,
                        parent.rank_name,
                        r.commission_rate,
                        r.is_perm,
                        parents.depth + 1 as depth
                    from players parent
                    join parents
                        on parents.parent_discord_id = parent.discord_id
                    join ranks r
                        on parent.rank_name = r.name
                )
                select *
                from parents
                order by depth asc
            `;

            const chain = [playerRows[0], ...parentRows];
            let previousRate = 0n;
            let totalPaidCents = 0n;
            let stoppedAtFinalRank = false;
            const payoutLines = [];
            const unpaidPayouts = [];

            function addPayout(member, amountCents, detail) {
                payoutLines.push(
                    `${payoutLines.length + 1}. **${payoutName(member)}** - ` +
                    `**${formatCents(amountCents)}** (${detail})`
                );

                if (!member.minecraft_ign && amountCents > 0n) {
                    unpaidPayouts.push({
                        discordId: member.discord_id,
                        amountCents,
                        name: payoutName(member)
                    });
                }
            }

            for (let index = 0; index < chain.length; index++) {
                const member = chain[index];
                const rankRate = parseRateBasisPoints(member.commission_rate);
                const positiveRate = rankRate > previousRate ? rankRate - previousRate : 0n;
                const positivePayout = payoutCents(amount, positiveRate);
                const label = index === 0 ? 'Base commission' : 'Override';

                totalPaidCents += positivePayout;

                addPayout(
                    member,
                    positivePayout,
                    `${member.rank_name}, ${label}, ${formatRate(positiveRate)}`
                );

                if (member.is_perm) {
                    const finalRate = 10000n - rankRate;
                    const finalPayout = payoutCents(amount, finalRate);
                    const finalRankParent = chain[index + 1] || null;

                    stoppedAtFinalRank = true;

                    if (finalRankParent) {
                        totalPaidCents += finalPayout;

                        addPayout(
                            finalRankParent,
                            finalPayout,
                            `final rank remainder from ${playerName(member)}, ${formatRate(finalRate)}`
                        );
                    }

                    break;
                }

                if (rankRate > previousRate) {
                    previousRate = rankRate;
                }
            }

            const totalAmountCents = amount * 100n;
            let unallocatedCents = totalAmountCents > totalPaidCents
                ? totalAmountCents - totalPaidCents
                : 0n;

            if (unallocatedCents > 0n) {
                const donRows = await sql`
                    select
                        discord_id,
                        discord_username,
                        discord_display_name,
                        minecraft_ign
                    from players
                    where discord_id = ${donDiscordId}
                    limit 1
                `;

                const don = donRows[0] || {
                    discord_id: donDiscordId,
                    discord_username: 'The Don',
                    discord_display_name: 'The Don',
                    minecraft_ign: null
                };

                addPayout(don, unallocatedCents, 'unallocated funds');

                totalPaidCents += unallocatedCents;
                unallocatedCents = 0n;
            }

            if (totalPaidCents !== totalAmountCents) {
                throw new Error(
                    `Internal payout check failed. Calculated payouts do not equal the payment amount. ` +
                    `Expected ${totalAmountCents.toString()} cents, got ${totalPaidCents.toString()} cents.`
                );
            }

            const unpaidLines = unpaidPayouts.map(unpaidPayout => {
                return `- **${unpaidPayout.name}**: **${formatCents(unpaidPayout.amountCents)}**`;
            });

            if (isDon) {
                for (const unpaidPayout of unpaidPayouts) {
                    await sql`
                        update players
                        set
                            unpaid_commissions = unpaid_commissions + ${unpaidPayout.amountCents.toString()}::bigint,
                            updated_at = now()
                        where discord_id = ${unpaidPayout.discordId}
                    `;
                }
            }

            let message =
                `✅ **${isDon ? 'Payment Recorded' : 'Payment Preview'}**\n\n` +
                `Player: **${playerName(playerRows[0], playerUser.username)}**\n` +
                `Amount: **${formatCents(totalAmountCents)}**\n\n` +
                `**Payouts**\n` +
                `${payoutLines.join('\n')}\n\n` +
                `Total paid: **${formatCents(totalPaidCents)}**`;

            if (unpaidPayouts.length > 0) {
                message +=
                    `\n\n**No Linked IGN**\n` +
                    `${unpaidLines.join('\n')}\n` +
                    (isDon
                        ? `These players did not have a linked IGN, so the money was added to their unpaid commissions.`
                        : `Preview only: these players do not have a linked IGN, so the money would be added to their unpaid commissions.`);
            }

            if (!isDon) {
                message += `\n\nPreview only. No unpaid commissions were changed.`;
            }

            if (stoppedAtFinalRank) {
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
