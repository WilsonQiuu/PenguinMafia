const sql = require('../db.js');
const {
    checkBalance,
    emitMinecraftEvent,
    sendTwilioSms
} = require('../minecraft-bot.js');
const {
    formatCents,
    formatDonationAmount,
    parseDonationAmount
} = require('./donations.js');
const {
    activeGiveawayTotalAmount,
    GIVEAWAY_WINNER_CHANNEL_ID
} = require('./giveaways.js');
const {
    calculatePayout,
    formatPayoutLine,
    playerName
} = require('./payouts.js');
const {
    creditUnpaidCommission,
    ensureMinecraftBotConnected,
    formatMinecraftPaymentAmountFromCents,
    payPlayerAfterBusyWait,
    payoutMinecraftTarget
} = require('./commissionPayments.js');
const {
    formatEasternDate
} = require('./time.js');

const DAILY_RECRUIT_REWARD_TYPE = 'daily';
const DEFAULT_DAILY_RECRUIT_REWARD_PRIZES = ['15m', '10m', '5m'];
const DEFAULT_DAILY_RECRUIT_BALANCE_RESERVE = '60m';
const TERMINAL_HOURLY_REWARD_PAYOUT_STATUSES = [
    'paid',
    'credited',
    'credit_failed',
    'failed',
    'skipped',
    'manual_review'
];
const activeHourlyRewardPayoutProcessors = new Set();

function dailyRecruitRewardPrizeAmounts() {
    const configured = process.env.DAILY_RECRUIT_REWARD_PRIZES;
    const prizeTexts = configured
        ? configured.split(',').map(value => value.trim()).filter(Boolean)
        : DEFAULT_DAILY_RECRUIT_REWARD_PRIZES;

    return prizeTexts.slice(0, 3).map(parseDonationAmount);
}

function dailyRecruitRewardPrizeAmount(placement) {
    return dailyRecruitRewardPrizeAmounts()[placement - 1] || 0n;
}

