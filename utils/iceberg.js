const {
    PermissionFlagsBits,
    ChannelType
} = require('discord.js');

const sql = require('../db.js');
const {
    ICEBERG_CHANNEL_ID,
    ICEBERG_MEMBERS_CHANNEL_ID,
    ICEBERG_ROLE_ID,
    ICEBERG_ENTRY_FEE_CENTS,
    ICEBERG_MIN_PLOT_PRICE_CENTS
} = require('./bootstrap.js');
const {
    formatDonationAmount
} = require('./donations.js');
const {
    parseMinecraftAmountValue
} = require('../minecraft-bot.js');
const {
    giveawayPaymentBotUser
} = require('./giveaways.js');

function plotPriceCents(plotNumber) {
    const step = Math.floor((plotNumber - 1) / 2);
    const price = 20_000_000n - BigInt(step) * 1_000_000n;
    return price >= ICEBERG_MIN_PLOT_PRICE_CENTS ? price : ICEBERG_MIN_PLOT_PRICE_CENTS;
}

async function getIcebergRole(guild) {
    return guild.roles.cache.get(ICEBERG_ROLE_ID) ||
        (await guild.roles.fetch(ICEBERG_ROLE_ID).catch(() => null));
}

async function isIcebergMember(guild, member) {
    const role = await getIcebergRole(guild);
    return role && member.roles.cache.has(role.id);
}

async function isTrustedPenguin(guild, member) {
    const trustedRoleId = process.env.TRUSTED_PENGUIN_ROLE_ID || '1518113965282955345';
    return member.roles.cache.has(trustedRoleId);
}

async function getFundBalance() {
    const rows = await sql`select balance from iceberg_fund where id = 1 limit 1`;
    return rows[0]?.balance || 0n;
}

async function addToFund(amountCents) {
    const rows = await sql`
        update iceberg_fund
        set balance = balance + ${amountCents.toString()}::bigint, updated_at = now()
        where id = 1
        returning balance
    `;
    return rows[0]?.balance || 0n;
}

async function isPlotClaimed(plotNumber, guild) {
    const rows = await sql`
        select owner_discord_id, current_claimer_discord_id, claim_expires_at
        from iceberg_plots
        where plot_number = ${plotNumber}
        limit 1
    `;
    const plot = rows[0];
    if (!plot) return null;
    if (plot.owner_discord_id) return { status: 'owned', ownerId: plot.owner_discord_id };
    if (plot.current_claimer_discord_id && plot.claim_expires_at && new Date(plot.claim_expires_at) > new Date()) {
        return { status: 'on_hold', claimerId: plot.current_claimer_discord_id, expiresAt: plot.claim_expires_at };
    }
    return { status: 'available' };
}

async function createPendingJoinRequest(guild, member, minecraftIgn) {
    await sql`
        insert into iceberg_payment_requests (
            guild_id, player_discord_id, player_minecraft_ign,
            payment_bot_user, amount, purpose
        ) values (
            ${guild.id}, ${member.id}, ${minecraftIgn},
            ${giveawayPaymentBotUser()}, ${ICEBERG_ENTRY_FEE_CENTS.toString()}::bigint, 'join'
        )
    `;
}

async function createPendingClaimRequest(guild, member, minecraftIgn, plotNumber) {
    const price = plotPriceCents(plotNumber);
    await sql`
        insert into iceberg_payment_requests (
            guild_id, player_discord_id, player_minecraft_ign,
            payment_bot_user, amount, purpose, plot_number
        ) values (
            ${guild.id}, ${member.id}, ${minecraftIgn},
            ${giveawayPaymentBotUser()}, ${price.toString()}::bigint, 'claim', ${plotNumber}
        )
    `;

    await sql`
        insert into iceberg_plots (plot_number, original_price, current_claimer_discord_id, claim_expires_at)
        values (${plotNumber}, ${price.toString()}::bigint, ${member.id}, now() + interval '5 minutes')
        on conflict (plot_number) do update
        set
            current_claimer_discord_id = ${member.id},
            claim_expires_at = now() + interval '5 minutes',
            updated_at = now()
    `;
}

