const sql = require('../db.js');
const {
    formatDonationAmount,
    parseDonationAmount
} = require('./donations.js');
const {
    calculatePayout,
    playerName
} = require('./payouts.js');
const {
    scheduledGiveawayPayoutState,
    scheduledGiveawayPayoutsPaused,
    scheduledRewardPeriodShouldBeSkipped
} = require('./scheduledGiveawayPayouts.js');
const {
    payoutMinecraftTarget,
    processPendingCommissionPayoutsForGuild
} = require('./commissionPayments.js');
const {
    postDonationEvent
} = require('./events.js');
const {
    emitMinecraftEvent
} = require('../minecraft-bot.js');

const TEAM_MONTHLY_REWARD_DEFAULT_AMOUNT = '100m';
const TEAM_MONTHLY_REWARD_DEFAULT_PAYER = 'rainbowbeltzz';
const EASTERN_TIME_ZONE = 'America/Toronto';

function jsonb(value) {
    const normalized = JSON.parse(JSON.stringify(value, (_, nestedValue) => {
        return typeof nestedValue === 'bigint'
            ? nestedValue.toString()
            : nestedValue;
    }));

    return sql.json(normalized);
}

function normalizeMinecraftUsername(username) {
    return String(username || '').trim().toLowerCase();
}

function normalizeMinecraftUsernameVariants(username) {
    const normalized = normalizeMinecraftUsername(username);
    const withoutDot = normalized.replace(/^\./, '');
    const withDot = withoutDot ? `.${withoutDot}` : normalized;

    return [...new Set([normalized, withoutDot, withDot].filter(Boolean))];
}

function parseMinecraftPaymentAmount(amount) {
    const normalizedAmount = String(amount || '').replace(/[$,\s]/g, '');

    return parseDonationAmount(normalizedAmount);
}