function dailyRecruitBalanceReserveAmount() {
    return parseDonationAmount(process.env.DAILY_RECRUIT_BALANCE_RESERVE || DEFAULT_DAILY_RECRUIT_BALANCE_RESERVE);
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

function payoutResultFromReward(reward, jobs) {
    const payoutResult = parseStoredJson(reward?.payout_result);

    return {
        ...payoutResult,
        player: {
            ...(payoutResult.player || {}),
            discord_id: payoutResult.player?.discord_id || reward?.winner_discord_id || null
        },
        payouts: jobs.map(job => hydratePayoutPayload(job.payout_payload || {})),
        totalAmountCents: BigInt(payoutResult.totalAmountCents || 0),
        totalPaidCents: BigInt(payoutResult.totalPaidCents || 0),
        stoppedAtFinalRank: Boolean(payoutResult.stoppedAtFinalRank)
    };
}

function hourlyRewardJobToResult(job) {
    const payout = hydratePayoutPayload(job.payout_payload || {});
    payout.player = {
        ...payout.player,
        discord_id: payout.player?.discord_id || job.recipient_discord_id
    };

    return {
        jobId: job.id,
        rewardId: job.reward_id,
        status: job.status,
        payout,
        amountCents: BigInt(job.amount_cents || 0),
        minecraftName: job.minecraft_name || null,
        response: job.response || null,
        reason: job.reason || job.error || null,
        isWinner: Boolean(job.is_winner),
        player: payout.player
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

function hourlyRewardSettlementLogDetails(reward, payoutResult, results, paidTotalCents, creditedTotalCents) {
    const paidLines = results
        .filter(result => result.status === 'paid')
        .map(result => {
            return `${payoutLogRecipient(result.payout?.player)} — ${formatCents(result.amountCents)} paid to ${result.minecraftName}`;
        });
    const creditedLines = results
        .filter(result => result.status === 'credited')
        .map(result => {
            return `${payoutLogRecipient(result.payout?.player)} — ${formatCents(result.amountCents)} added to commissions (${result.reason || 'payment failed'})`;
        });
    const failedLines = results
        .filter(result => ['credit_failed', 'failed', 'manual_review'].includes(result.status))
        .map(result => {
            const action = result.status === 'manual_review'
                ? 'needs manual review'
                : 'not paid';

            return `${payoutLogRecipient(result.payout?.player || result.player)} — ${formatCents(result.amountCents)} ${action} (${result.reason || 'unknown reason'})`;
        });

    return {
        Reward: String(reward.id),
        Type: reward.reward_type || 'daily',
        Day: formatEasternDate(reward.reward_hour),
        Placement: String(reward.placement || 1),
        Winner: payoutResult?.player?.discord_id
            ? `<@${payoutResult.player.discord_id}>`
            : playerName(payoutResult?.player || {}, 'Unknown winner'),
        Recruits: String(reward.recruit_count),
        'Prize pool': formatDonationAmount(reward.prize_amount),
        'Paid total': formatCents(paidTotalCents),
        'Commission added total': formatCents(creditedTotalCents),
        'Players paid': compactLogLines(paidLines),
        'Added to commissions': compactLogLines(creditedLines),
        Failed: compactLogLines(failedLines)
    };
}

async function fetchPreviousDayTopRecruiters(db = sql) {
    const rows = await db`
        with day_window as (
            select
                (date_trunc('day', now() at time zone 'America/Toronto') at time zone 'America/Toronto') - interval '1 day' as started_at,
                (date_trunc('day', now() at time zone 'America/Toronto') at time zone 'America/Toronto') as ended_at
        ),
        recruiter_totals as (
            select
                history.recruiter_discord_id as discord_id,
                recruiter.discord_username,
                recruiter.discord_display_name,
                recruiter.minecraft_ign,
                count(*)::int as recruit_count
            from recruit_history history
            cross join day_window
            left join players recruiter
                on recruiter.discord_id = history.recruiter_discord_id
            where history.recruited_at >= day_window.started_at
                and history.recruited_at < day_window.ended_at
                and history.counts_for_hourly = true
            group by
                history.recruiter_discord_id,
                recruiter.discord_username,
                recruiter.discord_display_name,
                recruiter.minecraft_ign
        )
        select
            recruiter_totals.discord_id,
            recruiter_totals.discord_username,
            recruiter_totals.discord_display_name,
            recruiter_totals.minecraft_ign,
            recruiter_totals.recruit_count,
            day_window.started_at as reward_hour,
            day_window.ended_at as reward_ended_at,
            (row_number() over (
                order by
                    recruiter_totals.recruit_count desc,
                    daily_progress.reached_at asc nulls last,
                    recruiter_totals.discord_display_name asc nulls last,
                    recruiter_totals.discord_username asc nulls last
            ))::int as placement
        from recruiter_totals
        cross join day_window
        left join lateral (
            select ranked.recruited_at as reached_at
            from (
                select
                    history.recruited_at,
                    row_number() over (
                        order by history.recruited_at asc, history.recruit_discord_id asc
                    ) as recruit_number
                from recruit_history history
                where history.recruiter_discord_id = recruiter_totals.discord_id
                    and history.recruited_at >= day_window.started_at
                    and history.recruited_at < day_window.ended_at
                    and history.counts_for_hourly = true
            ) ranked
            where ranked.recruit_number = recruiter_totals.recruit_count
            limit 1
        ) daily_progress on true
        order by
            recruiter_totals.recruit_count desc,
            daily_progress.reached_at asc nulls last,
            recruiter_totals.discord_display_name asc nulls last,
            recruiter_totals.discord_username asc nulls last
        limit 3
    `;

    return rows;
}

async function fetchGiveawayWinnerChannel(guild) {
    const channel = guild.channels.cache.get(GIVEAWAY_WINNER_CHANNEL_ID) ||
        (await guild.channels.fetch(GIVEAWAY_WINNER_CHANNEL_ID).catch(() => null));

    if (!channel?.isTextBased?.()) {
        return null;
    }

    return channel;
}

async function postDailyRewardAnnouncement(guild, reward, winner, payoutResult) {
    const channel = await fetchGiveawayWinnerChannel(guild);

    if (!channel) {
        return null;
    }

    const prizeAmount = BigInt(reward.prize_amount);
    const placement = Number(reward.placement || winner.placement || 1);
    const placementNames = ['1st', '2nd', '3rd'];
    const payoutLines = (payoutResult.payouts || [])
        .map((payout, index) => formatPayoutLine(payout, index, {
            includeDiscordMention: true
        }));
    let content =
        `🏆🐧 **Daily Recruit Leaderboard Reward** 🐧🏆\n\n` +
        `<@${winner.discord_id}> placed **${placementNames[placement - 1] || `${placement}th`}** yesterday with **${winner.recruit_count}** direct recruit${winner.recruit_count === 1 ? '' : 's'}.\n` +
        `Eastern Day: **${formatEasternDate(reward.reward_hour)}**\n` +
        `Prize Pool: **${formatDonationAmount(prizeAmount)}**\n\n` +
        `This pays out like \`/pay\`: the winner receives their rank commission, and the rest follows their recruiter chain.\n\n` +
        `**Payouts**\n${payoutLines.join('\n')}`;

    if (content.length > 1900) {
        content = `${content.slice(0, 1850)}\n\nPayout list trimmed. Full details are in bot logs.`;
    }

    return channel.send({
        content,
        allowedMentions: {
            users: [winner.discord_id],
            parse: []
        }
    });
}

async function enqueueDailyRecruitReward(guild, winner, prizeAmount, payoutResult, db = sql) {
    const placement = Number(winner.placement || 1);

    return db.begin(async tx => {
        const rewardRows = await tx`
            insert into hourly_recruit_rewards (
                guild_id,
                reward_type,
                reward_hour,
                placement,
                winner_discord_id,
                recruit_count,
                prize_amount,
                payout_result,
                status,
                updated_at
            )
            values (
                ${guild.id},
                ${DAILY_RECRUIT_REWARD_TYPE},
                ${winner.reward_hour},
                ${placement},
                ${winner.discord_id},
                ${winner.recruit_count},
                ${prizeAmount.toString()}::bigint,
                ${jsonb(serializePayoutResult(payoutResult))},
                'pending',
                now()
            )
            on conflict (guild_id, reward_type, reward_hour, placement) do nothing
            returning *
        `;

        const reward = rewardRows[0];

        if (!reward) {
            return {
                created: false
            };
        }

        const payouts = (payoutResult.payouts || [])
            .filter(payout => BigInt(payout.amountCents || 0) > 0n);

        for (const payout of payouts) {
            const player = payout.player || {};

            if (!player.discord_id) {
                continue;
            }

            await tx`
                insert into hourly_recruit_reward_payout_jobs (
                    reward_id,
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
                    ${reward.id},
                    ${guild.id},
                    ${player.discord_id},
                    ${payoutMinecraftTarget(player)},
                    ${BigInt(payout.amountCents).toString()}::bigint,
                    ${jsonb(serializePayout(payout))},
                    ${player.discord_id === payoutResult.player.discord_id},
                    'pending',
                    now()
                )
                on conflict (reward_id, recipient_discord_id) do nothing
            `;
        }

        return {
            created: true,
            reward
        };
    });
}

async function ensureDailyRecruitRewardsForGuild(guild, db = sql) {
    const winners = await fetchPreviousDayTopRecruiters(db);

    if (winners.length === 0) {
        return {
            status: 'no_winners'
        };
    }

    const createdRewards = [];
    const prizeAmounts = dailyRecruitRewardPrizeAmounts();

    for (const winner of winners) {
        const prizeAmount = prizeAmounts[Number(winner.placement || 1) - 1];

        if (!prizeAmount || prizeAmount <= 0n) {
            continue;
        }

        const payoutResult = await calculatePayout(
            winner.discord_id,
            prizeAmount,
            process.env.DON_DISCORD_ID,
            db
        );

        if (!payoutResult) {
            continue;
        }

        const enqueueResult = await enqueueDailyRecruitReward(guild, winner, prizeAmount, payoutResult, db);

        if (!enqueueResult.created) {
            continue;
        }

        const message = await postDailyRewardAnnouncement(guild, enqueueResult.reward, winner, payoutResult);

        if (message) {
            await db`
                update hourly_recruit_rewards
                set
                    channel_id = ${message.channel.id},
                    message_id = ${message.id},
                    updated_at = now()
                where id = ${enqueueResult.reward.id}
            `;
        }

        emitMinecraftEvent(
            'Daily Recruit Reward Created',
            `${playerName(winner)} placed #${winner.placement} on the daily recruit leaderboard.`,
            'success',
            {
                Placement: String(winner.placement),
                Winner: `<@${winner.discord_id}>`,
                Recruits: String(winner.recruit_count),
                'Prize pool': formatDonationAmount(prizeAmount),
                Channel: message?.url || `<#${GIVEAWAY_WINNER_CHANNEL_ID}>`
            }
        );

        createdRewards.push(enqueueResult.reward);
    }

    return createdRewards.length > 0
        ? {
            status: 'created',
            rewards: createdRewards
        }
        : {
            status: 'already_exists'
        };
}

async function claimNextHourlyRewardPayoutJob(guildId, db = sql) {
    return db.begin(async tx => {
        const rows = await tx`
            with next_job as (
                select id
                from hourly_recruit_reward_payout_jobs
                where guild_id = ${guildId}
                    and status = 'pending'
                order by created_at asc, id asc
                limit 1
                for update skip locked
            )
            update hourly_recruit_reward_payout_jobs job
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

async function markHourlyRewardPayoutJobPending(job, reason, db = sql) {
    await db`
        update hourly_recruit_reward_payout_jobs
        set
            status = 'pending',
            reason = ${reason},
            updated_at = now()
        where id = ${job.id}
    `;
}

async function markHourlyRewardPayoutJobPaid(job, payment, db = sql, details = {}) {
    const rows = await db`
        update hourly_recruit_reward_payout_jobs
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

async function markHourlyRewardPayoutJobManualReview(job, reason, db = sql, details = {}) {
    const rows = await db`
        update hourly_recruit_reward_payout_jobs
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

async function markHourlyRewardPayoutJobCredited(job, reason, db = sql) {
    const payout = hydratePayoutPayload(job.payout_payload || {});

    return db.begin(async tx => {
        const lockedRows = await tx`
            select *
            from hourly_recruit_reward_payout_jobs
            where id = ${job.id}
            for update
        `;
        const lockedJob = lockedRows[0];

        if (!lockedJob || TERMINAL_HOURLY_REWARD_PAYOUT_STATUSES.includes(lockedJob.status)) {
            return lockedJob;
        }

        const credited = await creditUnpaidCommission(
            payout.player,
            BigInt(lockedJob.amount_cents),
            reason,
            tx,
            {
                suppressCommissionLog: true,
                'Daily recruit reward': String(lockedJob.reward_id)
            }
        );
        const status = credited.status === 'credited' ? 'credited' : credited.status;
        const rows = await tx`
            update hourly_recruit_reward_payout_jobs
            set
                status = ${status},
                reason = ${credited.reason || reason},
                error = ${status === 'credited' ? null : credited.reason || reason},
                credited_at = case when ${status} = 'credited' then now() else credited_at end,
                updated_at = now()
            where id = ${job.id}
            returning *
        `;

        return rows[0];
    });
}

async function recordHourlyRewardPayoutJobEarnings(job, db = sql) {
    if (!['paid', 'credited'].includes(job?.status)) {
        return;
    }

    const amountCents = BigInt(job.amount_cents || 0);

    if (!job.recipient_discord_id || amountCents <= 0n) {
        return;
    }

    await db.begin(async tx => {
        const lockedRows = await tx`
            select *
            from hourly_recruit_reward_payout_jobs
            where id = ${job.id}
            for update
        `;
        const lockedJob = lockedRows[0];

        if (
            !lockedJob ||
            lockedJob.earnings_recorded_at ||
            !['paid', 'credited'].includes(lockedJob.status)
        ) {
            return;
        }

        const lockedAmountCents = BigInt(lockedJob.amount_cents || 0);

        if (!lockedJob.recipient_discord_id || lockedAmountCents <= 0n) {
            return;
        }

        if (lockedJob.is_winner) {
            await tx`
                update players
                set
                    personal_production = personal_production + ${lockedAmountCents.toString()}::bigint,
                    updated_at = now()
                where discord_id = ${lockedJob.recipient_discord_id}
            `;
        } else {
            await tx`
                update players
                set
                    team_overrides = team_overrides + ${lockedAmountCents.toString()}::bigint,
                    updated_at = now()
                where discord_id = ${lockedJob.recipient_discord_id}
            `;
        }

        await tx`
            update hourly_recruit_reward_payout_jobs
            set
                earnings_recorded_at = now(),
                updated_at = now()
            where id = ${lockedJob.id}
        `;
    });
}

async function updateHourlyRewardPayoutJobStage(jobId, stage, details, db = sql) {
    if (stage === 'balance_before') {
        await db`
            update hourly_recruit_reward_payout_jobs
            set
                balance_before = ${details?.balance?.amount?.toString?.() || null},
                updated_at = now()
            where id = ${jobId}
        `;
        return;
    }

    if (stage === 'command_sent') {
        await db`
            update hourly_recruit_reward_payout_jobs
            set
                command_sent_at = now(),
                updated_at = now()
            where id = ${jobId}
        `;
        return;
    }

    if (stage === 'balance_after') {
        await db`
            update hourly_recruit_reward_payout_jobs
            set
                balance_after = ${details?.balance?.amount?.toString?.() || null},
                updated_at = now()
            where id = ${jobId}
        `;
    }
}

async function sendHourlyRewardPayoutNotification(guild, job, db = sql) {
    if (!['paid', 'credited'].includes(job?.status)) {
        return;
    }

    const rows = await db`
        select
            job.*,
            reward.prize_amount,
            reward.placement,
            reward.recruit_count,
            winner.discord_username as winner_username,
            winner.discord_display_name as winner_display_name,
            winner.minecraft_ign as winner_minecraft_ign,
            recipient.payout_notifications_enabled
        from hourly_recruit_reward_payout_jobs job
        join hourly_recruit_rewards reward
            on reward.id = job.reward_id
        left join players winner
            on winner.discord_id = reward.winner_discord_id
        left join players recipient
            on recipient.discord_id = job.recipient_discord_id
        where job.id = ${job.id}
        limit 1
    `;
    const record = rows[0];

    if (!record?.payout_notifications_enabled || record.notification_sent_at) {
        return;
    }

    const amountCents = BigInt(record.amount_cents || 0);
    const winnerName = playerName(
        {
            discord_username: record.winner_username,
            discord_display_name: record.winner_display_name,
            minecraft_ign: record.winner_minecraft_ign
        },
        'your recruit'
    );
    const verb = record.status === 'paid' ? 'received' : 'earned';
    const sourceLine = record.is_winner
        ? `from placing **#${record.placement || 1}** on the **daily recruit leaderboard** with **${record.recruit_count}** recruit${record.recruit_count === 1 ? '' : 's'}.`
        : `because your recruit **${winnerName}** placed **#${record.placement || 1}** on the **daily recruit leaderboard** with **${record.recruit_count}** recruit${record.recruit_count === 1 ? '' : 's'}.`;
    const creditedLine = record.status === 'credited'
        ? `\n\nIt was added to your unpaid commissions because ${record.reason || record.error || 'the Minecraft payment could not be sent'}.`
        : '';
    const message =
        `You ${verb} **${formatCents(amountCents)}** ${sourceLine}\n\n` +
        `Daily prize pool: **${formatDonationAmount(record.prize_amount)}**.` +
        `${creditedLine}\n\n` +
        'Use `/payoutnotifications off` if you do not want these DMs.';

    const user = guild.client.users.cache.get(record.recipient_discord_id) ||
        (await guild.client.users.fetch(record.recipient_discord_id).catch(() => null));

    if (user) {
        await user.send({
            content: message,
            allowedMentions: {
                parse: []
            }
        }).catch(error => {
            console.log(`Could not DM daily recruit reward notification to ${record.recipient_discord_id}: ${error.message}`);
        });
    }

    await db`
        update hourly_recruit_reward_payout_jobs
        set
            notification_sent_at = now(),
            updated_at = now()
        where id = ${job.id}
    `;
}

async function processHourlyRewardPayoutJob(guild, job, db = sql) {
    const minecraftName = job.minecraft_name;
    const amountCents = BigInt(job.amount_cents);

    if (!minecraftName) {
        const creditedJob = await markHourlyRewardPayoutJobCredited(
            job,
            'Missing linked Minecraft account or edition.',
            db
        );
        await recordHourlyRewardPayoutJobEarnings(creditedJob, db);
        await sendHourlyRewardPayoutNotification(guild, creditedJob, db);
        return {
            retryLater: false
        };
    }

    const amount = formatMinecraftPaymentAmountFromCents(amountCents);
    const context = {
        actorTag: 'Commission payout',
        source: `Daily recruit reward ${job.reward_id}`,
        suppressPaymentLog: true,
        actorId: job.recipient_discord_id,
        onPaymentStage: (stage, details) => updateHourlyRewardPayoutJobStage(job.id, stage, details, db)
    };

    try {
        await ensureMinecraftBotConnected(context);
    } catch (error) {
        await markHourlyRewardPayoutJobPending(job, error.message, db);
        return {
            retryLater: true
        };
    }

    try {
        const payment = await payPlayerAfterBusyWait(minecraftName, amount, context);
        const paidJob = await markHourlyRewardPayoutJobPaid(job, payment, db, {
            balanceAfter: payment.balanceAfter?.amount?.toString?.() || null
        });

        await recordHourlyRewardPayoutJobEarnings(paidJob, db);
        await sendHourlyRewardPayoutNotification(guild, paidJob, db);
        return {
            retryLater: false
        };
    } catch (error) {
        if (error.paymentAttempted === false || /\b(?:payment to .+ is still waiting for confirmation|balance check is still waiting for confirmation)\b/i.test(String(error.message || ''))) {
            await markHourlyRewardPayoutJobPending(job, error.message, db);
            return {
                retryLater: true
            };
        }

        const creditedJob = await markHourlyRewardPayoutJobCredited(job, error.message, db);
        await recordHourlyRewardPayoutJobEarnings(creditedJob, db);
        await sendHourlyRewardPayoutNotification(guild, creditedJob, db);
        return {
            retryLater: false
        };
    }
}

async function recoverStaleHourlyRewardPayoutJobs(guild, db = sql) {
    const rows = await db`
        select *
        from hourly_recruit_reward_payout_jobs
        where guild_id = ${guild.id}
            and status = 'processing'
            and updated_at < now() - interval '90 seconds'
        order by updated_at asc
    `;

    for (const job of rows) {
        if (!job.command_sent_at || !job.balance_before) {
            await markHourlyRewardPayoutJobPending(job, 'Recovered after restart before payment command was sent.', db);
            continue;
        }

        await markHourlyRewardPayoutJobManualReview(
            job,
            'Recovered after restart after the payment command was sent. Manual review is required to avoid a duplicate daily recruit reward payment.',
            db
        );
    }
}

async function finalizeCompletedHourlyRecruitRewards(guild, db = sql) {
    const rewards = await db`
        select reward.*
        from hourly_recruit_rewards reward
        where reward.guild_id = ${guild.id}
            and reward.status <> 'finished'
            and not exists (
                select 1
                from hourly_recruit_reward_payout_jobs job
                where job.reward_id = reward.id
                    and job.status not in ('paid', 'credited', 'credit_failed', 'failed', 'skipped', 'manual_review')
            )
    `;

    for (const reward of rewards) {
        const jobs = await db`
            select *
            from hourly_recruit_reward_payout_jobs
            where reward_id = ${reward.id}
            order by id asc
        `;
        const results = jobs.map(hourlyRewardJobToResult);
        const payoutResult = payoutResultFromReward(reward, jobs);
        const paidTotalCents = results
            .filter(result => result.status === 'paid')
            .reduce((total, result) => total + result.amountCents, 0n);
        const creditedTotalCents = results
            .filter(result => result.status === 'credited')
            .reduce((total, result) => total + result.amountCents, 0n);
        const hasPayoutIssue = creditedTotalCents > 0n ||
            results.some(result => ['credit_failed', 'failed', 'manual_review'].includes(result.status));

        emitMinecraftEvent(
            'Daily Recruit Reward Settlement Finished',
            'Daily recruiter reward payout settlement finished.',
            hasPayoutIssue ? 'warning' : 'success',
            hourlyRewardSettlementLogDetails(
                reward,
                payoutResult,
                results,
                paidTotalCents,
                creditedTotalCents
            )
        );

        await db`
            update hourly_recruit_rewards
            set
                status = 'finished',
                finished_at = now(),
                log_sent_at = now(),
                updated_at = now()
            where id = ${reward.id}
        `;
    }
}

async function processPendingHourlyRecruitRewardPayoutsForGuild(guild, db = sql) {
    if (activeHourlyRewardPayoutProcessors.has(guild.id)) {
        return {
            processed: 0,
            skipped: true
        };
    }

    activeHourlyRewardPayoutProcessors.add(guild.id);

    try {
        await recoverStaleHourlyRewardPayoutJobs(guild, db);

        let processed = 0;

        while (true) {
            const job = await claimNextHourlyRewardPayoutJob(guild.id, db);

            if (!job) {
                break;
            }

            const result = await processHourlyRewardPayoutJob(guild, job, db);
            processed++;

            await finalizeCompletedHourlyRecruitRewards(guild, db);

            if (result.retryLater) {
                break;
            }
        }

        await finalizeCompletedHourlyRecruitRewards(guild, db);

        return {
            processed
        };
    } finally {
        activeHourlyRewardPayoutProcessors.delete(guild.id);
    }
}

async function claimDailyBalanceCheck(guildId, db = sql) {
    const dayRows = await db`
        select (date_trunc('day', now() at time zone 'America/Toronto') at time zone 'America/Toronto') as checked_day
    `;
    const checkedDay = new Date(dayRows[0].checked_day).toISOString();
    const stateKey = `daily_recruit_balance_check:${guildId}:${checkedDay}`;
    const rows = await db`
        insert into bot_state (
            key,
            value
        )
        values (
            ${stateKey},
            now()::text
        )
        on conflict (key) do nothing
        returning key
    `;

    return rows.length > 0;
}

async function checkDailyRecruitRewardBalanceForGuild(guild, db = sql) {
    const shouldCheck = await claimDailyBalanceCheck(guild.id, db);

    if (!shouldCheck) {
        return {
            checked: false
        };
    }

    const reserveAmount = dailyRecruitBalanceReserveAmount();
    const activeGiveawayAmount = await activeGiveawayTotalAmount(guild.id, db);
    const context = {
        actorTag: 'Daily reward balance check',
        source: 'Daily recruit reward reserve check'
    };

    try {
        await ensureMinecraftBotConnected(context);
        const balance = await checkBalance(context);
        const availableAfterGiveaways = BigInt(balance.amount) - BigInt(activeGiveawayAmount);

        if (availableAfterGiveaways >= reserveAmount) {
            return {
                checked: true,
                alerted: false,
                balance: BigInt(balance.amount),
                activeGiveawayAmount,
                availableAfterGiveaways
            };
        }

        const message =
            `Penguin Mafia payout balance is low.\n` +
            `Bot balance: ${formatDonationAmount(balance.amount)}\n` +
            `Active giveaway money reserved: ${formatDonationAmount(activeGiveawayAmount)}\n` +
            `Available after giveaways: ${formatDonationAmount(availableAfterGiveaways)}\n` +
            `Daily reward reserve target: ${formatDonationAmount(reserveAmount)}`;

        emitMinecraftEvent(
            'Low Daily Reward Balance',
            'Bot balance is below the daily recruit reward reserve after active giveaway money is reserved.',
            'warning',
            {
                'Bot balance': formatDonationAmount(balance.amount),
                'Active giveaway money': formatDonationAmount(activeGiveawayAmount),
                'Available after giveaways': formatDonationAmount(availableAfterGiveaways),
                'Reserve target': formatDonationAmount(reserveAmount)
            }
        );

        await sendTwilioSms(message).catch(error => {
            emitMinecraftEvent(
                'Low Balance SMS Failed',
                'Could not send the low daily reward balance SMS.',
                'error',
                {
                    Error: error.message
                }
            );
        });

        return {
            checked: true,
            alerted: true,
            balance: BigInt(balance.amount),
            activeGiveawayAmount,
            availableAfterGiveaways
        };
    } catch (error) {
        emitMinecraftEvent(
            'Daily Reward Balance Check Failed',
            'Could not check the Minecraft bot balance for daily recruiter rewards.',
            'warning',
            {
                Error: error.message
            }
        );

        return {
            checked: true,
            alerted: false,
            error
        };
    }
}

async function processPendingDailyRecruitRewardPayoutsForGuild(guild, db = sql) {
    return processPendingHourlyRecruitRewardPayoutsForGuild(guild, db);
}

module.exports = {
    checkDailyRecruitRewardBalanceForGuild,
    dailyRecruitBalanceReserveAmount,
    dailyRecruitRewardPrizeAmounts,
    ensureDailyRecruitRewardsForGuild,
    processPendingDailyRecruitRewardPayoutsForGuild,
    processPendingHourlyRecruitRewardPayoutsForGuild
};
