const sql = require('../db.js');
const {
    formatCents,
    formatDonationAmount
} = require('./donations.js');
const {
    calculatePayout,
    formattedMinecraftIgn,
    linkedAccountLabel,
    playerName
} = require('./payouts.js');
const {
    scheduledGiveawayPayoutsPaused
} = require('./scheduledGiveawayPayouts.js');
const {
    checkBalance,
    emitMinecraftEvent,
    minecraftBotStatus,
    payPlayer,
    startMinecraftBot
} = require('../minecraft-bot.js');
const {
    dismissRow
} = require('./dismissible.js');

const DEFAULT_PAYOUT_CONNECT_TIMEOUT_MS = 120_000;
const DEFAULT_BUSY_PAYMENT_RETRY_TIMEOUT_MS = 120_000;
const PAYOUT_CONNECT_POLL_MS = 1_000;
const MIN_PAYMENT_SPACING_MS = 250;
const BUSY_PAYMENT_PATTERN = /\b(?:payment to .+ is still waiting for confirmation|balance check is still waiting for confirmation)\b/i;
const TERMINAL_GIVEAWAY_PAYOUT_STATUSES = ['paid', 'credited', 'credit_failed', 'failed', 'skipped', 'manual_review'];
const activeGiveawayPayoutProcessors = new Set();
const activeCommissionPayoutProcessors = new Set();

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

function jsonb(value) {
    const normalized = JSON.parse(JSON.stringify(value, (_, nestedValue) => {
        return typeof nestedValue === 'bigint'
            ? nestedValue.toString()
            : nestedValue;
    }));

    return sql.json(normalized);
}

