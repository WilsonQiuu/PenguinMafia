const {
    DONATIONS_LEADERBOARD_CHANNEL_ID,
    DONATIONS_LEADERBOARD_CHANNEL_NAME,
    HOURLY_RECRUITS_LEADERBOARD_CHANNEL_ID,
    WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_ID,
    WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_NAME
} = require('./bootstrap.js');
const {
    formatDonationAmount,
    parseDonationAmount
} = require('./donations.js');
const {
    formatEasternHourRange
} = require('./time.js');

const PREVIOUS_WEEKLY_RECRUITS_STATE_KEY = 'previous_weekly_recruits_top_three';
const WEEKLY_RECRUITS_LAST_RESET_STATE_KEY = 'weekly_recruits_last_reset_at';
const WEEKLY_RECRUITS_TIME_ZONE = 'America/Toronto';
const DEFAULT_HOURLY_RECRUIT_REWARD_AMOUNT = '2m';
const LEADERBOARD_REFRESH_DELAY_MS = 2_000;
const leaderboardRefreshes = new Map();

function leaderboardName(player) {
    return player.minecraft_ign ||
        player.discord_display_name ||
        player.discord_username ||
        'Unknown Penguin';
}

function leaderboardLine(index, player, value, suffix) {
    const medals = ['🥇', '🥈', '🥉'];
    const marker = medals[index] || `**${index + 1}.**`;

    return `${marker} **${leaderboardName(player)}** - **${value}** ${suffix}`;
}

function hourlyRecruitRewardAmount() {
    return parseDonationAmount(process.env.HOURLY_RECRUIT_REWARD_AMOUNT || DEFAULT_HOURLY_RECRUIT_REWARD_AMOUNT);
}

function previousCompletedHourStart() {
    const date = new Date();
    date.setMinutes(0, 0, 0);
    date.setHours(date.getHours() - 1);
    return date;
}

async function updateLeaderboardChannel(guild, channelId, channelName, marker, content) {
    const channel = guild.channels.cache.get(channelId) ||
        (await guild.channels.fetch(channelId).catch(() => null));

    if (!channel) {
        console.log(`Leaderboard channel ${channelName} was not found by ID ${channelId}.`);
        return false;
    }

    const recentMessages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const matchingMessages = [...(recentMessages?.filter(message => {
        return message.author.id === guild.client.user.id && message.content.includes(marker);
    }).values() || [])];
    const existingMessage = matchingMessages[0];

    if (existingMessage) {
        await existingMessage.edit({
            content,
            allowedMentions: {
                parse: []
            }
        });
    } else {
        await channel.send({
            content,
            allowedMentions: {
                parse: []
            }
        });
    }

    for (const duplicateMessage of matchingMessages.filter(message => message.id !== existingMessage?.id)) {
        await duplicateMessage.delete().catch(() => null);
    }

    return true;
}

