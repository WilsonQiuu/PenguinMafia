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
    formatDonationAmount,
    parseDonationAmount
} = require('./donations.js');
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

async function areClaimsEnabled() {
    const rows = await sql`select claims_enabled from iceberg_fund where id = 1 limit 1`;
    return rows[0]?.claims_enabled === true;
}

async function setClaimsEnabled(enabled) {
    await sql`
        update iceberg_fund set claims_enabled = ${enabled}, updated_at = now() where id = 1
    `;
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

async function adjustFund(amountCents) {
    const rows = await sql`
        update iceberg_fund
        set balance = balance + ${amountCents.toString()}::bigint, updated_at = now()
        where id = 1 and balance + ${amountCents.toString()}::bigint >= 0
        returning balance
    `;
    return rows[0]?.balance ?? null;
}

async function addManualIcebergMember(guild, member, amountCents = ICEBERG_ENTRY_FEE_CENTS) {
    let result = {
        added: false,
        newBalance: 0n
    };

    await sql.begin(async transaction => {
        await transaction`
            insert into players (discord_id, discord_username, discord_display_name)
            values (${member.id}, ${member.user.username}, ${member.displayName})
            on conflict (discord_id) do update
            set
                discord_username = excluded.discord_username,
                discord_display_name = excluded.discord_display_name,
                updated_at = now()
        `;

        const insertedRows = await transaction`
            insert into iceberg_members (discord_id)
            values (${member.id})
            on conflict (discord_id) do nothing
            returning discord_id
        `;

        if (insertedRows.length > 0) {
            const balanceRows = await transaction`
                update iceberg_fund
                set balance = balance + ${amountCents.toString()}::bigint, updated_at = now()
                where id = 1
                returning balance
            `;

            result = {
                added: true,
                newBalance: balanceRows[0]?.balance || 0n
            };
            return;
        }

        const balanceRows = await transaction`
            select balance from iceberg_fund where id = 1 limit 1
        `;

        result = {
            added: false,
            newBalance: balanceRows[0]?.balance || 0n
        };
    });

    return result;
}

async function clearPlotOwner(plotNumber) {
    const price = plotPriceCents(plotNumber);
    let result = null;

    await sql.begin(async transaction => {
        const previousRows = await transaction`
            select owner_discord_id, current_claimer_discord_id
            from iceberg_plots
            where plot_number = ${plotNumber}
            limit 1
        `;
        const previous = previousRows[0] || null;

        const plotRows = await transaction`
            insert into iceberg_plots (plot_number, original_price)
            values (${plotNumber}, ${price.toString()}::bigint)
            on conflict (plot_number) do update
            set
                owner_discord_id = null,
                bought_at = null,
                current_claimer_discord_id = null,
                claim_expires_at = null,
                original_price = ${price.toString()}::bigint,
                updated_at = now()
            returning plot_number, original_price
        `;

        const cancelledRows = await transaction`
            update iceberg_payment_requests
            set status = 'cancelled', updated_at = now()
            where purpose = 'claim'
                and plot_number = ${plotNumber}
                and status in ('pending', 'processing')
            returning id
        `;

        result = {
            plot: plotRows[0] || null,
            previousOwnerId: previous?.owner_discord_id || null,
            previousClaimerId: previous?.current_claimer_discord_id || null,
            cancelledRequests: cancelledRows.length
        };
    });

    return result;
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
    await sql.begin(async transaction => {
        await transaction`
            insert into iceberg_plots (plot_number, original_price, current_claimer_discord_id, claim_expires_at)
            values (${plotNumber}, ${price.toString()}::bigint, ${member.id}, now() + interval '5 minutes')
            on conflict (plot_number) do update
            set
                current_claimer_discord_id = ${member.id},
                claim_expires_at = now() + interval '5 minutes',
                updated_at = now()
        `;

        await transaction`
            insert into iceberg_payment_requests (
                guild_id, player_discord_id, player_minecraft_ign,
                payment_bot_user, amount, purpose, plot_number
            ) values (
                ${guild.id}, ${member.id}, ${minecraftIgn},
                ${giveawayPaymentBotUser()}, ${price.toString()}::bigint, 'claim', ${plotNumber}
            )
        `;
    });
}

async function processIncomingIcebergPayment(guild, payment) {
    const paymentPlayer = String(payment.player || '').trim().toLowerCase();

    let paidAmount;
    try {
        const cleanAmount = String(payment.amount || '').replace(/[$,\s]/g, '');
        paidAmount = parseDonationAmount(cleanAmount);
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
        console.log(`Iceberg: No pending request for ${paymentPlayer} (${payment.amount}, acceptable ${acceptableAmount.toString()}) in guild ${guild.id}`);
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

function truncateIcebergName(name, maxLength = 28) {
    const text = String(name || 'Unknown').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

async function upsertIcebergMessage(channel, marker, content) {
    const safeContent = content.length <= 2000
        ? content
        : `${content.slice(0, 1950)}\n\n…trimmed`;
    const recentMessages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    const existing = recentMessages?.find(m =>
        m.author.id === channel.client.user.id &&
        m.content.includes(marker)
    );

    if (existing) {
        await existing.edit({
            content: safeContent,
            allowedMentions: { parse: [] }
        });
        return existing;
    }

    return channel.send({
        content: safeContent,
        allowedMentions: { parse: [] }
    });
}

async function updateIcebergChannel(guild) {
    const channel = guild.channels.cache.get(ICEBERG_CHANNEL_ID) ||
        (await guild.channels.fetch(ICEBERG_CHANNEL_ID).catch(() => null));

    if (!channel) return false;

    const balance = await getFundBalance();
    const balanceFormatted = formatDonationAmount(balance);

    const memberCount = (await sql`select count(*)::int as count from iceberg_members`)[0]?.count || 0;

    const plotLines = [];
    for (let n = 1; n <= 20; n++) {
        const info = await getPlotInfo(n);
        const price = plotPriceCents(n);
        const priceFormatted = formatDonationAmount(price);
        if (!info) {
            plotLines.push(`**${n}.** ${priceFormatted} — 🟢 Available`);
        } else if (info.owner_discord_id) {
            const ownerName = truncateIcebergName(info.minecraft_ign || info.discord_display_name || info.discord_username);
            plotLines.push(`**${n}.** ${formatDonationAmount(info.original_price)} — ✅ ${ownerName}`);
        } else if (info.current_claimer_discord_id && info.claim_expires_at && new Date(info.claim_expires_at) > new Date()) {
            plotLines.push(`**${n}.** ${priceFormatted} — ⏳ On hold`);
        } else {
            plotLines.push(`**${n}.** ${priceFormatted} — 🟢 Available`);
        }
    }

    const summaryContent =
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
        `**📋 PLOT COMMANDS**\n\n` +
        `\`/claimplot [number]\` — Purchase a plot quickly\n` +
        `\`/iceberg claimplot [number]\` — Purchase a plot (must be Iceberg member with linked IGN)\n` +
        `\`/iceberg plot [number]\` — Check plot ownership and price\n` +
        `\`/iceberg transfer [number] [user]\` — Transfer your plot to another player\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `**👥 ICEBERG MEMBERS: ${memberCount}**`;

    const plotContent =
        `🏘️🐧 **ICEBERG PLOT LIST** 🐧🏘️\n\n` +
        `✅ Owned  •  🟢 Available  •  ⏳ Payment hold\n\n` +
        plotLines.join('\n');

    await upsertIcebergMessage(channel, 'BUILDER\'S FUND', summaryContent);
    await upsertIcebergMessage(channel, 'ICEBERG PLOT LIST', plotContent);

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
    adjustFund,
    addManualIcebergMember,
    addToFund,
    areClaimsEnabled,
    checkExpiredClaims,
    clearPlotOwner,
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
    setClaimsEnabled,
    transferPlot,
    updateIcebergChannel,
    updateMembersListChannel
};
