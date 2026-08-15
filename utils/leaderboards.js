const {
    CAPTAIN_SPEED_LEADERBOARD_CHANNEL_ID,
    DONATIONS_LEADERBOARD_CHANNEL_ID,
    DONATIONS_LEADERBOARD_CHANNEL_NAME,
    HOURLY_RECRUITS_LEADERBOARD_CHANNEL_ID,
    TEAM_WEEKLY_LEADERBOARD_CHANNEL_ID,
    VC_LEVEL_LEADERBOARD_CHANNEL_ID,
    WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_ID,
    WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_NAME
} = require('./bootstrap.js');
const {
    formatDonationAmount
} = require('./donations.js');
const {
    VOICE_CREDIT_SECONDS,
    levelForXp
} = require('./voiceLeveling.js');

const PREVIOUS_WEEKLY_RECRUITS_STATE_KEY = 'previous_weekly_recruits_top_three';
const WEEKLY_RECRUITS_LAST_RESET_STATE_KEY = 'weekly_recruits_last_reset_at';
const WEEKLY_RECRUITS_CHANNEL_STATE_KEY_PREFIX = 'managed_weekly_recruits_leaderboard_channel:';
const WEEKLY_RECRUITS_MESSAGE_STATE_KEY_PREFIX = 'managed_weekly_recruits_leaderboard_message:';
const TEAM_MONTHLY_RECRUITS_CHANNEL_STATE_KEY_PREFIX = 'managed_team_monthly_recruits_leaderboard_channel:';
const WEEKLY_RECRUITS_TIME_ZONE = 'America/Toronto';
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

function teamLeaderboardLine(index, team) {
    const medals = ['🥇', '🥈', '🥉'];
    const marker = medals[index] || `**${index + 1}.**`;
    const ownerLine = team.owner_discord_id ? ` — Owner: <@${team.owner_discord_id}>` : '';

    return `${marker} **${team.name}** - **${team.recruit_count}** monthly team recruits${ownerLine}`;
}

function voiceLeaderboardName(member, row) {
    return member?.nickname ||
        member?.displayName ||
        member?.user?.username ||
        row.discord_display_name ||
        row.discord_username ||
        'Unknown Penguin';
}

function voiceLeaderboardLine(index, row, member) {
    const medals = ['🥇', '🥈', '🥉'];
    const marker = medals[index] || `**${index + 1}.**`;
    const totalMinutes = Math.floor(Math.max(0, Number(row.voice_seconds) || 0) / 60);

    return `${marker} **${voiceLeaderboardName(member, row)}** — ` +
        `Level **${row.level}** • **${row.voice_xp} VC XP** • ` +
        `**${totalMinutes} minute${totalMinutes === 1 ? '' : 's'}** in VC`;
}