async function updateWeeklyRecruitsLeaderboardForGuild(guild, sql) {
    const [weeklyRows, previousRows] = await Promise.all([
        sql`
        with eastern_week as (
            select
                now() at time zone ${WEEKLY_RECRUITS_TIME_ZONE} as local_now,
                date_trunc('week', now() at time zone ${WEEKLY_RECRUITS_TIME_ZONE}) + interval '4 days 12 hours' as friday_noon
        ),
        scheduled_week as (
            select (
                case
                    when local_now >= friday_noon then friday_noon
                    else friday_noon - interval '7 days'
                end
            ) at time zone ${WEEKLY_RECRUITS_TIME_ZONE} as started_at
            from eastern_week
        ),
        active_week as (
            select greatest(
                coalesce(
                    (
                        select updated_at
                        from bot_state
                        where key = ${WEEKLY_RECRUITS_LAST_RESET_STATE_KEY}
                        limit 1
                    ),
                    '-infinity'::timestamptz
                ),
                (
                    select started_at
                    from scheduled_week
                )
            ) as started_at
        ),
        weekly_players as (
            select
                discord_id,
                discord_username,
                discord_display_name,
                minecraft_ign,
                weekly_direct_recruits_count
            from players
            where weekly_direct_recruits_count > 0
        )
        select
            weekly_players.discord_id,
            weekly_players.discord_username,
            weekly_players.discord_display_name,
            weekly_players.minecraft_ign,
            weekly_players.weekly_direct_recruits_count
        from weekly_players
        cross join active_week
        left join lateral (
            select ranked.recruited_at as reached_at
            from (
                select
                    history.recruited_at,
                    row_number() over (
                        order by history.recruited_at asc, history.recruit_discord_id asc
                    ) as recruit_number
                from recruit_history history
                where history.recruiter_discord_id = weekly_players.discord_id
                    and history.recruited_at >= active_week.started_at
                    and history.counts_for_hourly = true
            ) ranked
            where ranked.recruit_number = weekly_players.weekly_direct_recruits_count
            limit 1
        ) weekly_progress on true
        order by
            weekly_players.weekly_direct_recruits_count desc,
            weekly_progress.reached_at asc nulls last,
            weekly_players.discord_display_name asc nulls last,
            weekly_players.discord_username asc nulls last
        limit 10
        `,
        sql`
            select value
            from bot_state
            where key = ${PREVIOUS_WEEKLY_RECRUITS_STATE_KEY}
            limit 1
        `
    ]);
    let previousTopThree = [];

    try {
        previousTopThree = previousRows[0]?.value
            ? JSON.parse(previousRows[0].value)
            : [];
    } catch (error) {
        console.warn(`Could not parse previous weekly recruit winners: ${error.message}`);
    }

    const weeklyLines = weeklyRows.length > 0
        ? weeklyRows.map((player, index) => {
            return leaderboardLine(index, player, player.weekly_direct_recruits_count, 'weekly direct recruits');
        }).join('\n')
        : 'No weekly recruits yet. The ice is quiet... for now. 🧊';
    const previousLines = previousTopThree.length > 0
        ? previousTopThree.map((player, index) => {
            return leaderboardLine(index, player, player.recruit_count, 'weekly direct recruits');
        }).join('\n')
        : 'No previous weekly results have been saved yet.';

    return updateLeaderboardChannel(
        guild,
        WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_ID,
        WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_NAME,
        'Penguin Mafia Weekly Recruit Leaderboard',
        `🏆🐧 **Penguin Mafia Weekly Recruit Leaderboard** 🐧🏆\n\n` +
        `Top 10 penguins by **direct recruits this week**.\n` +
        `Tie-breaker: if players have the same recruit count, whoever reached that count first ranks higher.\n` +
        `This board resets every **Friday at 12:00 PM Eastern Time** (**EDT** during daylight saving time).\n\n` +
        `## Current Week\n${weeklyLines}\n\n` +
        `## Previous Week Top 3\n${previousLines}\n\n`
    );
}

async function resetWeeklyRecruitsAndSaveTopThree(sql, options = {}) {
    return sql.begin(async transaction => {
        const topThree = await transaction`
            with eastern_week as (
                select
                    now() at time zone ${WEEKLY_RECRUITS_TIME_ZONE} as local_now,
                    date_trunc('week', now() at time zone ${WEEKLY_RECRUITS_TIME_ZONE}) + interval '4 days 12 hours' as friday_noon
            ),
            scheduled_week as (
                select (
                    case
                        when local_now >= friday_noon then friday_noon
                        else friday_noon - interval '7 days'
                    end
                ) at time zone ${WEEKLY_RECRUITS_TIME_ZONE} as started_at
                from eastern_week
            ),
            active_week as (
                select
                    case
                        when ${Boolean(options.usePreviousWeeklyPeriod)} then (
                            select started_at
                            from scheduled_week
                        ) - interval '7 days'
                        else greatest(
                            coalesce(
                                (
                                    select updated_at
                                    from bot_state
                                    where key = ${WEEKLY_RECRUITS_LAST_RESET_STATE_KEY}
                                    limit 1
                                ),
                                '-infinity'::timestamptz
                            ),
                            (
                                select started_at
                                from scheduled_week
                            )
                        )
                    end as started_at
            ),
            weekly_players as (
                select
                    discord_id,
                    discord_username,
                    discord_display_name,
                    minecraft_ign,
                    weekly_direct_recruits_count::int as recruit_count
                from players
                where weekly_direct_recruits_count > 0
            )
            select
                weekly_players.discord_id,
                weekly_players.discord_username,
                weekly_players.discord_display_name,
                weekly_players.minecraft_ign,
                weekly_players.recruit_count
            from weekly_players
            cross join active_week
            left join lateral (
                select ranked.recruited_at as reached_at
                from (
                    select
                        history.recruited_at,
                        row_number() over (
                            order by history.recruited_at asc, history.recruit_discord_id asc
                        ) as recruit_number
                    from recruit_history history
                    where history.recruiter_discord_id = weekly_players.discord_id
                        and history.recruited_at >= active_week.started_at
                        and history.counts_for_hourly = true
                ) ranked
                where ranked.recruit_number = weekly_players.recruit_count
                limit 1
            ) weekly_progress on true
            order by
                weekly_players.recruit_count desc,
                weekly_progress.reached_at asc nulls last,
                weekly_players.discord_display_name asc nulls last,
                weekly_players.discord_username asc nulls last
            limit 3
        `;

        await transaction`
            insert into bot_state (
                key,
                value
            )
            values (
                ${PREVIOUS_WEEKLY_RECRUITS_STATE_KEY},
                ${JSON.stringify(topThree)}
            )
            on conflict (key) do update
            set
                value = excluded.value,
                updated_at = now()
        `;

        await transaction`
            insert into bot_state (
                key,
                value
            )
            values (
                ${WEEKLY_RECRUITS_LAST_RESET_STATE_KEY},
                now()::text
            )
            on conflict (key) do update
            set
                value = excluded.value,
                updated_at = now()
        `;

        await transaction`
            update players
            set
                weekly_direct_recruits_count = 0,
                updated_at = now()
        `;

        if (options.completionStateKey && options.completionStateValue) {
            await transaction`
                insert into bot_state (
                    key,
                    value
                )
                values (
                    ${options.completionStateKey},
                    ${options.completionStateValue}
                )
                on conflict (key) do update
                set
                    value = excluded.value,
                    updated_at = now()
            `;
        }

        return topThree;
    });
}