function parseJsonArray(value) {
    if (Array.isArray(value)) {
        return value;
    }

    if (!value) {
        return [];
    }

    if (typeof value !== 'string') {
        return [];
    }

    try {
        const parsed = JSON.parse(value);

        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function isoOrNull(value) {
    if (!value) {
        return null;
    }

    const date = safeDate(value);

    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function teamMonthlyRewardAmount() {
    return parseDonationAmount(
        process.env.TEAM_MONTHLY_REWARD_AMOUNT ||
        TEAM_MONTHLY_REWARD_DEFAULT_AMOUNT
    );
}

function teamMonthlyRewardPayer() {
    return normalizeMinecraftUsername(
        process.env.TEAM_MONTHLY_REWARD_PAYER_MINECRAFT_IGN ||
        TEAM_MONTHLY_REWARD_DEFAULT_PAYER
    );
}

async function recordMonthlyTeamRewardDonationCredit(guild, minecraftIgn, amount, db = sql) {
    const normalizedName = normalizeMinecraftUsername(minecraftIgn);
    const nameWithoutLeadingDot = normalizedName.replace(/^\./, '');
    const donationAmount = BigInt(amount);

    if (!normalizedName || donationAmount <= 0n) {
        return null;
    }

    const rows = await db`
        update players
        set
            donations = donations + ${donationAmount.toString()}::bigint,
            updated_at = now()
        where discord_id = (
            select discord_id
            from players
            where minecraft_ign is not null
                and (
                    lower(minecraft_ign) = ${normalizedName}
                    or lower(minecraft_ign) = ${nameWithoutLeadingDot}
                    or (
                        minecraft_edition = 'bedrock'
                        and lower(concat('.', minecraft_ign)) = ${normalizedName}
                    )
                )
            order by
                case
                    when lower(minecraft_ign) = ${normalizedName} then 0
                    when minecraft_edition = 'bedrock' and lower(concat('.', minecraft_ign)) = ${normalizedName} then 1
                    else 2
                end,
                updated_at desc
            limit 1
        )
        returning discord_id, donations
    `;
    const donationRow = rows[0];

    if (!donationRow) {
        emitMinecraftEvent(
            'Monthly Team Reward Donation Credit Skipped',
            'The monthly team reward payment was accepted, but the payer was not linked in the Penguin database.',
            'warning',
            {
                'Minecraft IGN': minecraftIgn,
                Amount: formatDonationAmount(donationAmount),
                Instruction: 'Link rainbowbeltzz to a Discord player if this should count on donations.'
            }
        );
        return null;
    }

    await postDonationEvent(guild, {
        playerId: donationRow.discord_id,
        amount: donationAmount,
        newTotal: donationRow.donations
    }).catch(error => {
        console.error('Could not post monthly team reward donation event:');
        console.error(error);
    });

    return {
        playerId: donationRow.discord_id,
        amount: donationAmount,
        newTotal: donationRow.donations
    };
}

function safeDate(value) {
    return value instanceof Date ? value : new Date(value);
}

async function fetchPreviousMonthTopTeam(guildId, db = sql) {
    const rows = await db`
        with month_window as (
            select
                (date_trunc('month', now() at time zone ${EASTERN_TIME_ZONE}) at time zone ${EASTERN_TIME_ZONE}) - interval '1 month' as started_at,
                (date_trunc('month', now() at time zone ${EASTERN_TIME_ZONE}) at time zone ${EASTERN_TIME_ZONE}) as ended_at
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
                    and owned_team.guild_id = ${guildId}
                    and owned_team.status = 'active'
                left join teams assigned_team
                    on assigned_team.id = recruiter.team_id
                    and assigned_team.guild_id = ${guildId}
                    and assigned_team.status = 'active'
                    and emperor.discord_id is null
            ) bucket
            where bucket.team_key is not null
        ),
        team_totals as (
            select
                bucket.team_key,
                bucket.team_id,
                bucket.team_name,
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
        ),
        ranked_teams as (
            select
                team_totals.*,
                month_window.started_at as reward_month,
                month_window.ended_at as reward_ended_at,
                team_progress.reached_at
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
        )
        select
            ranked_teams.team_key,
            ranked_teams.team_id,
            ranked_teams.team_name,
            ranked_teams.owner_discord_id,
            ranked_teams.recruit_count,
            ranked_teams.reward_month,
            ranked_teams.reward_ended_at,
            ranked_teams.reached_at
        from ranked_teams
        order by
            ranked_teams.recruit_count desc,
            ranked_teams.reached_at asc nulls last,
            ranked_teams.team_name asc
        limit 1
    `;
    const topTeam = rows[0];

    if (!topTeam || Number(topTeam.recruit_count || 0) <= 0) {
        return null;
    }

    const memberRows = await db`
        with month_window as (
            select
                ${safeDate(topTeam.reward_month)}::timestamptz as started_at,
                ${safeDate(topTeam.reward_month)}::timestamptz + interval '1 month' as ended_at
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
                    and owned_team.guild_id = ${guildId}
                    and owned_team.status = 'active'
                left join teams assigned_team
                    on assigned_team.id = recruiter.team_id
                    and assigned_team.guild_id = ${guildId}
                    and assigned_team.status = 'active'
                    and emperor.discord_id is null
            ) bucket
            where bucket.team_key is not null
        ),
        member_counts as (
            select
                player.discord_id,
                player.discord_username,
                player.discord_display_name,
                player.minecraft_ign,
                player.minecraft_edition,
                player.rank_name,
                player.team_id::text as team_id,
                bucket.team_key as effective_team_key,
                bucket.team_id as effective_team_id,
                bucket.team_name as effective_team_name,
                bucket.owner_discord_id as effective_team_owner_discord_id,
                count(history.recruit_discord_id)::int as recruit_count
            from players player
            join recruit_history history
                on history.recruiter_discord_id = player.discord_id
            join recruiter_buckets bucket
                on bucket.discord_id = player.discord_id
            cross join month_window
            where bucket.team_key = ${topTeam.team_key}
                and history.recruited_at >= month_window.started_at
                and history.recruited_at < month_window.ended_at
                and history.counts_for_hourly = true
            group by
                player.discord_id,
                player.discord_username,
                player.discord_display_name,
                player.minecraft_ign,
                player.minecraft_edition,
                player.rank_name,
                player.team_id,
                bucket.team_key,
                bucket.team_id,
                bucket.team_name,
                bucket.owner_discord_id
        )
        select
            member_counts.*,
            member_progress.reached_at,
            coalesce(recruit_details.recruits, '[]'::jsonb) as recruits
        from member_counts
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
                where history.recruiter_discord_id = member_counts.discord_id
                    and history.recruited_at >= month_window.started_at
                    and history.recruited_at < month_window.ended_at
                    and history.counts_for_hourly = true
            ) ranked
            where ranked.recruit_number = member_counts.recruit_count
            limit 1
        ) member_progress on true
        left join lateral (
            select jsonb_agg(
                jsonb_build_object(
                    'recruit_discord_id', history.recruit_discord_id,
                    'discord_id', history.recruit_discord_id,
                    'discord_username', recruit.discord_username,
                    'discord_display_name', recruit.discord_display_name,
                    'minecraft_ign', recruit.minecraft_ign,
                    'minecraft_edition', recruit.minecraft_edition,
                    'rank_name', recruit.rank_name,
                    'team_id_at_snapshot', recruit.team_id::text,
                    'recruited_at', history.recruited_at,
                    'counts_for_hourly', history.counts_for_hourly
                )
                order by history.recruited_at asc, history.recruit_discord_id asc
            ) as recruits
            from recruit_history history
            left join players recruit
                on recruit.discord_id = history.recruit_discord_id
            where history.recruiter_discord_id = member_counts.discord_id
                and history.recruited_at >= month_window.started_at
                and history.recruited_at < month_window.ended_at
                and history.counts_for_hourly = true
        ) recruit_details on true
        order by
            member_counts.recruit_count desc,
            member_progress.reached_at asc nulls last,
            member_counts.discord_display_name asc nulls last,
            member_counts.discord_username asc nulls last
    `;

    return {
        ...topTeam,
        members: memberRows
    };
}

function calculateMemberPrizeShares(members, prizeAmount, totalRecruitCount) {
    const prize = BigInt(prizeAmount);
    const total = BigInt(totalRecruitCount);

    if (prize <= 0n || total <= 0n) {
        return [];
    }

    const rows = members.map((member, index) => {
        const recruitCount = BigInt(member.recruit_count || 0);
        const raw = prize * recruitCount;

        return {
            ...member,
            originalIndex: index,
            share_amount: raw / total,
            share_remainder: raw % total
        };
    });
    const floorTotal = rows.reduce((sum, row) => sum + row.share_amount, 0n);
    let remainder = prize - floorTotal;
    const remainderOrder = [...rows].sort((a, b) => {
        if (a.share_remainder !== b.share_remainder) {
            return a.share_remainder > b.share_remainder ? -1 : 1;
        }

        if (Number(a.recruit_count) !== Number(b.recruit_count)) {
            return Number(b.recruit_count) - Number(a.recruit_count);
        }

        const aTime = a.reached_at ? safeDate(a.reached_at).getTime() : Number.POSITIVE_INFINITY;
        const bTime = b.reached_at ? safeDate(b.reached_at).getTime() : Number.POSITIVE_INFINITY;

        if (aTime !== bTime) {
            return aTime - bTime;
        }

        return a.originalIndex - b.originalIndex;
    });

    for (const row of remainderOrder) {
        if (remainder <= 0n) {
            break;
        }

        row.share_amount += 1n;
        remainder -= 1n;
    }

    return rows
        .map(row => ({
            discord_id: row.discord_id,
            discord_username: row.discord_username,
            discord_display_name: row.discord_display_name,
            minecraft_ign: row.minecraft_ign,
            minecraft_edition: row.minecraft_edition || null,
            rank_name: row.rank_name || null,
            team_id: row.team_id ? String(row.team_id) : null,
            effective_team_key: row.effective_team_key || null,
            effective_team_id: row.effective_team_id ? String(row.effective_team_id) : null,
            effective_team_name: row.effective_team_name || null,
            effective_team_owner_discord_id: row.effective_team_owner_discord_id || null,
            recruit_count: Number(row.recruit_count || 0),
            reached_at: isoOrNull(row.reached_at),
            recruits: parseJsonArray(row.recruits).map(recruit => ({
                recruit_discord_id: recruit.recruit_discord_id || recruit.discord_id || null,
                discord_id: recruit.discord_id || recruit.recruit_discord_id || null,
                discord_username: recruit.discord_username || null,
                discord_display_name: recruit.discord_display_name || null,
                minecraft_ign: recruit.minecraft_ign || null,
                minecraft_edition: recruit.minecraft_edition || null,
                rank_name: recruit.rank_name || null,
                team_id_at_snapshot: recruit.team_id_at_snapshot
                    ? String(recruit.team_id_at_snapshot)
                    : null,
                recruited_at: isoOrNull(recruit.recruited_at),
                counts_for_hourly: recruit.counts_for_hourly !== false
            })),
            share_basis_points: ((recruitCount * 10000n) / total).toString(),
            share_amount: row.share_amount.toString()
        }));
}

async function ensureMonthlyTeamRewardForGuild(guild, db = sql) {
    const payoutState = await scheduledGiveawayPayoutState(db);

    if (payoutState.paused) {
        return {
            status: 'paused'
        };
    }

    const topTeam = await fetchPreviousMonthTopTeam(guild.id, db);

    if (!topTeam) {
        return {
            status: 'no_winner'
        };
    }

    if (scheduledRewardPeriodShouldBeSkipped(payoutState, topTeam.reward_ended_at)) {
        return {
            status: 'skipped_paused_period',
            rewardEndedAt: topTeam.reward_ended_at,
            resumedAt: payoutState.updatedAt
        };
    }

    const prizeAmount = teamMonthlyRewardAmount();
    const memberShares = calculateMemberPrizeShares(
        topTeam.members,
        prizeAmount,
        topTeam.recruit_count
    );
    const rows = await db`
        insert into team_monthly_rewards (
            guild_id,
            reward_month,
            team_id,
            team_name,
            recruit_count,
            prize_amount,
            payer_minecraft_ign,
            member_recruits,
            updated_at
        )
        values (
            ${guild.id},
            ${safeDate(topTeam.reward_month)},
            ${topTeam.team_id ? BigInt(topTeam.team_id).toString() : null}::bigint,
            ${topTeam.team_name},
            ${topTeam.recruit_count},
            ${prizeAmount.toString()}::bigint,
            ${teamMonthlyRewardPayer()},
            ${jsonb(memberShares)},
            now()
        )
        on conflict (guild_id, reward_month) do nothing
        returning *
    `;

    if (rows[0]) {
        emitMinecraftEvent(
            'Monthly Team Reward Awaiting Payment',
            `Team ${topTeam.team_name} won the monthly team recruits reward.`,
            'warning',
            {
                Team: topTeam.team_name,
                Recruits: String(topTeam.recruit_count),
                'Prize pool': formatDonationAmount(prizeAmount),
                'Snapshot recruiters': String(memberShares.length),
                Payer: teamMonthlyRewardPayer(),
                Instruction: `/pay ${process.env.BOT_USER || 'bot_account'} ${formatDonationAmount(prizeAmount)}`
            }
        );

        return {
            status: 'created',
            reward: rows[0]
        };
    }

    const existingRows = await db`
        select *
        from team_monthly_rewards
        where guild_id = ${guild.id}
            and reward_month = ${safeDate(topTeam.reward_month)}
        limit 1
    `;

    return {
        status: 'existing',
        reward: existingRows[0] || null
    };
}

function aggregatePayout(aggregate, payout, source) {
    const player = payout.player || {};
    const discordId = player.discord_id;

    if (!discordId) {
        return;
    }

    const amountCents = BigInt(payout.amountCents || 0);

    if (amountCents <= 0n) {
        return;
    }

    const existing = aggregate.get(discordId) || {
        player,
        amountCents: 0n,
        sources: []
    };

    existing.amountCents += amountCents;
    existing.sources.push({
        recruiterDiscordId: source.recruiterDiscordId,
        recruiterName: source.recruiterName,
        recruiterRecruitCount: Number(source.recruiterRecruitCount || 0),
        recruiterShareAmount: source.recruiterShareAmount.toString(),
        recruiterShareBasisPoints: source.recruiterShareBasisPoints
            ? String(source.recruiterShareBasisPoints)
            : null,
        recruitDiscordIds: source.recruitDiscordIds || [],
        payoutAmountCents: amountCents.toString(),
        label: payout.label || null,
        roleName: payout.roleName || player.rank_name || 'Unknown'
    });
    aggregate.set(discordId, existing);
}

async function enqueueMonthlyTeamRewardPayouts(guild, reward, db = sql) {
    if (await scheduledGiveawayPayoutsPaused(db)) {
        return {
            payouts: [],
            processed: {
                processed: 0,
                results: [],
                skipped: true,
                paused: true
            },
            paused: true
        };
    }

    const memberShares = Array.isArray(reward.member_recruits)
        ? reward.member_recruits
        : JSON.parse(reward.member_recruits || '[]');
    const payoutAggregate = new Map();

    for (const memberShare of memberShares) {
        const shareAmount = BigInt(memberShare.share_amount || 0);

        if (shareAmount <= 0n) {
            continue;
        }

        const payoutResult = await calculatePayout(
            memberShare.discord_id,
            shareAmount,
            process.env.DON_DISCORD_ID,
            db
        );

        if (!payoutResult) {
            continue;
        }

        for (const payout of payoutResult.payouts || []) {
            aggregatePayout(payoutAggregate, payout, {
                recruiterDiscordId: memberShare.discord_id,
                recruiterName: memberShare.minecraft_ign ||
                    memberShare.discord_display_name ||
                    memberShare.discord_username ||
                    memberShare.discord_id,
                recruiterRecruitCount: memberShare.recruit_count,
                recruiterShareAmount: shareAmount,
                recruiterShareBasisPoints: memberShare.share_basis_points,
                recruitDiscordIds: parseJsonArray(memberShare.recruits)
                    .map(recruit => recruit.discord_id || recruit.recruit_discord_id)
                    .filter(Boolean)
            });
        }
    }

    const payouts = [...payoutAggregate.entries()].map(([discordId, entry]) => ({
        discordId,
        player: entry.player,
        amountCents: entry.amountCents,
        sources: entry.sources
    }));

    await db.begin(async transaction => {
        const lockedRows = await transaction`
            select *
            from team_monthly_rewards
            where id = ${reward.id}
            for update
        `;
        const lockedReward = lockedRows[0];

        if (!lockedReward || lockedReward.status !== 'processing') {
            throw new Error('Monthly team reward is no longer processing.');
        }

        for (const payout of payouts) {
            await transaction`
                update players
                set
                    unpaid_commissions = unpaid_commissions + ${payout.amountCents.toString()}::bigint,
                    updated_at = now()
                where discord_id = ${payout.discordId}
            `;

            const minecraftName = payoutMinecraftTarget(payout.player);

            if (!minecraftName) {
                continue;
            }

            const updatedPendingJobs = await transaction`
                update commission_payout_jobs
                set
                    minecraft_name = ${minecraftName},
                    amount_cents = amount_cents + ${payout.amountCents.toString()}::bigint,
                    updated_at = now()
                where guild_id = ${guild.id}
                    and recipient_discord_id = ${payout.discordId}
                    and status = 'pending'
                returning id
            `;

            if (updatedPendingJobs.length > 0) {
                continue;
            }

            await transaction`
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
                    ${payout.discordId},
                    ${minecraftName},
                    ${payout.amountCents.toString()}::bigint,
                    'pending',
                    now()
                )
                on conflict do nothing
            `;
        }

        await transaction`
            update team_monthly_rewards
            set
                status = 'payouts_queued',
                payout_summary = ${jsonb({
                    payouts: payouts.map(payout => ({
                        discordId: payout.discordId,
                        name: playerName(payout.player, payout.discordId),
                        amountCents: payout.amountCents.toString(),
                        sources: payout.sources
                    }))
                })},
                payout_enqueued_at = now(),
                updated_at = now()
            where id = ${reward.id}
        `;
    });

    const processed = await processPendingCommissionPayoutsForGuild(guild, db, {
        guild,
        source: `Monthly team recruit reward ${reward.id}`,
        respectScheduledGiveawayPause: true
    });

    return {
        payouts,
        processed
    };
}

async function processPendingMonthlyTeamRewardPayoutsForGuild(guild, db = sql) {
    const payoutState = await scheduledGiveawayPayoutState(db);

    if (payoutState.paused) {
        return {
            processed: 0,
            results: [],
            skipped: true,
            paused: true
        };
    }

    const rows = await db`
        select *
        from team_monthly_rewards
        where guild_id = ${guild.id}
            and status = 'processing'
        order by paid_at asc nulls last, reward_month asc
    `;
    const results = [];

    for (const reward of rows) {
        if (scheduledRewardPeriodShouldBeSkipped(payoutState, reward.paid_at || reward.reward_month)) {
            const cancelledRows = await db`
                update team_monthly_rewards
                set
                    status = 'cancelled',
                    updated_at = now()
                where id = ${reward.id}
                    and status = 'processing'
                returning *
            `;

            results.push({
                reward: cancelledRows[0] || reward,
                payouts: [],
                processed: {
                    processed: 0,
                    results: [],
                    skipped: true,
                    pausedPeriod: true
                },
                skipped: true,
                pausedPeriod: true
            });
            continue;
        }

        const result = await enqueueMonthlyTeamRewardPayouts(guild, reward, db);
        results.push({
            reward,
            ...result
        });
    }

    return {
        processed: results.length,
        results
    };
}

async function processIncomingTeamMonthlyRewardPayment(guild, payment, db = sql) {
    const paymentPlayer = normalizeMinecraftUsername(payment.player);
    const payer = teamMonthlyRewardPayer();

    if (!paymentPlayer || !normalizeMinecraftUsernameVariants(payer).includes(paymentPlayer)) {
        return {
            status: 'ignored'
        };
    }

    let paidAmount;

    try {
        paidAmount = parseMinecraftPaymentAmount(payment.amount);
    } catch {
        return {
            status: 'ignored'
        };
    }

    const variants = normalizeMinecraftUsernameVariants(paymentPlayer);
    const matchingRows = await db`
        select *
        from team_monthly_rewards
        where guild_id = ${guild.id}
            and status = 'pending_payment'
            and lower(payer_minecraft_ign) in ${db(variants)}
            and prize_amount <= ${paidAmount.toString()}::bigint
        order by reward_month asc
        limit 1
    `;
    const reward = matchingRows[0];

    if (!reward) {
        const lowRows = await db`
            select *
            from team_monthly_rewards
            where guild_id = ${guild.id}
                and status = 'pending_payment'
                and lower(payer_minecraft_ign) in ${db(variants)}
            order by reward_month asc
            limit 1
        `;

        if (lowRows[0]) {
            return {
                status: 'too_low',
                reward: lowRows[0],
                paidAmount
            };
        }

        return {
            status: 'unmatched',
            paidAmount,
            minecraftName: payment.player
        };
    }

    const claimedRows = await db`
        update team_monthly_rewards
        set
            status = 'processing',
            paid_amount = ${paidAmount.toString()}::bigint,
            payment_message = ${payment.message || null},
            paid_at = now(),
            updated_at = now()
        where id = ${reward.id}
            and status = 'pending_payment'
        returning *
    `;
    const claimedReward = claimedRows[0];

    if (!claimedReward) {
        return {
            status: 'already_processing'
        };
    }

    try {
        if (await scheduledGiveawayPayoutsPaused(db)) {
            const donationCredit = await recordMonthlyTeamRewardDonationCredit(
                guild,
                claimedReward.payer_minecraft_ign || payment.player,
                paidAmount,
                db
            );

            emitMinecraftEvent(
                'Monthly Team Reward Payout Paused',
                'The monthly team reward payment was recorded, but payouts are paused.',
                'warning',
                {
                    Team: claimedReward.team_name,
                    'Prize pool': formatDonationAmount(claimedReward.prize_amount),
                    'Paid amount': formatDonationAmount(paidAmount)
                }
            );
            const cancelledRows = await db`
                update team_monthly_rewards
                set
                    status = 'cancelled',
                    updated_at = now()
                where id = ${claimedReward.id}
                    and status = 'processing'
                returning *
            `;

            return {
                status: 'paused',
                reward: cancelledRows[0] || claimedReward,
                paidAmount,
                donationCredit
            };
        }

        const payoutResult = await enqueueMonthlyTeamRewardPayouts(guild, claimedReward, db);
        const donationCredit = await recordMonthlyTeamRewardDonationCredit(
            guild,
            claimedReward.payer_minecraft_ign || payment.player,
            paidAmount,
            db
        );

        if (payoutResult.paused) {
            return {
                status: 'paused',
                reward: claimedReward,
                paidAmount,
                donationCredit
            };
        }

        return {
            status: 'payouts_queued',
            reward: claimedReward,
            paidAmount,
            donationCredit,
            payoutResult
        };
    } catch (error) {
        await db`
            update team_monthly_rewards
            set
                status = 'failed',
                updated_at = now()
            where id = ${claimedReward.id}
        `;

        throw error;
    }
}

module.exports = {
    ensureMonthlyTeamRewardForGuild,
    processPendingMonthlyTeamRewardPayoutsForGuild,
    processIncomingTeamMonthlyRewardPayment,
    teamMonthlyRewardAmount,
    teamMonthlyRewardPayer
};