function formatDuration(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${secs}s`);
    return parts.join(' ');
}

async function storedStateValue(db, key) {
    if (!db || !key) return null;

    const rows = await db`
        select value
        from bot_state
        where key = ${key}
        limit 1
    `;

    return rows[0]?.value || null;
}

async function saveStateValue(db, key, value) {
    if (!db || !key || !value) return;

    await db`
        insert into bot_state (key, value)
        values (${key}, ${String(value)})
        on conflict (key) do update
        set value = excluded.value,
            updated_at = now()
    `;
}

async function updateLeaderboardChannel(guild, channelId, channelName, marker, content, options = {}) {
    const channel = guild.channels.cache.get(channelId) ||
        (await guild.channels.fetch(channelId).catch(() => null));

    if (!channel) {
        console.log(`Leaderboard channel ${channelName} was not found by ID ${channelId}.`);
        return false;
    }

    const markers = Array.isArray(marker) ? marker : [marker];
    const storedMessageId = await storedStateValue(options.db, options.messageStateKey);
    const storedMessage = storedMessageId
        ? await channel.messages.fetch(storedMessageId).catch(() => null)
        : null;
    const recentMessages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    const matchingMessages = [...(recentMessages?.filter(message => {
        return message.author.id === guild.client.user.id &&
            markers.some(searchMarker => message.content.includes(searchMarker));
    }).values() || [])];
    const storedMessageMatches = storedMessage &&
        storedMessage.author.id === guild.client.user.id &&
        markers.some(searchMarker => storedMessage.content.includes(searchMarker));
    const existingMessage = storedMessageMatches ? storedMessage : matchingMessages[0];

    if (existingMessage) {
        await existingMessage.edit({
            content,
            allowedMentions: {
                parse: []
            }
        });
    } else {
        const createdMessage = await channel.send({
            content,
            allowedMentions: {
                parse: []
            }
        });
        await saveStateValue(options.db, options.messageStateKey, createdMessage.id);
    }

    if (existingMessage) {
        await saveStateValue(options.db, options.messageStateKey, existingMessage.id);
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

    const weeklyChannelId = await storedStateValue(
        sql,
        `${WEEKLY_RECRUITS_CHANNEL_STATE_KEY_PREFIX}${guild.id}`
    ) || WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_ID;

    return updateLeaderboardChannel(
        guild,
        weeklyChannelId,
        WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_NAME,
        'Penguin Mafia Weekly Recruit Leaderboard',
        `🏆🐧 **Penguin Mafia Weekly Recruit Leaderboard** 🐧🏆\n\n` +
        `Top 10 penguins by **direct recruits this week**.\n` +
        `Tie-breaker: if players have the same recruit count, whoever reached that count first ranks higher.\n` +
        `This board resets every **Friday at 12:00 PM Eastern Time** (**EDT** during daylight saving time).\n\n` +
        `## Current Week\n${weeklyLines}\n\n` +
        `## Previous Week Top 3\n${previousLines}\n\n`,
        {
            db: sql,
            messageStateKey: `${WEEKLY_RECRUITS_MESSAGE_STATE_KEY_PREFIX}${guild.id}`
        }
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
        `To get on this leaderboard, use \`/donate amount\` or fund a \`/giveaway\`. Direct Minecraft payments without one of those requests will not count.\n\n` +
        `${donationLines}\n\n` 
    );
}