async function updateDonationLeaderboardForGuild(guild, sql) {
    const donationRows = await sql`
        select
            discord_username,
            discord_display_name,
            minecraft_ign,
            donations
        from players
        where donations > 0
        order by donations desc, discord_display_name asc
        limit 10
    `;

    const donationLines = donationRows.length > 0
        ? donationRows.map((player, index) => {
            return leaderboardLine(index, player, formatDonationAmount(player.donations), 'donated');
        }).join('\n')
        : 'No donations recorded yet. The treasure vault awaits. 💎';

    return updateLeaderboardChannel(
        guild,
        DONATIONS_LEADERBOARD_CHANNEL_ID,
        DONATIONS_LEADERBOARD_CHANNEL_NAME,
        'Penguin Mafia Top Donators',
        `💎🐧 **Penguin Mafia Top Donators** 🐧💎\n\n` +
        `Top 10 penguins by **all-time donations**.\n\n` +
        `${donationLines}\n\n` 
    );
}

async function updateHourlyRecruitsLeaderboardForGuild(guild, sql) {
    const currentHourRows = await sql`
        with hour_window as (
            select
                date_trunc('hour', now()) as started_at,
                date_trunc('hour', now()) + interval '1 hour' as ended_at
        ),
        recruiter_totals as (
            select
                history.recruiter_discord_id as discord_id,
                recruiter.discord_username,
                recruiter.discord_display_name,
                recruiter.minecraft_ign,
                count(*)::int as recruit_count
            from recruit_history history
            cross join hour_window
            left join players recruiter
                on recruiter.discord_id = history.recruiter_discord_id
            where history.recruited_at >= hour_window.started_at
                and history.recruited_at < hour_window.ended_at
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
            hour_window.started_at as reward_hour
        from recruiter_totals
        cross join hour_window
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
                    and history.recruited_at >= hour_window.started_at
                    and history.recruited_at < hour_window.ended_at
                    and history.counts_for_hourly = true
            ) ranked
            where ranked.recruit_number = recruiter_totals.recruit_count
            limit 1
        ) hourly_progress on true
        order by
            recruiter_totals.recruit_count desc,
            hourly_progress.reached_at asc nulls last,
            recruiter_totals.discord_display_name asc nulls last,
            recruiter_totals.discord_username asc nulls last
        limit 10
    `;
    const previousHourWinnerRows = await sql`
        with hour_window as (
            select
                date_trunc('hour', now()) - interval '1 hour' as started_at,
                date_trunc('hour', now()) as ended_at
        ),
        recruiter_totals as (
            select
                history.recruiter_discord_id as discord_id,
                recruiter.discord_username,
                recruiter.discord_display_name,
                recruiter.minecraft_ign,
                count(*)::int as recruit_count
            from recruit_history history
            cross join hour_window
            left join players recruiter
                on recruiter.discord_id = history.recruiter_discord_id
            where history.recruited_at >= hour_window.started_at
                and history.recruited_at < hour_window.ended_at
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
            hour_window.started_at as reward_hour
        from recruiter_totals
        cross join hour_window
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
                    and history.recruited_at >= hour_window.started_at
                    and history.recruited_at < hour_window.ended_at
                    and history.counts_for_hourly = true
            ) ranked
            where ranked.recruit_number = recruiter_totals.recruit_count
            limit 1
        ) hourly_progress on true
        order by
            recruiter_totals.recruit_count desc,
            hourly_progress.reached_at asc nulls last,
            recruiter_totals.discord_display_name asc nulls last,
            recruiter_totals.discord_username asc nulls last
        limit 1
    `;
    const previousHourWinner = previousHourWinnerRows[0];
    const previousTopCount = previousHourWinner?.recruit_count || 0;
    const previousHourRange = previousHourWinner
        ? formatEasternHourRange(previousHourWinner.reward_hour)
        : formatEasternHourRange(previousCompletedHourStart());
    const winnerLine = !previousHourWinner
        ? `No one had a recruit during the last completed EDT hour (**${previousHourRange}**).`
        : `🏆 **Last Hour’s Winner:** **${leaderboardName(previousHourWinner)}** with **${previousTopCount}** recruit${previousTopCount === 1 ? '' : 's'} during **${previousHourRange}**`;
    const currentHourLines = currentHourRows.length > 0
        ? currentHourRows.map((player, index) => {
            return leaderboardLine(
                index,
                player,
                player.recruit_count,
                'hourly direct recruits'
            );
        }).join('\n')
        : 'No one has a recruit this hour yet.';

    return updateLeaderboardChannel(
        guild,
        HOURLY_RECRUITS_LEADERBOARD_CHANNEL_ID,
        'hourly-recruits',
        'Penguin Mafia Hourly Recruit Leaderboard',
        `🏆🐧 **Penguin Mafia Hourly Recruit Leaderboard** 🐧🏆\n\n` +
        `Reward: the top recruiter every hour earns a **${formatDonationAmount(hourlyRecruitRewardAmount())} prize pool** paid like \`/pay\`; ` +
        `they receive the prize multiplied by their commission rate, and recruiter overrides receive the rest.\n` +
        `Tie-breaker: if players have the same recruit count, whoever reached that count first ranks higher.\n\n` +
        `## This Hour’s Top Recruiters\n${currentHourLines}\n\n` +
        `## Last Hour’s Result\n${winnerLine}\n\n`
    );
}

