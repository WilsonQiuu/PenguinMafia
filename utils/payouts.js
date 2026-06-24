const sql = require('../db.js');
const {
    formatCents
} = require('./donations.js');

function playerName(player, fallback = 'Unknown Player') {
    return player.discord_display_name ||
        player.discord_username ||
        fallback;
}

function formattedMinecraftIgn(player) {
    if (!player.minecraft_ign) {
        return null;
    }

    if (
        player.minecraft_edition === 'bedrock' &&
        !player.minecraft_ign.startsWith('.')
    ) {
        return `.${player.minecraft_ign}`;
    }

    return player.minecraft_ign;
}

function payoutName(player, fallback = 'Unknown Player') {
    return formattedMinecraftIgn(player) ||
        playerName(player, fallback);
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

function linkedAccountLabel(player) {
    if (!player.minecraft_ign) {
        return `${playerName(player)} — Unlinked`;
    }

    const edition = player.minecraft_edition === 'bedrock'
        ? 'Bedrock'
        : player.minecraft_edition === 'java'
            ? 'Java'
            : 'Linked, edition not set';

    return `${formattedMinecraftIgn(player)} — ${edition}`;
}

function formatPayoutLine(payout, index, options = {}) {
    const discordMention = options.includeDiscordMention && payout.player.discord_id
        ? `<@${payout.player.discord_id}> — `
        : '';
    const label = options.includeLabel !== false && payout.label
        ? ` | ${payout.label}`
        : '';

    return (
        `${index + 1}. ${discordMention}**${linkedAccountLabel(payout.player)}**\n` +
        `   Role: **${payout.roleName}** | Share: **${formatRate(payout.rateBasisPoints)}** | ` +
        `Amount: **${formatCents(payout.amountCents)}**${label}`
    );
}

function payoutRecipientKey(payout) {
    if (payout.player.discord_id) {
        return `discord:${payout.player.discord_id}`;
    }

    const minecraftName = formattedMinecraftIgn(payout.player);

    if (minecraftName) {
        return `minecraft:${minecraftName.toLowerCase()}`;
    }

    return `name:${playerName(payout.player).toLowerCase()}`;
}

function combinePayouts(payouts) {
    const combined = [];
    const byRecipient = new Map();

    for (const payout of payouts) {
        const key = payoutRecipientKey(payout);
        const existing = byRecipient.get(key);

        if (!existing) {
            const copy = {
                ...payout,
                label: payout.label || null
            };

            byRecipient.set(key, copy);
            combined.push(copy);
            continue;
        }

        existing.amountCents += payout.amountCents;
        existing.rateBasisPoints += payout.rateBasisPoints;

        if (payout.label && !String(existing.label || '').split(' + ').includes(payout.label)) {
            existing.label = existing.label
                ? `${existing.label} + ${payout.label}`
                : payout.label;
        }
    }

    return combined;
}

async function calculatePayout(playerDiscordId, amount, donDiscordId, db = sql) {
    if (!donDiscordId) {
        throw new Error('DON_DISCORD_ID is missing from the environment.');
    }

    const playerRows = await db`
        select
            p.discord_id,
            p.discord_username,
            p.discord_display_name,
            p.minecraft_ign,
            p.minecraft_edition,
            p.parent_discord_id,
            p.rank_name,
            r.commission_rate,
            r.is_perm
        from players p
        join ranks r
            on p.rank_name = r.name
        where p.discord_id = ${playerDiscordId}
        limit 1
    `;

    if (playerRows.length === 0) {
        return null;
    }

    const parentRows = await db`
        with recursive parents as (
            select
                parent.discord_id,
                parent.discord_username,
                parent.discord_display_name,
                parent.minecraft_ign,
                parent.minecraft_edition,
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
            where child.discord_id = ${playerDiscordId}

            union all

            select
                parent.discord_id,
                parent.discord_username,
                parent.discord_display_name,
                parent.minecraft_ign,
                parent.minecraft_edition,
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
    const payouts = [];
    let previousRate = 0n;
    let totalPaidCents = 0n;
    let stoppedAtFinalRank = false;

    function addPayout(player, amountCents, rateBasisPoints, label, roleName = null) {
        payouts.push({
            player,
            amountCents,
            rateBasisPoints,
            label,
            roleName: roleName || player.rank_name || 'The Don'
        });
        totalPaidCents += amountCents;
    }

    for (let index = 0; index < chain.length; index++) {
        const member = chain[index];
        const rankRate = parseRateBasisPoints(member.commission_rate);
        const positiveRate = rankRate > previousRate
            ? rankRate - previousRate
            : 0n;

        addPayout(
            member,
            payoutCents(amount, positiveRate),
            positiveRate,
            index === 0 ? 'Base commission' : 'Recruiter override'
        );

        if (member.is_perm) {
            const finalRate = 10000n - rankRate;
            const finalRankParent = chain[index + 1] || null;

            stoppedAtFinalRank = true;

            if (finalRankParent) {
                addPayout(
                    finalRankParent,
                    payoutCents(amount, finalRate),
                    finalRate,
                    `Final-rank remainder from ${playerName(member)}`
                );
            }

            break;
        }

        if (rankRate > previousRate) {
            previousRate = rankRate;
        }
    }

    const totalAmountCents = amount * 100n;
    const unallocatedCents = totalAmountCents > totalPaidCents
        ? totalAmountCents - totalPaidCents
        : 0n;

    if (unallocatedCents > 0n) {
        const donRows = await db`
            select
                discord_id,
                discord_username,
                discord_display_name,
                minecraft_ign,
                minecraft_edition,
                rank_name
            from players
            where discord_id = ${donDiscordId}
            limit 1
        `;
        const don = donRows[0] || {
            discord_id: donDiscordId,
            discord_username: 'The Don',
            discord_display_name: 'The Don',
            minecraft_ign: null,
            minecraft_edition: null,
            rank_name: 'The Don'
        };

        addPayout(
            don,
            unallocatedCents,
            (unallocatedCents * 10000n) / totalAmountCents,
            'Unallocated funds',
            don.rank_name || 'The Don'
        );
    }

    if (totalPaidCents !== totalAmountCents) {
        throw new Error(
            `Internal payout check failed. Expected ${totalAmountCents} cents, got ${totalPaidCents} cents.`
        );
    }

    return {
        player: playerRows[0],
        payouts: combinePayouts(payouts),
        stoppedAtFinalRank,
        totalAmountCents,
        totalPaidCents
    };
}

module.exports = {
    calculatePayout,
    formattedMinecraftIgn,
    formatPayoutLine,
    formatRate,
    linkedAccountLabel,
    payoutName,
    playerName
};