async function updateTeamMonthlyRecruitsLeaderboardForGuild(guild, sql) {
    const teamRows = await sql`
        with month_window as (
            select
                (date_trunc('month', now() at time zone ${WEEKLY_RECRUITS_TIME_ZONE}) at time zone ${WEEKLY_RECRUITS_TIME_ZONE}) as started_at,
                (date_trunc('month', now() at time zone ${WEEKLY_RECRUITS_TIME_ZONE}) at time zone ${WEEKLY_RECRUITS_TIME_ZONE}) + interval '1 month' as ended_at
        ),
        recruiter_buckets as (
            select
                recruiter.discord_id,
                bucket.team_key,
                bucket.team_id,
                bucket.team_name,
                bucket.owner_discord_id
            from players recruiter
            cross join lateral (
                with recursive ancestors as (
                    select
                        player.discord_id,
                        player.discord_username,
                        player.discord_display_name,
                        player.minecraft_ign,
                        player.rank_name,
                        player.parent_discord_id,
                        player.team_id,
                        0 as depth
                    from players player
                    where player.discord_id = recruiter.discord_id

                    union all

                    select
                        parent.discord_id,
                        parent.discord_username,
                        parent.discord_display_name,
                        parent.minecraft_ign,
                        parent.rank_name,
                        parent.parent_discord_id,
                        parent.team_id,
                        ancestors.depth + 1
                    from players parent
                    join ancestors
                        on parent.discord_id = ancestors.parent_discord_id
                    where ancestors.depth < 100
                ),
                nearest_emperor as (
                    select *
                    from ancestors
                    where rank_name = 'Emperor Penguin'
                    order by depth asc
                    limit 1
                )
                select
                    case
                        when owned_team.id is not null then concat('team:', owned_team.id::text)
                        when emperor.discord_id is not null then concat('emperor:', emperor.discord_id)
                        when assigned_team.id is not null then concat('team:', assigned_team.id::text)
                        else null
                    end as team_key,
                    case
                        when owned_team.id is not null then owned_team.id::text
                        when assigned_team.id is not null then assigned_team.id::text
                        else null
                    end as team_id,
                    coalesce(
                        owned_team.name,
                        case
                            when emperor.discord_id is not null then concat(
                                'team-',
                                coalesce(
                                    nullif(
                                        trim(both '-' from regexp_replace(
                                            lower(coalesce(
                                                nullif(emperor.minecraft_ign, ''),
                                                nullif(emperor.discord_display_name, ''),
                                                nullif(emperor.discord_username, ''),
                                                emperor.discord_id,
                                                'player'
                                            )),
                                            '[^a-z0-9]+',
                                            '-',
                                            'g'
                                        )),
                                        ''
                                    ),
                                    'player'
                                )
                            )
                            else null
                        end,
                        assigned_team.name
                    ) as team_name,
                    coalesce(
                        owned_team.owner_discord_id,
                        emperor.discord_id,
                        assigned_team.owner_discord_id
                    ) as owner_discord_id
                from (select 1 as seed) seed
                left join nearest_emperor emperor
                    on true
                left join teams owned_team
                    on owned_team.owner_discord_id = emperor.discord_id
                    and owned_team.guild_id = ${guild.id}
                    and owned_team.status = 'active'
                left join teams assigned_team
                    on assigned_team.id = recruiter.team_id
                    and assigned_team.guild_id = ${guild.id}
                    and assigned_team.status = 'active'
                    and emperor.discord_id is null
            ) bucket
            where bucket.team_key is not null
        ),
        team_totals as (
            select
                bucket.team_key,
                bucket.team_id,
                bucket.team_name as name,
                bucket.owner_discord_id,
                count(history.recruit_discord_id)::int as recruit_count
            from recruit_history history
            join recruiter_buckets bucket
                on bucket.discord_id = history.recruiter_discord_id
            cross join month_window
            where history.recruited_at >= month_window.started_at
                and history.recruited_at < month_window.ended_at
                and history.counts_for_hourly = true
            group by
                bucket.team_key,
                bucket.team_id,
                bucket.team_name,
                bucket.owner_discord_id
        )
        select
            team_totals.team_key as id,
            team_totals.team_id,
            team_totals.name,
            team_totals.owner_discord_id,
            team_totals.recruit_count
        from team_totals
        cross join month_window
        left join lateral (
            select ranked.recruited_at as reached_at
            from (
                select
                    history.recruited_at,
                    row_number() over (
                        order by history.recruited_at asc, history.recruit_discord_id asc
                    ) as recruit_number
                from recruit_history history
                join recruiter_buckets bucket
                    on bucket.discord_id = history.recruiter_discord_id
                where bucket.team_key = team_totals.team_key
                    and history.recruited_at >= month_window.started_at
                    and history.recruited_at < month_window.ended_at
                    and history.counts_for_hourly = true
            ) ranked
            where ranked.recruit_number = team_totals.recruit_count
            limit 1
        ) team_progress on true
        order by
            team_totals.recruit_count desc,
            team_progress.reached_at asc nulls last,
            team_totals.name asc
        limit 10
    `;

    const teamLines = teamRows.length > 0
        ? teamRows.map((row, i) => teamLeaderboardLine(i, row)).join('\n')
        : 'No team recruits yet this month.';
    const teamMonthlyChannelId = await storedStateValue(
        sql,
        `${TEAM_MONTHLY_RECRUITS_CHANNEL_STATE_KEY_PREFIX}${guild.id}`
    ) || TEAM_WEEKLY_LEADERBOARD_CHANNEL_ID;

    return updateLeaderboardChannel(
        guild,
        teamMonthlyChannelId,
        'team-monthly-leaderboard',
        [
            'Penguin Mafia Monthly Team Recruit Leaderboard',
            'Penguin Mafia Weekly Team Recruit Leaderboard'
        ],
        `🏆🐧 **Penguin Mafia Monthly Team Recruit Leaderboard** 🐧🏆\n\n` +
        `Top 10 teams by adding up each effective team member’s **personal monthly direct recruits**.\n` +
        `Emperor Penguin branches count as their own team branch. If an Emperor has not created a custom team yet, their default branch name is **team-player** style, like **team-rainbowbeltzz**.\n` +
        `Tie-breaker: if teams have the same recruit count, whichever team reached that count first ranks higher.\n` +
        `This board resets on the **1st of every month at 12:00 AM Eastern Time**.\n\n` +
        `## Current Month\n` +
        `${teamLines}\n\n`
    );
}