async function updateLeaderboardsForGuild(guild, sql) {
    await updateWeeklyRecruitsLeaderboardForGuild(guild, sql);
    await updateDonationLeaderboardForGuild(guild, sql);
    await updateHourlyRecruitsLeaderboardForGuild(guild, sql);
}

function scheduleLeaderboardsRefreshForGuild(guild, sql, delayMs = LEADERBOARD_REFRESH_DELAY_MS) {
    const key = guild.id;
    let task = leaderboardRefreshes.get(key);

    if (!task) {
        task = {
            guild,
            sql,
            timer: null,
            running: false,
            rerun: false
        };
        leaderboardRefreshes.set(key, task);
    } else {
        task.guild = guild;
        task.sql = sql;
    }

    if (task.timer) {
        clearTimeout(task.timer);
    }

    task.timer = setTimeout(() => {
        runScheduledLeaderboardsRefresh(key, delayMs);
    }, delayMs);
}

async function runScheduledLeaderboardsRefresh(key, delayMs) {
    const task = leaderboardRefreshes.get(key);

    if (!task) {
        return;
    }

    task.timer = null;

    if (task.running) {
        task.rerun = true;
        return;
    }

    task.running = true;

    try {
        await updateLeaderboardsForGuild(task.guild, task.sql);
    } catch (error) {
        console.error(`Scheduled leaderboard refresh failed for ${task.guild?.name || key}:`);
        console.error(error);
    } finally {
        task.running = false;

        if (task.rerun) {
            task.rerun = false;
            task.timer = setTimeout(() => {
                runScheduledLeaderboardsRefresh(key, delayMs);
            }, delayMs);
        } else {
            leaderboardRefreshes.delete(key);
        }
    }
}

module.exports = {
    resetWeeklyRecruitsAndSaveTopThree,
    scheduleLeaderboardsRefreshForGuild,
    updateDonationLeaderboardForGuild,
    updateHourlyRecruitsLeaderboardForGuild,
    updateWeeklyRecruitsLeaderboardForGuild,
    updateLeaderboardsForGuild
};