function parseStoredJson(value, fallback = {}) {
    if (typeof value !== 'string') {
        return value || fallback;
    }

    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function serializePayout(payout) {
    return {
        ...payout,
        amountCents: BigInt(payout.amountCents).toString(),
        rateBasisPoints: BigInt(payout.rateBasisPoints || 0).toString()
    };
}

function serializePayoutResult(payoutResult) {
    return {
        ...payoutResult,
        totalAmountCents: BigInt(payoutResult.totalAmountCents || 0).toString(),
        totalPaidCents: BigInt(payoutResult.totalPaidCents || 0).toString(),
        payouts: (payoutResult.payouts || []).map(serializePayout)
    };
}

function hydratePayoutPayload(payload = {}) {
    const parsedPayload = parseStoredJson(payload);

    return {
        ...parsedPayload,
        amountCents: BigInt(parsedPayload.amountCents || 0),
        rateBasisPoints: BigInt(parsedPayload.rateBasisPoints || 0),
        player: parsedPayload.player || {}
    };
}

function jobToResult(job) {
    const status = job.status;
    const payout = hydratePayoutPayload(job.payout_payload || {});
    payout.player = {
        ...payout.player,
        discord_id: payout.player?.discord_id || job.recipient_discord_id
    };

    return {
        status,
        payout,
        amountCents: BigInt(job.amount_cents || 0),
        minecraftName: job.minecraft_name || null,
        response: job.response || null,
        reason: job.reason || null,
        error: job.error || null,
        player: payout.player
    };
}

function batchPayoutResult(batch, jobs) {
    const payoutResult = parseStoredJson(batch?.payout_result);

    return {
        ...payoutResult,
        player: {
            ...(payoutResult.player || {}),
            discord_id: payoutResult.player?.discord_id || batch?.winner_discord_id || null
        },
        payouts: jobs.map(job => hydratePayoutPayload(job.payout_payload || {})),
        totalAmountCents: BigInt(payoutResult.totalAmountCents || 0),
        totalPaidCents: BigInt(payoutResult.totalPaidCents || 0),
        stoppedAtFinalRank: Boolean(payoutResult.stoppedAtFinalRank)
    };
}

function balanceAmountText(balance) {
    return balance?.amount !== undefined && balance?.amount !== null
        ? balance.amount.toString()
        : null;
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
        .filter(result => ['credit_failed', 'failed', 'manual_review'].includes(result.status))
        .map(result => {
            const player = result.payout?.player || result.player;
            const action = result.status === 'manual_review'
                ? 'needs manual review'
                : 'not paid';

            return `${payoutLogRecipient(player)} — ${formatCents(result.amountCents)} ${action} (${result.reason || result.error || 'unknown reason'})`;
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
        components: [dismissRow(discordId)],
        allowedMentions: {
            parse: []
        }
    });
    return true;
}

function paymentFailureNotificationMessage(amountCents, minecraftName, reason, commissionAction) {
    const reasonLine = reason
        ? `\n\nServer response: ${reason}`
        : '';

    return (
        `You still earned **${formatCents(amountCents)}**, but the Minecraft payment to username **${minecraftName}** failed.\n\n` +
        `That amount was ${commissionAction} your unpaid commissions so it can be paid later.` +
        `${reasonLine}\n\n` +
        'Please double check your account name and use `/penguinlink` to change the account name if it is wrong.'
    );
}

async function sendPaymentFailureNotification(guild, player, amountCents, minecraftName, reason, commissionAction = 'added to') {
    if (!guild || !player?.discord_id || !minecraftName) {
        return false;
    }

    const message = paymentFailureNotificationMessage(amountCents, minecraftName, reason, commissionAction);

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

    if (firstStatus.status === 'frozen') {
        throw new Error('Minecraft bot connections are frozen. Use /bot start to resume Minecraft payments.');
    }

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

        if (status.status === 'frozen') {
            throw new Error('Minecraft bot connections are frozen. Use /bot start to resume Minecraft payments.');
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

async function enqueueGiveawayPayouts(guild, giveaway, payoutResult, db = sql) {
    const payouts = (payoutResult?.payouts || [])
        .filter(payout => BigInt(payout.amountCents) > 0n);

    if (payouts.length === 0) {
        return {
            enqueued: 0
        };
    }

    await db.begin(async tx => {
        await tx`
            insert into giveaway_payout_batches (
                giveaway_id,
                guild_id,
                winner_discord_id,
                payout_result,
                status,
                updated_at
            )
            values (
                ${giveaway.id},
                ${guild.id},
                ${payoutResult.player.discord_id},
                ${jsonb(serializePayoutResult(payoutResult))},
                'pending',
                now()
            )
            on conflict (giveaway_id) do update
            set
                guild_id = excluded.guild_id,
                winner_discord_id = excluded.winner_discord_id,
                payout_result = excluded.payout_result,
                updated_at = now()
            where giveaway_payout_batches.status <> 'finished'
        `;

        for (const payout of payouts) {
            const player = payout.player || {};

            if (!player.discord_id) {
                continue;
            }

            await tx`
                insert into giveaway_payout_jobs (
                    giveaway_id,
                    guild_id,
                    recipient_discord_id,
                    minecraft_name,
                    amount_cents,
                    payout_payload,
                    is_winner,
                    status,
                    updated_at
                )
                values (
                    ${giveaway.id},
                    ${guild.id},
                    ${player.discord_id},
                    ${payoutMinecraftTarget(player)},
                    ${BigInt(payout.amountCents).toString()}::bigint,
                    ${jsonb(serializePayout(payout))},
                    ${player.discord_id === payoutResult.player.discord_id},
                    'pending',
                    now()
                )
                on conflict (giveaway_id, recipient_discord_id) do nothing
            `;
        }
    });

    return {
        enqueued: payouts.length
    };
}

async function enqueueMissingEndedGiveawayPayouts(guild, db = sql) {
    const rows = await db`
        select giveaway.*
        from giveaways giveaway
        left join giveaway_payout_batches batch
            on batch.giveaway_id = giveaway.id
        where giveaway.guild_id = ${guild.id}
            and giveaway.status = 'ended'
            and giveaway.winner_discord_id is not null
            and giveaway.cleanup_due_at is null
            and batch.giveaway_id is null
        order by giveaway.ended_at asc nulls last, giveaway.id asc
        limit 20
    `;
    let enqueued = 0;

    for (const giveaway of rows) {
        const payoutResult = await calculatePayout(
            giveaway.winner_discord_id,
            BigInt(giveaway.amount),
            process.env.DON_DISCORD_ID,
            db
        );

        if (!payoutResult) {
            continue;
        }

        await enqueueGiveawayPayouts(guild, giveaway, payoutResult, db);
        enqueued++;
    }

    return enqueued;
}

async function claimNextGiveawayPayoutJob(guildId, db = sql) {
    return db.begin(async tx => {
        const rows = await tx`
            with next_job as (
                select id
                from giveaway_payout_jobs
                where guild_id = ${guildId}
                    and status = 'pending'
                order by created_at asc, id asc
                limit 1
                for update skip locked
            )
            update giveaway_payout_jobs job
            set
                status = 'processing',
                attempts = attempts + 1,
                processing_started_at = now(),
                reason = null,
                error = null,
                updated_at = now()
            from next_job
            where job.id = next_job.id
            returning job.*
        `;

        return rows[0] || null;
    });
}

async function markGiveawayPayoutJobPending(job, reason, db = sql) {
    await db`
        update giveaway_payout_jobs
        set
            status = 'pending',
            reason = ${reason},
            updated_at = now()
        where id = ${job.id}
    `;
}

async function markGiveawayPayoutJobPaid(job, payment, db = sql, details = {}) {
    const rows = await db`
        update giveaway_payout_jobs
        set
            status = 'paid',
            response = ${payment.message},
            balance_after = coalesce(${details.balanceAfter || null}, balance_after),
            paid_at = now(),
            updated_at = now()
        where id = ${job.id}
        returning *
    `;

    return rows[0];
}

async function markGiveawayPayoutJobCredited(guild, job, reason, db = sql) {
    const payout = hydratePayoutPayload(job.payout_payload || {});
    const details = {
        Giveaway: String(job.giveaway_id),
        suppressCommissionLog: true
    };

    return db.begin(async tx => {
        const lockedRows = await tx`
            select *
            from giveaway_payout_jobs
            where id = ${job.id}
            for update
        `;
        const lockedJob = lockedRows[0];

        if (!lockedJob || TERMINAL_GIVEAWAY_PAYOUT_STATUSES.includes(lockedJob.status)) {
            return lockedJob;
        }

        const credited = await creditUnpaidCommission(
            payout.player,
            BigInt(lockedJob.amount_cents),
            reason,
            tx,
            details
        );
        const status = credited.status === 'credited' ? 'credited' : credited.status;
        const rows = await tx`
            update giveaway_payout_jobs
            set
                status = ${status},
                reason = ${credited.reason || reason},
                error = ${reason},
                credited_at = case when ${status} = 'credited' then now() else credited_at end,
                updated_at = now()
            where id = ${job.id}
            returning *
        `;

        return rows[0];
    }).then(async updatedJob => {
        if (updatedJob?.status === 'credited' && updatedJob.minecraft_name) {
            await sendPaymentFailureNotification(
                guild,
                payout.player,
                BigInt(updatedJob.amount_cents),
                updatedJob.minecraft_name,
                reason,
                'added to'
            );
        }

        return updatedJob;
    });
}

async function markGiveawayPayoutJobManualReview(job, reason, db = sql, details = {}) {
    const rows = await db`
        update giveaway_payout_jobs
        set
            status = 'manual_review',
            reason = ${reason},
            balance_after = coalesce(${details.balanceAfter || null}, balance_after),
            updated_at = now()
        where id = ${job.id}
        returning *
    `;

    return rows[0];
}

async function updateGiveawayPayoutJobStage(jobId, stage, details, db = sql) {
    if (stage === 'balance_before') {
        await db`
            update giveaway_payout_jobs
            set
                balance_before = ${balanceAmountText(details.balance)},
                updated_at = now()
            where id = ${jobId}
        `;
        return;
    }

    if (stage === 'command_sent') {
        await db`
            update giveaway_payout_jobs
            set
                command_sent_at = now(),
                updated_at = now()
            where id = ${jobId}
        `;
        return;
    }

    if (stage === 'balance_after') {
        await db`
            update giveaway_payout_jobs
            set
                balance_after = ${balanceAmountText(details.balance)},
                updated_at = now()
            where id = ${jobId}
        `;
    }
}

async function recordGiveawayPayoutJobEarnings(guild, job, db = sql) {
    if (!['paid', 'credited'].includes(job?.status)) {
        return;
    }

    const result = jobToResult(job);
    const payout = result.payout;
    const discordId = payout.player?.discord_id;
    const amountCents = BigInt(job.amount_cents || 0);

    if (!discordId || amountCents <= 0n) {
        return;
    }

    const recordRows = await db.begin(async tx => {
        const lockedRows = await tx`
            select
                job.*,
                giveaway.host_discord_id,
                giveaway.winner_discord_id,
                giveaway.amount as giveaway_amount
            from giveaway_payout_jobs job
            join giveaways giveaway
                on giveaway.id = job.giveaway_id
            where job.id = ${job.id}
            for update of job
        `;
        const lockedJob = lockedRows[0];

        if (!lockedJob || lockedJob.earnings_recorded_at) {
            return [];
        }

        const isWinner = lockedJob.recipient_discord_id === lockedJob.winner_discord_id;
        const rows = isWinner
            ? await tx`
                update players
                set
                    personal_production = personal_production + ${amountCents.toString()}::bigint,
                    updated_at = now()
                where discord_id = ${discordId}
                returning payout_notifications_enabled
            `
            : await tx`
                update players
                set
                    team_overrides = team_overrides + ${amountCents.toString()}::bigint,
                    updated_at = now()
                where discord_id = ${discordId}
                returning payout_notifications_enabled
            `;
        const player = rows[0];

        await tx`
            update giveaway_payout_jobs
            set
                earnings_recorded_at = now(),
                notification_sent_at = case
                    when ${Boolean(player?.payout_notifications_enabled)} then now()
                    else notification_sent_at
                end,
                updated_at = now()
            where id = ${job.id}
        `;

        return [{
            player,
            isWinner,
            hostDiscordId: lockedJob.host_discord_id,
            winnerDiscordId: lockedJob.winner_discord_id,
            giveawayAmount: lockedJob.giveaway_amount
        }];
    });

    const record = recordRows[0];

    if (!record?.player?.payout_notifications_enabled) {
        return;
    }

    const hostName = await fetchPlayerDisplayName(record.hostDiscordId, 'the giveaway host', db);
    const winnerName = await fetchPlayerDisplayName(record.winnerDiscordId, 'your teammate', db);
    const message = payoutNotificationMessage({
        amountCents,
        giveawayAmount: BigInt(record.giveawayAmount || 0),
        hostName,
        winnerName,
        isWinner: record.isWinner,
        status: job.status,
        reason: job.reason || job.error
    });

    await sendPayoutNotification(guild, discordId, message).catch(error => {
        console.log(`Could not DM payout notification to ${discordId}: ${error.message}`);
        return false;
    });
}

async function recoverStaleGiveawayPayoutJobs(guild, db = sql) {
    const rows = await db`
        select *
        from giveaway_payout_jobs
        where guild_id = ${guild.id}
            and status = 'processing'
            and updated_at < now() - interval '90 seconds'
        order by updated_at asc
    `;

    for (const job of rows) {
        if (!job.command_sent_at || !job.balance_before) {
            await markGiveawayPayoutJobPending(job, 'Recovered after restart before payment command was sent.', db);
            continue;
        }

        try {
            await ensureMinecraftBotConnected(commissionPaymentContext(`Recover giveaway payout ${job.giveaway_id}`));
            const balance = await checkBalance({
                actorTag: 'Commission payout recovery',
                source: `Recover giveaway payout ${job.giveaway_id}`
            });
            const beforeBalance = BigInt(job.balance_before);
            const currentBalance = BigInt(balance.amount);
            const expectedDecrease = BigInt(job.amount_cents) / 100n;

            if (expectedDecrease > 0n && currentBalance <= beforeBalance - expectedDecrease) {
                const paidJob = await markGiveawayPayoutJobPaid(
                    job,
                    {
                        message: 'Recovered after restart: bot balance decreased after the payment command was sent.'
                    },
                    db,
                    {
                        balanceAfter: currentBalance.toString()
                    }
                );

                await recordGiveawayPayoutJobEarnings(guild, paidJob, db);
            } else {
                await markGiveawayPayoutJobManualReview(
                    job,
                    'Recovered after restart after the payment command was sent, but no balance decrease was detected. The bot did not retry automatically to avoid a duplicate payment.',
                    db,
                    {
                        balanceAfter: currentBalance.toString()
                    }
                );
            }
        } catch (error) {
            console.error(`Could not recover stale giveaway payout job ${job.id}:`);
            console.error(error);
        }
    }
}

async function processGiveawayPayoutJob(guild, job, db = sql) {
    const payout = hydratePayoutPayload(job.payout_payload || {});
    const minecraftName = job.minecraft_name;
    const amountCents = BigInt(job.amount_cents);

    if (!minecraftName) {
        const creditedJob = await markGiveawayPayoutJobCredited(
            guild,
            job,
            'Missing linked Minecraft account or edition.',
            db
        );
        await recordGiveawayPayoutJobEarnings(guild, creditedJob, db);
        return {
            retryLater: false
        };
    }

    const amount = formatMinecraftPaymentAmountFromCents(amountCents);
    const context = commissionPaymentContext(`Giveaway ${job.giveaway_id}`, {
        suppressPaymentLog: true,
        actorId: job.recipient_discord_id,
        onPaymentStage: (stage, details) => updateGiveawayPayoutJobStage(job.id, stage, details, db)
    });

    try {
        await ensureMinecraftBotConnected(context);
    } catch (error) {
        await markGiveawayPayoutJobPending(job, error.message, db);
        return {
            retryLater: true
        };
    }

    try {
        const payment = await payPlayerAfterBusyWait(minecraftName, amount, context);
        const paidJob = await markGiveawayPayoutJobPaid(job, payment, db, {
            balanceAfter: balanceAmountText(payment.balanceAfter)
        });

        await recordGiveawayPayoutJobEarnings(guild, paidJob, db);
        return {
            retryLater: false
        };
    } catch (error) {
        if (error.paymentAttempted === false || isBusyPaymentError(error)) {
            await markGiveawayPayoutJobPending(job, error.message, db);
            return {
                retryLater: true
            };
        }

        const creditedJob = await markGiveawayPayoutJobCredited(guild, job, error.message, db);
        await recordGiveawayPayoutJobEarnings(guild, creditedJob, db);
        return {
            retryLater: false
        };
    }
}

async function finalizeCompletedGiveawayPayoutBatches(guild, db = sql) {
    const batches = await db`
        select batch.*
        from giveaway_payout_batches batch
        where batch.guild_id = ${guild.id}
            and batch.status <> 'finished'
            and not exists (
                select 1
                from giveaway_payout_jobs job
                where job.giveaway_id = batch.giveaway_id
                    and job.status not in ('paid', 'credited', 'credit_failed', 'failed', 'skipped', 'manual_review')
            )
    `;

    for (const batch of batches) {
        const giveawayRows = await db`
            select *
            from giveaways
            where id = ${batch.giveaway_id}
            limit 1
        `;
        const giveaway = giveawayRows[0];

        if (!giveaway) {
            continue;
        }

        const jobs = await db`
            select *
            from giveaway_payout_jobs
            where giveaway_id = ${batch.giveaway_id}
            order by id asc
        `;
        const results = jobs.map(jobToResult);
        const payoutResult = batchPayoutResult(batch, jobs);
        const paidTotalCents = results
            .filter(result => result.status === 'paid')
            .reduce((total, result) => total + result.amountCents, 0n);
        const creditedTotalCents = results
            .filter(result => result.status === 'credited')
            .reduce((total, result) => total + result.amountCents, 0n);
        const hasPayoutIssue = creditedTotalCents > 0n ||
            results.some(result => ['credit_failed', 'failed', 'manual_review'].includes(result.status));

        emitMinecraftEvent(
            'Giveaway Payout Settlement Finished',
            'Giveaway payout settlement finished.',
            hasPayoutIssue ? 'warning' : 'success',
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

        await db`
            update giveaway_payout_batches
            set
                status = 'finished',
                finished_at = now(),
                log_sent_at = now(),
                updated_at = now()
            where giveaway_id = ${batch.giveaway_id}
        `;
    }
}

async function processPendingGiveawayPayoutsForGuild(guild, db = sql) {
    if (activeGiveawayPayoutProcessors.has(guild.id)) {
        return {
            processed: 0,
            skipped: true
        };
    }

    activeGiveawayPayoutProcessors.add(guild.id);

    try {
        await enqueueMissingEndedGiveawayPayouts(guild, db);
        await recoverStaleGiveawayPayoutJobs(guild, db);

        let processed = 0;

        while (true) {
            const job = await claimNextGiveawayPayoutJob(guild.id, db);

            if (!job) {
                break;
            }

            const result = await processGiveawayPayoutJob(guild, job, db);
            processed++;

            await finalizeCompletedGiveawayPayoutBatches(guild, db);

            if (result.retryLater) {
                break;
            }
        }

        await finalizeCompletedGiveawayPayoutBatches(guild, db);

        return {
            processed
        };
    } finally {
        activeGiveawayPayoutProcessors.delete(guild.id);
    }
}

async function settleGiveawayPayouts(guild, giveaway, payoutResult, db = sql) {
    await enqueueGiveawayPayouts(guild, giveaway, payoutResult, db);

    return processPendingGiveawayPayoutsForGuild(guild, db);
}

function commissionJobToResult(job, player = {}) {
    return {
        jobId: job.id,
        status: job.status,
        reason: job.reason || job.error || null,
        response: job.response || null,
        player: {
            ...player,
            discord_id: job.recipient_discord_id
        },
        amountCents: BigInt(job.amount_cents || 0),
        minecraftName: job.minecraft_name || payoutMinecraftTarget(player),
        remainingCents: player.unpaid_commissions !== undefined && player.unpaid_commissions !== null
            ? BigInt(player.unpaid_commissions)
            : undefined
    };
}

async function enqueueCommissionPayoutJobs(guild, db = sql) {
    if (!guild?.id) {
        throw new Error('A Discord guild is required to enqueue commission payout jobs.');
    }

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
    const skipped = [];
    let enqueued = 0;
    let alreadyQueued = 0;

    for (const player of rows) {
        const amountCents = BigInt(player.unpaid_commissions);
        const minecraftName = payoutMinecraftTarget(player);

        if (!minecraftName) {
            skipped.push({
                status: 'skipped',
                reason: 'Missing linked Minecraft account or edition.',
                player,
                amountCents,
                minecraftName: null
            });
            continue;
        }

        const insertedRows = await db`
            insert into commission_payout_jobs (
                guild_id,
                recipient_discord_id,
                minecraft_name,
                amount_cents,
                status,
                updated_at
            )
            values (
                ${guild.id},
                ${player.discord_id},
                ${minecraftName},
                ${amountCents.toString()}::bigint,
                'pending',
                now()
            )
            on conflict do nothing
            returning *
        `;

        if (insertedRows.length > 0) {
            enqueued++;
        } else {
            alreadyQueued++;
        }
    }

    return {
        totalPlayers: rows.length,
        skipped,
        enqueued,
        alreadyQueued
    };
}

async function claimNextCommissionPayoutJob(guildId, db = sql) {
    return db.begin(async tx => {
        const rows = await tx`
            with next_job as (
                select id
                from commission_payout_jobs
                where guild_id = ${guildId}
                    and status = 'pending'
                order by created_at asc, id asc
                limit 1
                for update skip locked
            )
            update commission_payout_jobs job
            set
                status = 'processing',
                attempts = attempts + 1,
                processing_started_at = now(),
                reason = null,
                error = null,
                updated_at = now()
            from next_job
            where job.id = next_job.id
            returning job.*
        `;

        return rows[0] || null;
    });
}

async function markCommissionPayoutJobPending(job, reason, db = sql) {
    const rows = await db`
        update commission_payout_jobs
        set
            status = 'pending',
            reason = ${reason},
            updated_at = now()
        where id = ${job.id}
        returning *
    `;

    return rows[0];
}

async function markCommissionPayoutJobPaid(job, payment, db = sql, details = {}) {
    const rows = await db`
        update commission_payout_jobs
        set
            status = 'paid',
            response = ${payment.message},
            balance_after = coalesce(${details.balanceAfter || null}, balance_after),
            paid_at = now(),
            updated_at = now()
        where id = ${job.id}
        returning *
    `;

    return rows[0];
}

async function markCommissionPayoutJobFailed(job, status, reason, db = sql, details = {}) {
    const rows = await db`
        update commission_payout_jobs
        set
            status = ${status},
            reason = ${reason},
            error = ${details.error || reason},
            balance_after = coalesce(${details.balanceAfter || null}, balance_after),
            updated_at = now()
        where id = ${job.id}
        returning *
    `;

    return rows[0];
}

async function updateCommissionPayoutJobStage(jobId, stage, details, db = sql) {
    if (stage === 'balance_before') {
        await db`
            update commission_payout_jobs
            set
                balance_before = ${balanceAmountText(details.balance)},
                updated_at = now()
            where id = ${jobId}
        `;
        return;
    }

    if (stage === 'command_sent') {
        await db`
            update commission_payout_jobs
            set
                command_sent_at = now(),
                updated_at = now()
            where id = ${jobId}
        `;
        return;
    }

    if (stage === 'balance_after') {
        await db`
            update commission_payout_jobs
            set
                balance_after = ${balanceAmountText(details.balance)},
                updated_at = now()
            where id = ${jobId}
        `;
    }
}

async function fetchCommissionPayoutPlayer(discordId, db = sql) {
    const rows = await db`
        select
            discord_id,
            discord_username,
            discord_display_name,
            minecraft_ign,
            minecraft_edition,
            unpaid_commissions
        from players
        where discord_id = ${discordId}
        limit 1
    `;

    return rows[0] || null;
}

async function updateCommissionPayoutJobMinecraftName(job, minecraftName, db = sql) {
    if (job.minecraft_name === minecraftName) {
        return job;
    }

    const rows = await db`
        update commission_payout_jobs
        set
            minecraft_name = ${minecraftName},
            updated_at = now()
        where id = ${job.id}
        returning *
    `;

    return rows[0];
}

async function deductPaidCommissionJob(guild, job, db = sql) {
    const transactionRows = await db.begin(async tx => {
        const jobRows = await tx`
            select *
            from commission_payout_jobs
            where id = ${job.id}
            for update
        `;
        const lockedJob = jobRows[0];

        if (!lockedJob || lockedJob.status !== 'paid') {
            return [];
        }

        const playerRows = await tx`
            select
                discord_id,
                discord_username,
                discord_display_name,
                minecraft_ign,
                minecraft_edition,
                unpaid_commissions
            from players
            where discord_id = ${lockedJob.recipient_discord_id}
            for update
        `;
        const player = playerRows[0];

        if (!player) {
            return [{
                job: lockedJob,
                player: {
                    discord_id: lockedJob.recipient_discord_id
                },
                deducted: false
            }];
        }

        if (lockedJob.deducted_at) {
            return [{
                job: lockedJob,
                player,
                deducted: false
            }];
        }

        const amountCents = BigInt(lockedJob.amount_cents);
        const updatedPlayers = await tx`
            update players
            set
                unpaid_commissions = greatest(unpaid_commissions - ${amountCents.toString()}::bigint, 0),
                updated_at = now()
            where discord_id = ${lockedJob.recipient_discord_id}
            returning
                discord_id,
                discord_username,
                discord_display_name,
                minecraft_ign,
                minecraft_edition,
                unpaid_commissions
        `;
        const updatedJobs = await tx`
            update commission_payout_jobs
            set
                deducted_at = now(),
                updated_at = now()
            where id = ${lockedJob.id}
            returning *
        `;

        return [{
            job: updatedJobs[0],
            player: updatedPlayers[0],
            deducted: true
        }];
    });

    const transaction = transactionRows[0];

    if (!transaction) {
        return null;
    }

    const result = commissionJobToResult(transaction.job, transaction.player);

    if (transaction.deducted) {
        emitMinecraftEvent(
            'Commission Paid',
            `${playerName(transaction.player)} was paid from unpaid commissions.`,
            'success',
            {
                Player: `<@${transaction.job.recipient_discord_id}>`,
                'Minecraft account': transaction.job.minecraft_name || linkedAccountLabel(transaction.player),
                Amount: formatCents(result.amountCents),
                'Remaining unpaid balance': formatCents(transaction.player.unpaid_commissions || 0),
                'Server response': transaction.job.response || 'Payment confirmed by balance recovery.'
            }
        );
    }

    return result;
}

async function recoverStaleCommissionPayoutJobs(guild, db = sql) {
    const rows = await db`
        select *
        from commission_payout_jobs
        where guild_id = ${guild.id}
            and status = 'processing'
            and updated_at < now() - interval '90 seconds'
        order by updated_at asc
    `;
    const results = [];

    for (const job of rows) {
        if (!job.command_sent_at || !job.balance_before) {
            const pendingJob = await markCommissionPayoutJobPending(
                job,
                'Recovered after restart before payment command was sent.',
                db
            );
            const player = await fetchCommissionPayoutPlayer(job.recipient_discord_id, db);
            results.push(commissionJobToResult(pendingJob, player || {}));
            continue;
        }

        try {
            await ensureMinecraftBotConnected(commissionPaymentContext(`Recover commission payout ${job.id}`));
            const balance = await checkBalance({
                actorTag: 'Commission payout recovery',
                source: `Recover commission payout ${job.id}`
            });
            const beforeBalance = BigInt(job.balance_before);
            const currentBalance = BigInt(balance.amount);
            const expectedDecrease = BigInt(job.amount_cents) / 100n;

            if (expectedDecrease > 0n && currentBalance <= beforeBalance - expectedDecrease) {
                const paidJob = await markCommissionPayoutJobPaid(
                    job,
                    {
                        message: 'Recovered after restart: bot balance decreased after the payment command was sent.'
                    },
                    db,
                    {
                        balanceAfter: currentBalance.toString()
                    }
                );
                const result = await deductPaidCommissionJob(guild, paidJob, db);

                if (result) {
                    results.push(result);
                }
            } else {
                const reviewJob = await markCommissionPayoutJobFailed(
                    job,
                    'manual_review',
                    'Recovered after restart after the payment command was sent, but no balance decrease was detected. The bot did not retry automatically to avoid a duplicate payment.',
                    db,
                    {
                        balanceAfter: currentBalance.toString()
                    }
                );
                const player = await fetchCommissionPayoutPlayer(job.recipient_discord_id, db);
                results.push(commissionJobToResult(reviewJob, player || {}));
            }
        } catch (error) {
            console.error(`Could not recover stale commission payout job ${job.id}:`);
            console.error(error);
        }
    }

    return results;
}

async function deductUndeductedPaidCommissionJobs(guild, db = sql) {
    const rows = await db`
        select *
        from commission_payout_jobs
        where guild_id = ${guild.id}
            and status = 'paid'
            and deducted_at is null
        order by paid_at asc nulls first, id asc
    `;
    const results = [];

    for (const job of rows) {
        const result = await deductPaidCommissionJob(guild, job, db);

        if (result) {
            results.push(result);
        }
    }

    return results;
}

async function processCommissionPayoutJob(guild, job, db = sql, context = {}) {
    const player = await fetchCommissionPayoutPlayer(job.recipient_discord_id, db);
    const currentMinecraftName = payoutMinecraftTarget(player);

    if (!player || !currentMinecraftName) {
        const skippedJob = await markCommissionPayoutJobFailed(
            job,
            'skipped',
            'Missing linked Minecraft account or edition.',
            db
        );

        return {
            retryLater: false,
            result: commissionJobToResult(skippedJob, player || {})
        };
    }

    const workingJob = await updateCommissionPayoutJobMinecraftName(job, currentMinecraftName, db);
    const amountCents = BigInt(workingJob.amount_cents);
    const amount = formatMinecraftPaymentAmountFromCents(amountCents);
    const paymentContext = commissionPaymentContext(context.source || `Commission payout job ${workingJob.id}`, {
        ...context,
        suppressPaymentLog: true,
        actorId: workingJob.recipient_discord_id,
        onPaymentStage: (stage, details) => updateCommissionPayoutJobStage(workingJob.id, stage, details, db)
    });

    try {
        await ensureMinecraftBotConnected(paymentContext);
    } catch (error) {
        const pendingJob = await markCommissionPayoutJobPending(workingJob, error.message, db);

        return {
            retryLater: true,
            result: commissionJobToResult(pendingJob, player)
        };
    }

    try {
        const payment = await payPlayerAfterBusyWait(currentMinecraftName, amount, paymentContext);
        const paidJob = await markCommissionPayoutJobPaid(workingJob, payment, db, {
            balanceAfter: balanceAmountText(payment.balanceAfter)
        });
        const result = await deductPaidCommissionJob(guild, paidJob, db);

        return {
            retryLater: false,
            result: result || commissionJobToResult(paidJob, player)
        };
    } catch (error) {
        if (error.paymentAttempted === false || isBusyPaymentError(error)) {
            const pendingJob = await markCommissionPayoutJobPending(workingJob, error.message, db);

            return {
                retryLater: true,
                result: commissionJobToResult(pendingJob, player)
            };
        }

        const failedJob = await markCommissionPayoutJobFailed(workingJob, 'failed', error.message, db);

        await sendPaymentFailureNotification(
            guild,
            player,
            amountCents,
            currentMinecraftName,
            error.message,
            'kept in'
        );

        return {
            retryLater: false,
            result: commissionJobToResult(failedJob, player)
        };
    }
}

async function processPendingCommissionPayoutsForGuild(guild, db = sql, context = {}) {
    if (!guild?.id) {
        return {
            processed: 0,
            results: [],
            skipped: true
        };
    }

    if (context.respectScheduledGiveawayPause && await scheduledGiveawayPayoutsPaused(db)) {
        return {
            processed: 0,
            results: [],
            skipped: true,
            paused: true
        };
    }

    if (activeCommissionPayoutProcessors.has(guild.id)) {
        return {
            processed: 0,
            results: [],
            skipped: true
        };
    }

    activeCommissionPayoutProcessors.add(guild.id);

    try {
        const results = [
            ...await recoverStaleCommissionPayoutJobs(guild, db),
            ...await deductUndeductedPaidCommissionJobs(guild, db)
        ];
        let processed = 0;
        let lastPaymentAttemptAt = 0;

        while (true) {
            const job = await claimNextCommissionPayoutJob(guild.id, db);

            if (!job) {
                break;
            }

            await waitForPaymentSpacing(lastPaymentAttemptAt);
            lastPaymentAttemptAt = Date.now();

            const result = await processCommissionPayoutJob(guild, job, db, context);
            processed++;

            if (result.result) {
                results.push(result.result);
            }

            if (result.retryLater) {
                break;
            }
        }

        return {
            processed,
            results
        };
    } finally {
        activeCommissionPayoutProcessors.delete(guild.id);
    }
}

async function fetchOpenCommissionPayoutResults(guild, db = sql) {
    const rows = await db`
        select *
        from commission_payout_jobs
        where guild_id = ${guild.id}
            and status in ('pending', 'processing', 'manual_review')
        order by created_at asc, id asc
    `;
    const results = [];

    for (const job of rows) {
        const player = await fetchCommissionPayoutPlayer(job.recipient_discord_id, db);
        results.push(commissionJobToResult(job, player || {}));
    }

    return results;
}

function uniqueCommissionResults(results) {
    const keyed = new Map();
    const unkeyed = [];

    for (const result of results) {
        if (!result?.jobId) {
            unkeyed.push(result);
            continue;
        }

        keyed.set(result.jobId, result);
    }

    return [
        ...keyed.values(),
        ...unkeyed
    ];
}

async function payOutstandingCommissions(db = sql, context = {}) {
    const enqueue = await enqueueCommissionPayoutJobs(context.guild, db);
    const processed = await processPendingCommissionPayoutsForGuild(context.guild, db, context);
    const openResults = await fetchOpenCommissionPayoutResults(context.guild, db);
    const results = uniqueCommissionResults([
        ...processed.results,
        ...openResults,
        ...enqueue.skipped
    ]);

    return {
        totalPlayers: Math.max(enqueue.totalPlayers, results.length),
        enqueued: enqueue.enqueued,
        alreadyQueued: enqueue.alreadyQueued,
        results
    };
}

module.exports = {
    creditUnpaidCommission,
    enqueueGiveawayPayouts,
    ensureMinecraftBotConnected,
    formatMinecraftPaymentAmountFromCents,
    payPlayerAfterBusyWait,
    payOutstandingCommissions,
    paymentSpacingMs,
    processPendingCommissionPayoutsForGuild,
    processPendingGiveawayPayoutsForGuild,
    payoutMinecraftTarget,
    settleGiveawayPayouts
};