async function updateTeamWeeklyRecruitsLeaderboardForGuild(guild, sql) {
    return updateTeamMonthlyRecruitsLeaderboardForGuild(guild, sql);
}

async function updateDailyRecruitsLeaderboardForGuild(guild, sql) {
    const currentDayRows = await sql`
        with day_window as (
            select
                (date_trunc('day', now() at time zone 'America/Toronto') at time zone 'America/Toronto') as started_at,
                (date_trunc('day', now() at time zone 'America/Toronto') at time zone 'America/Toronto') + interval '1 day' as ended_at
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
            day_window.started_at as reward_day
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
        limit 10
    `;
    const previousDayRows = await sql`
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
            day_window.started_at as reward_day,
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
    const previousDayLines = previousDayRows.length > 0
        ? previousDayRows.map((player, index) => {
            return leaderboardLine(
                index,
                player,
                player.recruit_count,
                'daily direct recruits'
            );
        }).join('\n')
        : 'No one had a recruit yesterday.';
    const currentDayLines = currentDayRows.length > 0
        ? currentDayRows.map((player, index) => {
            return leaderboardLine(
                index,
                player,
                player.recruit_count,
                'daily direct recruits'
            );
        }).join('\n')
        : 'No one has a recruit today yet.';

    return updateLeaderboardChannel(
        guild,
        HOURLY_RECRUITS_LEADERBOARD_CHANNEL_ID,
        'daily-recruits',
        'Penguin Mafia Daily Recruit Leaderboard',
        `🏆🐧 **Penguin Mafia Daily Recruit Leaderboard** 🐧🏆\n\n` +
        `Tie-breaker: if players have the same recruit count, whoever reached that count first ranks higher.\n\n` +
        `## Today’s Top Recruiters\n${currentDayLines}\n\n` +
        `## Yesterday’s Top Recruiters\n${previousDayLines}\n\n`
    );
}

async function updateCaptainSpeedLeaderboardForGuild(guild, db) {
    const rows = await db`
        select
            player.discord_id,
            player.discord_username,
            player.discord_display_name,
            player.minecraft_ign,
            player.parent_discord_id,
            extract(epoch from (player.reached_captain_at - player.created_at))::bigint as promotion_seconds
        from players player
        where player.reached_captain_at is not null
            and player.created_at is not null
            and player.captain_leaderboard_disqualified = false
            and date_trunc('month', player.reached_captain_at) = date_trunc('month', now() at time zone 'UTC')
        order by promotion_seconds asc, player.reached_captain_at asc
        limit 10
    `;

    if (rows.length === 0) {
        return updateLeaderboardChannel(
            guild,
            CAPTAIN_SPEED_LEADERBOARD_CHANNEL_ID,
            'captain-speed-leaderboard',
            'Penguin Mafia Fastest Captains',
            `⚡🐧 **Penguin Mafia Fastest Captains — ${new Date().toLocaleString('default', { month: 'long', year: 'numeric' })}** 🐧⚡\n\n` +
            `Top 10 fastest promotions from **Penguin Soldier** to **Penguin Captain** this month.\n\n` +
            `No promotions recorded yet this month. Be the first!\n\n`
        );
    }

    const lines = rows.map((row, index) => {
        const medals = ['🥇', '🥈', '🥉'];
        const marker = medals[index] || `**${index + 1}.**`;
        const name = row.minecraft_ign || row.discord_display_name || row.discord_username || 'Unknown';
        return `${marker} **${name}** — ${formatDuration(row.promotion_seconds)}` +
            (row.parent_discord_id ? ` (recruited by <@${row.parent_discord_id}>)` : '');
    }).join('\n');

    return updateLeaderboardChannel(
        guild,
        CAPTAIN_SPEED_LEADERBOARD_CHANNEL_ID,
        'captain-speed-leaderboard',
        'Penguin Mafia Fastest Captains',
        `⚡🐧 **Penguin Mafia Fastest Captains — ${new Date().toLocaleString('default', { month: 'long', year: 'numeric' })}** 🐧⚡\n\n` +
        `Top 10 fastest promotions from **Penguin Soldier** to **Penguin Captain** this month.\n\n` +
        `${lines}\n\n`
    );
}

