const sql = require('../db.js');
const {
    formatCents
} = require('./donations.js');
const {
    formattedMinecraftIgn,
    linkedAccountLabel,
    playerName
} = require('./payouts.js');
const {
    emitMinecraftEvent,
    minecraftBotStatus,
    payPlayer,
    startMinecraftBot
} = require('../minecraft-bot.js');

const DEFAULT_PAYOUT_CONNECT_TIMEOUT_MS = 120_000;
const PAYOUT_CONNECT_POLL_MS = 1_000;
const MIN_PAYMENT_SPACING_MS = 3_000;

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

function payoutConnectTimeoutMs() {
    const timeoutMs = Number(
        process.env.MINECRAFT_PAYOUT_CONNECT_TIMEOUT_MS ||
        DEFAULT_PAYOUT_CONNECT_TIMEOUT_MS
    );

    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
        throw new Error('MINECRAFT_PAYOUT_CONNECT_TIMEOUT_MS must be between 1000 and 300000.');
    }

    return timeoutMs;
}

function paymentSpacingMs() {
    const spacingMs = Number(
        process.env.MINECRAFT_PAYMENT_SPACING_MS ||
        MIN_PAYMENT_SPACING_MS
    );

    if (!Number.isInteger(spacingMs) || spacingMs < MIN_PAYMENT_SPACING_MS || spacingMs > 60_000) {
        throw new Error(`MINECRAFT_PAYMENT_SPACING_MS must be between ${MIN_PAYMENT_SPACING_MS} and 60000.`);
    }

    return spacingMs;
}

async function waitForPaymentSpacing(lastPaymentAt) {
    if (!lastPaymentAt) {
        return;
    }

    const waitMs = paymentSpacingMs() - (Date.now() - lastPaymentAt);

    if (waitMs > 0) {
        await sleep(waitMs);
    }
}

function formatMinecraftPaymentAmountFromCents(cents) {
    const amountCents = BigInt(cents);
    const whole = amountCents / 100n;
    const decimals = amountCents % 100n;

    if (decimals === 0n) {
        return whole.toString();
    }

    return `${whole}.${decimals.toString().padStart(2, '0')}`;
}

function payoutMinecraftTarget(player) {
    if (!player?.minecraft_ign || !player?.minecraft_edition) {
        return null;
    }

    return formattedMinecraftIgn(player);
}

function commissionPaymentContext(source, extra = {}) {
    return {
        actorTag: 'Commission payout',
        source,
        ...extra
    };
}

async function ensureMinecraftBotConnected(context = {}) {
    const firstStatus = minecraftBotStatus();
    let reconnectRestarted = false;

    if (firstStatus.status === 'connected') {
        return firstStatus;
    }

    if (firstStatus.status === 'stopped' || firstStatus.status === 'reconnecting') {
        startMinecraftBot(context);
    }

    const timeoutMs = payoutConnectTimeoutMs();
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const status = minecraftBotStatus();

        if (status.status === 'connected') {
            return status;
        }

        if (status.status === 'reconnecting' && !reconnectRestarted) {
            startMinecraftBot(context);
            reconnectRestarted = true;
        }

        await sleep(Math.min(PAYOUT_CONNECT_POLL_MS, Math.max(deadline - Date.now(), 0)));
    }

    throw new Error(`Minecraft bot did not connect within ${timeoutMs / 1000} seconds.`);
}

async function creditUnpaidCommission(player, amountCents, reason, db = sql, details = {}) {
    const cents = BigInt(amountCents);

    if (cents <= 0n) {
        return {
            status: 'skipped',
            reason: 'No payout amount.'
        };
    }

    if (!player?.discord_id) {
        return {
            status: 'credit_failed',
            reason: 'Player has no Discord ID.'
        };
    }

    const rows = await db`
        update players
        set
            unpaid_commissions = unpaid_commissions + ${cents.toString()}::bigint,
            updated_at = now()
        where discord_id = ${player.discord_id}
        returning unpaid_commissions
    `;

    if (rows.length === 0) {
        emitMinecraftEvent(
            'Commission Credit Failed',
            `Could not add an unpaid commission balance for ${playerName(player)}.`,
            'error',
            {
                Player: `<@${player.discord_id}>`,
                Amount: formatCents(cents),
                Reason: reason,
                ...details
            }
        );

        return {
            status: 'credit_failed',
            reason: 'Player could not be found in the database.'
        };
    }

    emitMinecraftEvent(
        'Commission Added to Balance',
        `${playerName(player)} could not be paid in Minecraft, so the amount was added to unpaid commissions.`,
        'warning',
        {
            Player: `<@${player.discord_id}>`,
            Amount: formatCents(cents),
            'New unpaid balance': formatCents(rows[0].unpaid_commissions),
            Reason: reason,
            ...details
        }
    );

    return {
        status: 'credited',
        reason,
        newBalanceCents: BigInt(rows[0].unpaid_commissions)
    };
}

