const sql = require('../db.js');

const SCHEDULED_GIVEAWAY_PAYOUTS_PAUSED_KEY = 'scheduled_giveaway_payouts_paused';

function stateValueIsPaused(value) {
    return ['1', 'true', 'yes', 'on', 'paused'].includes(
        String(value || '').trim().toLowerCase()
    );
}

async function scheduledGiveawayPayoutsPaused(db = sql) {
    const state = await scheduledGiveawayPayoutState(db);

    return state.paused;
}

async function scheduledGiveawayPayoutState(db = sql) {
    const rows = await db`
        select value, updated_at
        from bot_state
        where key = ${SCHEDULED_GIVEAWAY_PAYOUTS_PAUSED_KEY}
        limit 1
    `;
    const row = rows[0] || null;

    return {
        paused: stateValueIsPaused(row?.value),
        value: row?.value || null,
        updatedAt: row?.updated_at || null
    };
}

function scheduledRewardPeriodShouldBeSkipped(state, periodEndedAt) {
    if (state?.paused) {
        return true;
    }

    if (!state?.updatedAt || !periodEndedAt) {
        return false;
    }

    return new Date(periodEndedAt).getTime() <= new Date(state.updatedAt).getTime();
}

async function setScheduledGiveawayPayoutsPaused(paused, db = sql) {
    const rows = await db`
        insert into bot_state (
            key,
            value,
            updated_at
        )
        values (
            ${SCHEDULED_GIVEAWAY_PAYOUTS_PAUSED_KEY},
            ${paused ? 'paused' : 'active'},
            now()
        )
        on conflict (key) do update
        set
            value = excluded.value,
            updated_at = now()
        returning value, updated_at
    `;

    return {
        paused: stateValueIsPaused(rows[0]?.value),
        updatedAt: rows[0]?.updated_at || null
    };
}

async function skipQueuedScheduledGiveawayPayouts(db = sql) {
    const hourlyRows = await db`
        update hourly_recruit_reward_payout_jobs
        set
            status = 'skipped',
            reason = 'Scheduled giveaway payouts were paused before this reward was paid.',
            updated_at = now()
        where status = 'pending'
        returning reward_id
    `;
    const rewardIds = [...new Set(
        hourlyRows
            .map(row => row.reward_id)
            .filter(Boolean)
            .map(id => BigInt(id))
    )];
    let finishedHourlyRewards = 0;

    if (rewardIds.length > 0) {
        const rewardRows = await db`
            update hourly_recruit_rewards reward
            set
                status = 'finished',
                finished_at = coalesce(finished_at, now()),
                updated_at = now()
            where id in ${db(rewardIds)}
                and not exists (
                    select 1
                    from hourly_recruit_reward_payout_jobs job
                    where job.reward_id = reward.id
                        and job.status in ('pending', 'processing')
                )
            returning id
        `;

        finishedHourlyRewards = rewardRows.length;
    }

    const monthlyRows = await db`
        update team_monthly_rewards
        set
            status = 'cancelled',
            updated_at = now()
        where status = 'processing'
            and payout_enqueued_at is null
        returning id
    `;

    return {
        skippedHourlyJobs: hourlyRows.length,
        finishedHourlyRewards,
        cancelledMonthlyRewards: monthlyRows.length
    };
}

module.exports = {
    SCHEDULED_GIVEAWAY_PAYOUTS_PAUSED_KEY,
    scheduledGiveawayPayoutState,
    scheduledGiveawayPayoutsPaused,
    scheduledRewardPeriodShouldBeSkipped,
    skipQueuedScheduledGiveawayPayouts,
    setScheduledGiveawayPayoutsPaused
};
