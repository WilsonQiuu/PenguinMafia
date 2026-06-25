const sql = require('../db.js');
const {
    formatCents,
    formatDonationAmount
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
const DEFAULT_BUSY_PAYMENT_RETRY_TIMEOUT_MS = 120_000;
const PAYOUT_CONNECT_POLL_MS = 1_000;
const MIN_PAYMENT_SPACING_MS = 3_000;
const BUSY_PAYMENT_PATTERN = /\b(?:payment to .+ is still waiting for confirmation|balance check is still waiting for confirmation)\b/i;

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

function busyPaymentRetryTimeoutMs() {
    const timeoutMs = Number(
        process.env.MINECRAFT_BUSY_PAYMENT_RETRY_TIMEOUT_MS ||
        DEFAULT_BUSY_PAYMENT_RETRY_TIMEOUT_MS
    );

    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
        throw new Error('MINECRAFT_BUSY_PAYMENT_RETRY_TIMEOUT_MS must be between 1000 and 300000.');
    }

    return timeoutMs;
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

function isBusyPaymentError(error) {
    return BUSY_PAYMENT_PATTERN.test(String(error?.message || ''));
}

async function payPlayerAfterBusyWait(player, amount, context = {}) {
    const deadline = Date.now() + busyPaymentRetryTimeoutMs();
    let attempt = 0;

    while (true) {
        attempt += 1;

        try {
            return await payPlayer(player, amount, context);
        } catch (error) {
            if (!isBusyPaymentError(error)) {
                throw error;
            }

            const remainingMs = deadline - Date.now();

            if (remainingMs <= 0) {
                throw error;
            }

            const waitMs = Math.min(paymentSpacingMs(), remainingMs);
            console.log(
                `Payment to ${player} is waiting for another Minecraft payment or balance check. ` +
                `Retrying in ${Math.ceil(waitMs / 1000)} seconds. Attempt ${attempt}.`
            );
            await sleep(waitMs);
        }
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

function payoutLogRecipient(player) {
    if (!player) {
        return 'Unknown player';
    }

    return player.discord_id
        ? `<@${player.discord_id}>`
        : playerName(player);
}

function compactLogLines(lines, maxLength = 950) {
    if (lines.length === 0) {
        return 'None';
    }

    const kept = [];
    let currentLength = 0;

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const nextLength = currentLength + line.length + (kept.length > 0 ? 1 : 0);

        if (nextLength > maxLength) {
            kept.push(`...and ${lines.length - index} more.`);
            break;
        }

        kept.push(line);
        currentLength = nextLength;
    }

    return kept.join('\n');
}

function giveawaySettlementLogDetails(giveaway, payoutResult, results, paidTotalCents, creditedTotalCents) {
    const paidLines = results
        .filter(result => result.status === 'paid')
        .map(result => {
            const player = result.payout?.player;

            return `${payoutLogRecipient(player)} — ${formatCents(result.amountCents)} paid to ${result.minecraftName}`;
        });
    const creditedLines = results
        .filter(result => result.status === 'credited')
        .map(result => {
            const player = result.payout?.player;

            return `${payoutLogRecipient(player)} — ${formatCents(result.amountCents)} added to commissions (${result.reason || result.error || 'payment failed'})`;
        });
    const failedLines = results
        .filter(result => ['credit_failed', 'failed'].includes(result.status))
        .map(result => {
            const player = result.payout?.player || result.player;

            return `${payoutLogRecipient(player)} — ${formatCents(result.amountCents)} not paid (${result.reason || result.error || 'unknown reason'})`;
        });

    return {
        Giveaway: String(giveaway.id),
        Host: `<@${giveaway.host_discord_id}>`,
        Winner: payoutResult?.player?.discord_id
            ? `<@${payoutResult.player.discord_id}>`
            : playerName(payoutResult?.player || {}, 'Unknown winner'),
        'Paid total': formatCents(paidTotalCents),
        'Commission added total': formatCents(creditedTotalCents),
        'Players paid': compactLogLines(paidLines),
        'Added to commissions': compactLogLines(creditedLines),
        Failed: compactLogLines(failedLines)
    };
}

async function fetchPlayerDisplayName(discordId, fallback, db = sql) {
    if (!discordId) {
        return fallback;
    }

    const rows = await db`
        select
            discord_username,
            discord_display_name,
            minecraft_ign
        from players
        where discord_id = ${discordId}
        limit 1
    `;

    return rows[0]
        ? playerName(rows[0], fallback)
        : fallback;
}

async function sendPayoutNotification(guild, discordId, message) {
    if (!discordId) {
        return false;
    }

    const user = guild.client.users.cache.get(discordId) ||
        (await guild.client.users.fetch(discordId).catch(() => null));

    if (!user) {
        return false;
    }

    await user.send({
        content: message,
        allowedMentions: {
            parse: []
        }
    });
    return true;
}

function paymentFailureNotificationMessage(amountCents, minecraftName) {
    return (
        `Your payment of **${formatCents(amountCents)}** to username **${minecraftName}** failed.\n\n` +
        'Please double check your account name and use `/penguinlink` to change the account name if it is wrong.'
    );
}

async function sendPaymentFailureNotification(guild, player, amountCents, minecraftName) {
    if (!guild || !player?.discord_id || !minecraftName) {
        return false;
    }

    const message = paymentFailureNotificationMessage(amountCents, minecraftName);

    return sendPayoutNotification(guild, player.discord_id, message).catch(error => {
        console.log(`Could not DM payment failure notification to ${player.discord_id}: ${error.message}`);
        return false;
    });
}

function payoutNotificationMessage({
    amountCents,
    giveawayAmount,
    hostName,
    winnerName,
    isWinner,
    status,
    reason
}) {
    const verb = status === 'paid' ? 'received' : 'earned';
    const sourceLine = isWinner
        ? `from winning a **${formatDonationAmount(giveawayAmount)}** giveaway hosted by **${hostName}**.`
        : `from your teammate **${winnerName}** winning a **${formatDonationAmount(giveawayAmount)}** giveaway hosted by **${hostName}**.`;
    const creditedLine = status === 'credited'
        ? `\n\nIt was added to your unpaid commissions because ${reason || 'the Minecraft payment could not be sent'}.`
        : '';

    return (
        `You ${verb} **${formatCents(amountCents)}** ${sourceLine}` +
        `${creditedLine}\n\n` +
        'Use `/payoutnotifications off` if you do not want these DMs.'
    );
}

async function recordGiveawayPayoutEarnings(guild, giveaway, payoutResult, results, db = sql) {
    const winnerId = payoutResult?.player?.discord_id || null;
    const winnerName = playerName(payoutResult?.player || {}, 'your teammate');
    const hostName = await fetchPlayerDisplayName(
        giveaway.host_discord_id,
        'the giveaway host',
        db
    );

    for (const result of results) {
        if (!['paid', 'credited'].includes(result.status)) {
            continue;
        }

        const discordId = result.payout?.player?.discord_id;
        const amountCents = BigInt(result.amountCents || 0);

        if (!discordId || amountCents <= 0n) {
            continue;
        }

        const isWinner = discordId === winnerId;
        const rows = isWinner
            ? await db`
                update players
                set
                    personal_production = personal_production + ${amountCents.toString()}::bigint,
                    updated_at = now()
                where discord_id = ${discordId}
                returning payout_notifications_enabled
            `
            : await db`
                update players
                set
                    team_overrides = team_overrides + ${amountCents.toString()}::bigint,
                    updated_at = now()
                where discord_id = ${discordId}
                returning payout_notifications_enabled
            `;
        const player = rows[0];

        if (!player?.payout_notifications_enabled) {
            continue;
        }

        const message = payoutNotificationMessage({
            amountCents,
            giveawayAmount: BigInt(giveaway.amount),
            hostName,
            winnerName,
            isWinner,
            status: result.status,
            reason: result.reason || result.error
        });

        await sendPayoutNotification(guild, discordId, message).catch(error => {
            console.log(`Could not DM payout notification to ${discordId}: ${error.message}`);
            return false;
        });
    }
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
    const {
        suppressCommissionLog = false,
        ...logDetails
    } = details;

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
        if (!suppressCommissionLog) {
            emitMinecraftEvent(
                'Commission Credit Failed',
                `Could not add an unpaid commission balance for ${playerName(player)}.`,
                'error',
                {
                    Player: `<@${player.discord_id}>`,
                    Amount: formatCents(cents),
                    Reason: reason,
                    ...logDetails
                }
            );
        }

        return {
            status: 'credit_failed',
            reason: 'Player could not be found in the database.'
        };
    }

    if (!suppressCommissionLog) {
        emitMinecraftEvent(
            'Commission Added to Balance',
            `${playerName(player)} could not be paid in Minecraft, so the amount was added to unpaid commissions.`,
            'warning',
            {
                Player: `<@${player.discord_id}>`,
                Amount: formatCents(cents),
                'New unpaid balance': formatCents(rows[0].unpaid_commissions),
                Reason: reason,
                ...logDetails
            }
        );
    }

    return {
        status: 'credited',
        reason,
        newBalanceCents: BigInt(rows[0].unpaid_commissions)
    };
}

async function settleGiveawayPayouts(guild, giveaway, payoutResult, db = sql) {
    const payouts = (payoutResult?.payouts || [])
        .filter(payout => BigInt(payout.amountCents) > 0n);
    const payablePayouts = payouts.filter(payout => payoutMinecraftTarget(payout.player));
    const source = `Giveaway ${giveaway.id}`;
    const context = commissionPaymentContext(source, {
        suppressPaymentLog: true
    });
    const results = [];
    let connectionError = null;
    let lastPaymentAttemptAt = 0;

    if (payablePayouts.length > 0) {
        try {
            await ensureMinecraftBotConnected(context);
        } catch (error) {
            connectionError = error;
            console.error(`Minecraft bot could not connect before giveaway payout ${giveaway.id}: ${error.message}`);
        }
    }

    for (const payout of payouts) {
        const amountCents = BigInt(payout.amountCents);
        const minecraftName = payoutMinecraftTarget(payout.player);
        const details = {
            Giveaway: String(giveaway.id),
            Host: `<@${giveaway.host_discord_id}>`,
            suppressCommissionLog: true
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
            const payment = await payPlayerAfterBusyWait(minecraftName, amount, {
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
            if (error.paymentAttempted !== false) {
                await sendPaymentFailureNotification(
                    guild,
                    payout.player,
                    amountCents,
                    minecraftName
                );
            }

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

    await recordGiveawayPayoutEarnings(guild, giveaway, payoutResult, results, db);

    emitMinecraftEvent(
        'Giveaway Payout Settlement Finished',
        'Giveaway payout settlement finished.',
        creditedTotalCents > 0n ? 'warning' : 'success',
        {
            ...giveawaySettlementLogDetails(
                giveaway,
                payoutResult,
                results,
                paidTotalCents,
                creditedTotalCents
            )
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
            const payment = await payPlayerAfterBusyWait(minecraftName, amount, {
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
            if (error.paymentAttempted !== false) {
                await sendPaymentFailureNotification(
                    context.guild,
                    player,
                    amountCents,
                    minecraftName
                );
            }

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