async function settleGiveawayPayouts(giveaway, payoutResult, db = sql) {
    const payouts = (payoutResult?.payouts || [])
        .filter(payout => BigInt(payout.amountCents) > 0n);
    const payablePayouts = payouts.filter(payout => payoutMinecraftTarget(payout.player));
    const source = `Giveaway ${giveaway.id}`;
    const context = commissionPaymentContext(source);
    const results = [];
    let connectionError = null;
    let lastPaymentAttemptAt = 0;

    if (payablePayouts.length > 0) {
        try {
            await ensureMinecraftBotConnected(context);
        } catch (error) {
            connectionError = error;
            emitMinecraftEvent(
                'Giveaway Payout Bot Connection Failed',
                'The Minecraft bot could not connect before giveaway payouts.',
                'error',
                {
                    Giveaway: String(giveaway.id),
                    Error: error.message
                }
            );
        }
    }

    for (const payout of payouts) {
        const amountCents = BigInt(payout.amountCents);
        const minecraftName = payoutMinecraftTarget(payout.player);
        const details = {
            Giveaway: String(giveaway.id),
            Host: `<@${giveaway.host_discord_id}>`
        };

        if (!minecraftName) {
            const credited = await creditUnpaidCommission(
                payout.player,
                amountCents,
                'Missing linked Minecraft account or edition.',
                db,
                details
            );

            results.push({
                ...credited,
                payout,
                amountCents,
                minecraftName: null
            });
            continue;
        }

        if (connectionError) {
            const credited = await creditUnpaidCommission(
                payout.player,
                amountCents,
                connectionError.message,
                db,
                details
            );

            results.push({
                ...credited,
                payout,
                amountCents,
                minecraftName
            });
            continue;
        }

        const amount = formatMinecraftPaymentAmountFromCents(amountCents);

        try {
            await waitForPaymentSpacing(lastPaymentAttemptAt);
            lastPaymentAttemptAt = Date.now();
            const payment = await payPlayer(minecraftName, amount, {
                ...context,
                actorId: payout.player.discord_id
            });

            results.push({
                status: 'paid',
                payout,
                amountCents,
                minecraftName,
                response: payment.message
            });
        } catch (error) {
            const credited = await creditUnpaidCommission(
                payout.player,
                amountCents,
                error.message,
                db,
                details
            );

            results.push({
                ...credited,
                payout,
                amountCents,
                minecraftName,
                error: error.message
            });
        }
    }

    const paidTotalCents = results
        .filter(result => result.status === 'paid')
        .reduce((total, result) => total + result.amountCents, 0n);
    const creditedTotalCents = results
        .filter(result => result.status === 'credited')
        .reduce((total, result) => total + result.amountCents, 0n);

    emitMinecraftEvent(
        'Giveaway Payout Settlement Finished',
        'Giveaway payout settlement finished.',
        creditedTotalCents > 0n ? 'warning' : 'success',
        {
            Giveaway: String(giveaway.id),
            Paid: formatCents(paidTotalCents),
            'Added to commissions': formatCents(creditedTotalCents)
        }
    );

    return {
        results,
        paidTotalCents,
        creditedTotalCents
    };
}

async function payOutstandingCommissions(db = sql, context = {}) {
    const rows = await db`
        select
            discord_id,
            discord_username,
            discord_display_name,
            minecraft_ign,
            minecraft_edition,
            unpaid_commissions
        from players
        where unpaid_commissions > 0
        order by unpaid_commissions desc, discord_display_name asc
    `;
    const payableRows = rows.filter(player => payoutMinecraftTarget(player));
    const source = context.source || 'Pay all commissions';
    const paymentContext = commissionPaymentContext(source, context);
    const results = [];
    let connectionError = null;
    let lastPaymentAttemptAt = 0;

    if (payableRows.length > 0) {
        try {
            await ensureMinecraftBotConnected(paymentContext);
        } catch (error) {
            connectionError = error;
            emitMinecraftEvent(
                'Commission Payout Bot Connection Failed',
                'The Minecraft bot could not connect before unpaid commission payouts.',
                'error',
                {
                    Error: error.message
                }
            );
        }
    }

    for (const player of rows) {
        const amountCents = BigInt(player.unpaid_commissions);
        const minecraftName = payoutMinecraftTarget(player);

        if (!minecraftName) {
            results.push({
                status: 'skipped',
                reason: 'Missing linked Minecraft account or edition.',
                player,
                amountCents,
                minecraftName: null
            });
            continue;
        }

        if (connectionError) {
            results.push({
                status: 'failed',
                reason: connectionError.message,
                player,
                amountCents,
                minecraftName
            });
            continue;
        }

        const amount = formatMinecraftPaymentAmountFromCents(amountCents);

        try {
            await waitForPaymentSpacing(lastPaymentAttemptAt);
            lastPaymentAttemptAt = Date.now();
            const payment = await payPlayer(minecraftName, amount, {
                ...paymentContext,
                actorId: player.discord_id
            });
            const updateRows = await db`
                update players
                set
                    unpaid_commissions = greatest(unpaid_commissions - ${amountCents.toString()}::bigint, 0),
                    updated_at = now()
                where discord_id = ${player.discord_id}
                returning unpaid_commissions
            `;

            emitMinecraftEvent(
                'Commission Paid',
                `${playerName(player)} was paid from unpaid commissions.`,
                'success',
                {
                    Player: `<@${player.discord_id}>`,
                    'Minecraft account': linkedAccountLabel(player),
                    Amount: formatCents(amountCents),
                    'Remaining unpaid balance': formatCents(updateRows[0]?.unpaid_commissions || 0),
                    'Server response': payment.message
                }
            );

            results.push({
                status: 'paid',
                player,
                amountCents,
                minecraftName,
                remainingCents: BigInt(updateRows[0]?.unpaid_commissions || 0),
                response: payment.message
            });
        } catch (error) {
            results.push({
                status: 'failed',
                reason: error.message,
                player,
                amountCents,
                minecraftName
            });
        }
    }

    return {
        totalPlayers: rows.length,
        results
    };
}

module.exports = {
    creditUnpaidCommission,
    ensureMinecraftBotConnected,
    formatMinecraftPaymentAmountFromCents,
    payOutstandingCommissions,
    paymentSpacingMs,
    payoutMinecraftTarget,
    settleGiveawayPayouts
};