async function processIncomingIcebergPayment(guild, payment) {
    const paymentPlayer = (payment.player || '').toLowerCase();

    let paidAmount;
    try {
        paidAmount = parseMinecraftAmountValue(payment.amount);
    } catch {
        return { status: 'unmatched', reason: 'Could not parse payment amount.' };
    }

    if (!paidAmount || paidAmount <= 0n) {
        return { status: 'unmatched', reason: 'Invalid payment amount.' };
    }

    const tolerance = 100_000n;
    const acceptableAmount = paidAmount + tolerance;

    const requestRows = await sql`
        select *
        from iceberg_payment_requests
        where guild_id = ${guild.id}
            and status = 'pending'
            and lower(player_minecraft_ign) in (${paymentPlayer}, ${paymentPlayer.replace(/^\./, '')}, ${'.' + paymentPlayer.replace(/^\./, '')})
            and amount <= ${acceptableAmount.toString()}::bigint
        order by created_at asc
        limit 1
    `;
    const request = requestRows[0];

    if (!request) {
        return { status: 'unmatched' };
    }

    const guildDb = guild;
    const member = await guild.members.fetch(request.player_discord_id).catch(() => null);

    if (request.purpose === 'join') {
        await sql`update iceberg_payment_requests set status = 'processing' where id = ${request.id}`;

        if (member) {
            const role = await getIcebergRole(guild);
            if (role) await member.roles.add(role, 'Iceberg join fee paid');
        }

        await sql`
            insert into iceberg_members (discord_id) values (${request.player_discord_id})
            on conflict (discord_id) do nothing
        `;

        const newBalance = await addToFund(request.amount);

        await sql`
            update iceberg_payment_requests
            set status = 'completed', paid_amount = ${paidAmount.toString()}::bigint,
                payment_message = ${payment.message || null}, paid_at = now(), updated_at = now()
            where id = ${request.id}
        `;

        await updateIcebergChannel(guild);

        return { status: 'join_completed', request, paidAmount, newBalance, member };
    }

    if (request.purpose === 'claim') {
        await sql`update iceberg_payment_requests set status = 'processing' where id = ${request.id}`;

        const newBalance = await addToFund(request.amount);

        await sql`
            update iceberg_plots
            set owner_discord_id = ${request.player_discord_id},
                bought_at = now(), current_claimer_discord_id = null, claim_expires_at = null, updated_at = now()
            where plot_number = ${request.plot_number}
        `;

        await sql`
            update iceberg_payment_requests
            set status = 'completed', paid_amount = ${paidAmount.toString()}::bigint,
                payment_message = ${payment.message || null}, paid_at = now(), updated_at = now()
            where id = ${request.id}
        `;

        await updateIcebergChannel(guild);

        return { status: 'claim_completed', request, paidAmount, newBalance, member, plotNumber: request.plot_number };
    }

    return { status: 'unmatched' };
}

async function checkExpiredClaims() {
    const expired = await sql`
        update iceberg_plots
        set current_claimer_discord_id = null, claim_expires_at = null, updated_at = now()
        where claim_expires_at is not null and claim_expires_at <= now()
        returning plot_number
    `;

    if (expired.length > 0) {
        await sql`
            update iceberg_payment_requests
            set status = 'expired', updated_at = now()
            where status = 'pending' and purpose = 'claim'
                and plot_number = any(${expired.map(r => r.plot_number)})
                and claim_expires_at is not null and claim_expires_at <= now()
        `;
    }

    return expired.length;
}

async function getPlotInfo(plotNumber) {
    const rows = await sql`
        select p.plot_number, p.original_price, p.bought_at,
               p.owner_discord_id, p.current_claimer_discord_id, p.claim_expires_at,
               pl.discord_username, pl.discord_display_name, pl.minecraft_ign
        from iceberg_plots p
        left join players pl on pl.discord_id = p.owner_discord_id
        where p.plot_number = ${plotNumber}
        limit 1
    `;
    return rows[0] || null;
}

async function transferPlot(plotNumber, fromUserId, toUserId) {
    const rows = await sql`
        update iceberg_plots
        set owner_discord_id = ${toUserId}, updated_at = now()
        where plot_number = ${plotNumber} and owner_discord_id = ${fromUserId}
        returning plot_number
    `;
    return rows.length > 0;
}

async function getAllMembers() {
    return sql`
        select m.discord_id, m.joined_at, pl.discord_username, pl.discord_display_name, pl.minecraft_ign
        from iceberg_members m
        join players pl on pl.discord_id = m.discord_id
        order by m.joined_at asc
    `;
}