async function updateVoiceLevelLeaderboardForGuild(guild, db) {
    const rows = await db`
        select
            stats.discord_id,
            (
                stats.voice_seconds + coalesce(
                    greatest(0, floor(extract(epoch from (now() - session.started_at))))::bigint,
                    0
                )
            )::text as voice_seconds,
            player.discord_username,
            player.discord_display_name
        from vc_levels stats
        left join vc_active_sessions session
            on session.guild_id = stats.guild_id
            and session.discord_id = stats.discord_id
        left join players player
            on player.discord_id = stats.discord_id
        where stats.guild_id = ${guild.id}
        order by
            stats.voice_seconds + coalesce(
                greatest(0, floor(extract(epoch from (now() - session.started_at))))::bigint,
                0
            ) desc,
            stats.updated_at asc
        limit 10
    `;
    const entries = await Promise.all(rows.map(async (row, index) => {
        const member = guild.members.cache.get(row.discord_id) ||
            await guild.members.fetch(row.discord_id).catch(() => null);
        const voiceXp = Math.floor(Number(row.voice_seconds) / VOICE_CREDIT_SECONDS);
        const level = levelForXp(voiceXp);

        return voiceLeaderboardLine(index, {
            ...row,
            voice_xp: voiceXp,
            level
        }, member);
    }));
    const lines = entries.length > 0
        ? entries.join('\n')
        : 'No VC time has been recorded yet. Join a call to start climbing!';

    return updateLeaderboardChannel(
        guild,
        VC_LEVEL_LEADERBOARD_CHANNEL_ID,
        'vc-level-leaderboard',
        'Penguin Mafia VC Level Leaderboard',
        `🏆🎙️ **Penguin Mafia VC Level Leaderboard** 🎙️🏆\n\n` +
        `Top 10 penguins by **VC level and XP**. Names use each member’s current server nickname.\n\n` +
        `${lines}\n\n` +
        `Voice time is tracked to the second. Every 600 seconds earns 1 VC XP. Use \`/vchours\` for your live progress.`,
        {
            db,
            messageStateKey: `vc_level_leaderboard_message:${guild.id}`
        }
    );
}

async function updateLeaderboardsForGuild(guild, sql) {
    await updateWeeklyRecruitsLeaderboardForGuild(guild, sql);
    await updateTeamWeeklyRecruitsLeaderboardForGuild(guild, sql);
    await updateDonationLeaderboardForGuild(guild, sql);
    await updateDailyRecruitsLeaderboardForGuild(guild, sql);
    await updateCaptainSpeedLeaderboardForGuild(guild, sql);
    await updateVoiceLevelLeaderboardForGuild(guild, sql);
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
    updateCaptainSpeedLeaderboardForGuild,
    updateDailyRecruitsLeaderboardForGuild,
    updateDonationLeaderboardForGuild,
    updateTeamMonthlyRecruitsLeaderboardForGuild,
    updateTeamWeeklyRecruitsLeaderboardForGuild,
    updateVoiceLevelLeaderboardForGuild,
    updateWeeklyRecruitsLeaderboardForGuild,
    updateLeaderboardsForGuild,
    voiceLeaderboardLine,
    voiceLeaderboardName
};