async function updateIcebergChannel(guild) {
    const channel = guild.channels.cache.get(ICEBERG_CHANNEL_ID) ||
        (await guild.channels.fetch(ICEBERG_CHANNEL_ID).catch(() => null));

    if (!channel) return false;

    const balance = await getFundBalance();
    const balanceFormatted = formatDonationAmount(balance);

    const memberCount = (await sql`select count(*)::int as count from iceberg_members`)[0]?.count || 0;

    let plotLines = [];
    for (let n = 1; n <= 20; n++) {
        const info = await getPlotInfo(n);
        const price = plotPriceCents(n);
        const priceFormatted = formatDonationAmount(price);
        if (!info) {
            plotLines.push(`**Plot ${n}** — ${priceFormatted} (available)`);
        } else if (info.owner_discord_id) {
            const ownerName = info.minecraft_ign || info.discord_display_name || info.discord_username || 'Unknown';
            plotLines.push(`**Plot ${n}** — Owned by **${ownerName}** (bought for ${formatDonationAmount(info.original_price)})`);
        } else if (info.current_claimer_discord_id && info.claim_expires_at && new Date(info.claim_expires_at) > new Date()) {
            plotLines.push(`**Plot ${n}** — ${priceFormatted} (on hold — being claimed)`);
        } else {
            plotLines.push(`**Plot ${n}** — ${priceFormatted} (available)`);
        }
    }

    const content =
        `🏔️🐧 **BUILDER'S FUND** 🐧🏔️\n\n` +
        `**Current Balance: ${balanceFormatted}**\n\n` +
        `All entry fees and plot sales go directly into the Builder's Fund.\n` +
        `Once the spawn is finished to a certain level, the fund will be distributed back to builders ` +
        `proportional to the percentage of spawn they contributed.\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `**❄️ JOIN THE ICEBERG**\n\n` +
        `To join, you must be **Trusted Penguin** first.\n` +
        `Entry fee: **${formatDonationAmount(ICEBERG_ENTRY_FEE_CENTS)}**\n\n` +
        `\`/iceberg join\` — Start the join process\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `**📊 PLOT PRICING**\n\n` +
        (() => {
            let pricingLines = [];
            let plot = 1;
            while (true) {
                const price = plotPriceCents(plot);
                const nextPrice = plotPriceCents(plot + 1);
                if (price <= ICEBERG_MIN_PLOT_PRICE_CENTS && nextPrice <= ICEBERG_MIN_PLOT_PRICE_CENTS) {
                    pricingLines.push(`Plot ${plot}+: ${formatDonationAmount(ICEBERG_MIN_PLOT_PRICE_CENTS)} each (minimum)`);
                    break;
                }
                pricingLines.push(`Plots ${plot}-${plot + 1}: ${formatDonationAmount(price)} each`);
                plot += 2;
            }
            return pricingLines.join('\n');
        })() + '\n\n' +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `**📋 PLOT COMMANDS**\n\n` +
        `\`/iceberg claimplot [number]\` — Purchase a plot (must be Iceberg member with linked IGN)\n` +
        `\`/iceberg plot [number]\` — Check plot ownership and price\n` +
        `\`/iceberg transfer [number] [user]\` — Transfer your plot to another player\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `**🏘️ PLOT LIST**\n\n` +
        plotLines.join('\n') + '\n\n' +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `**👥 ICEBERG MEMBERS: ${memberCount}**`;

    const recentMessages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const existing = recentMessages?.find(m => m.author.id === guild.client.user.id && m.content.includes('BUILDER\'S FUND'));

    if (existing) {
        await existing.edit({ content, allowedMentions: { parse: [] } });
    } else {
        await channel.send({ content, allowedMentions: { parse: [] } });
    }

    return true;
}

async function updateMembersListChannel(guild) {
    const channel = guild.channels.cache.get(ICEBERG_MEMBERS_CHANNEL_ID) ||
        (await guild.channels.fetch(ICEBERG_MEMBERS_CHANNEL_ID).catch(() => null));

    if (!channel) return false;

    const members = await getAllMembers();

    const content = members.length > 0
        ? `**❄️ ICEBERG MEMBERS**\n\n` +
          members.map((m, i) => {
              const name = m.minecraft_ign || m.discord_display_name || m.discord_username || 'Unknown';
              return `**${i + 1}.** ${name} — <@${m.discord_id}>`;
          }).join('\n')
        : `**❄️ ICEBERG MEMBERS**\n\nNo members yet.`;

    const recentMessages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const existing = recentMessages?.find(m => m.author.id === guild.client.user.id && m.content.includes('ICEBERG MEMBERS'));

    if (existing) {
        await existing.edit({ content, allowedMentions: { parse: [] } });
    } else {
        await channel.send({ content, allowedMentions: { parse: [] } });
    }

    return true;
}

module.exports = {
    addToFund,
    checkExpiredClaims,
    createPendingClaimRequest,
    createPendingJoinRequest,
    getAllMembers,
    getFundBalance,
    getIcebergRole,
    getPlotInfo,
    isIcebergMember,
    isPlotClaimed,
    isTrustedPenguin,
    plotPriceCents,
    processIncomingIcebergPayment,
    transferPlot,
    updateIcebergChannel,
    updateMembersListChannel
};
