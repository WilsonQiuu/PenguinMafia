const {
    ChannelType,
    EmbedBuilder,
    OverwriteType,
    PermissionFlagsBits
} = require('discord.js');

const RANKS = [
    {
        name: 'Penguin Soldier',
        commissionRate: 40,
        isPerm: false,
        color: 0x5DADE2
    },
    {
        name: 'Penguin Captain',
        commissionRate: 60,
        isPerm: false,
        color: 0x58D68D
    },
    {
        name: 'Penguin General',
        commissionRate: 80,
        isPerm: false,
        color: 0xF4D03F
    },
    {
        name: 'Emperor Penguin',
        commissionRate: 90,
        isPerm: true,
        color: 0xAF7AC5
    }
];

const STAFF_RANKS = [
    {
        name: 'Trial Mod',
        color: 0x95FF99,
        banPoints: 0
    },
    {
        name: 'Moderator',
        color: 0x67FF4D,
        banPoints: 1
    },
    {
        name: 'Sr Moderator',
        color: 0x06FF00,
        banPoints: 3,
        permissions: PermissionFlagsBits.ManageChannels
    },
    {
        name: 'Admin',
        color: 0xF52813,
        banPoints: 5,
        permissions: PermissionFlagsBits.ManageChannels
    }
];

const RANK_ROLE_IDS = new Map([
    ['Penguin Soldier', process.env.PENGUIN_SOLDIER_ROLE_ID || '1512488337905291286'],
    ['Penguin Captain', process.env.PENGUIN_CAPTAIN_ROLE_ID || '1512488339046010930'],
    ['Penguin General', process.env.PENGUIN_GENERAL_ROLE_ID || '1512488340673269872'],
    ['Emperor Penguin', process.env.EMPEROR_PENGUIN_ROLE_ID || '1512488341541486683']
]);

const STAFF_ROLE_IDS = new Map([
    ['Trial Mod', process.env.TRIAL_MOD_ROLE_ID || '1512488342980395230'],
    ['Moderator', process.env.MODERATOR_ROLE_ID || '1512488343768793360'],
    ['Sr Moderator', process.env.SR_MODERATOR_ROLE_ID || '1512488344440016936'],
    ['Admin', process.env.ADMIN_ROLE_ID || '1512488345312170237']
]);

const TRAINER_ROLE_NAME = 'Penguin Trainer';
const TRAINER_ROLE_ID = process.env.PENGUIN_TRAINER_ROLE_ID || '1514334462186492116';

const DEFAULT_RANK_NAME = 'Penguin Soldier';
const PROMOTION_EVENTS_CHANNEL_NAME = '🎉-promotion-events';
const WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_NAME = '🏆-weekly-recruits';
const DONATIONS_LEADERBOARD_CHANNEL_NAME = '💎-top-donators';
const PROMOTION_EVENTS_CHANNEL_ID = process.env.PROMOTION_EVENTS_CHANNEL_ID || '1512488373145702430';
const RANK_INFO_CHANNEL_ID = process.env.RANK_INFO_CHANNEL_ID || '1512488363788075250';
const WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_ID = process.env.WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_ID || '1512488377490870392';
const HOURLY_RECRUITS_LEADERBOARD_CHANNEL_ID = process.env.HOURLY_RECRUITS_LEADERBOARD_CHANNEL_ID || '1517802352046768148';
const TEAM_WEEKLY_LEADERBOARD_CHANNEL_ID = process.env.TEAM_WEEKLY_LEADERBOARD_CHANNEL_ID || '1521886870123057182';
const TEAM_MONTHLY_RECRUITS_LEADERBOARD_CHANNEL_NAME = '🏆-monthly-team-recruits';
const CAPTAIN_SPEED_LEADERBOARD_CHANNEL_ID = process.env.CAPTAIN_SPEED_LEADERBOARD_CHANNEL_ID || '1523067446167212132';
const VC_LEVEL_LEADERBOARD_CHANNEL_ID = process.env.VC_LEVEL_LEADERBOARD_CHANNEL_ID || '1538021678414831636';
const TEAM_CHANNEL_CATEGORY_ID = process.env.TEAM_CHANNEL_CATEGORY_ID || '1521889430548512890';
const ICEBERG_CHANNEL_ID = process.env.ICEBERG_CHANNEL_ID || '1524127345047503100';
const ICEBERG_MEMBERS_CHANNEL_ID = process.env.ICEBERG_MEMBERS_CHANNEL_ID || '1524138778518749334';
const ICEBERG_ROLE_ID = process.env.ICEBERG_ROLE_ID || '1524126922295218310';
const ICEBERG_ENTRY_FEE_CENTS = 30_000_000n;
const ICEBERG_MIN_PLOT_PRICE_CENTS = 10_000_000n;
const DONATIONS_LEADERBOARD_CHANNEL_ID = process.env.DONATIONS_LEADERBOARD_CHANNEL_ID || '1512488380280082493';
const MOD_LOG_CHANNEL_NAME = 'mod-log';
const MOD_LOG_CHANNEL_ID = process.env.MOD_LOG_CHANNEL_ID || '1512488393232355522';
const ROLE_CACHE_TTL_MS = 5 * 60 * 1000;
const BUILT_IN_DON_DISCORD_IDS = [
    '719063111008780338'
];

function parseDiscordIdList(value) {
    return String(value || '')
        .split(/[,\s]+/)
        .map(id => id.trim())
        .filter(Boolean);
}

function bootstrapDonDiscordIds() {
    return [...new Set([
        process.env.DON_DISCORD_ID,
        ...parseDiscordIdList(process.env.ADDITIONAL_DON_DISCORD_IDS),
        ...parseDiscordIdList(process.env.DON_DISCORD_IDS),
        ...BUILT_IN_DON_DISCORD_IDS
    ].filter(Boolean))];
}

function createBootstrapTimer(label) {
    const startedAt = Date.now();
    let lastStepAt = startedAt;

    return function logBootstrapStep(step) {
        const now = Date.now();
        const stepMs = now - lastStepAt;
        const totalMs = now - startedAt;
        console.log(`[${label}] ${step} | step=${stepMs}ms total=${totalMs}ms`);
        lastStepAt = now;
    };
}

function getBootstrapGuildCache(guild) {
    if (!guild.client.penguinMafiaBootstrapCache) {
        guild.client.penguinMafiaBootstrapCache = new Map();
    }

    if (!guild.client.penguinMafiaBootstrapCache.has(guild.id)) {
        guild.client.penguinMafiaBootstrapCache.set(guild.id, {});
    }

    return guild.client.penguinMafiaBootstrapCache.get(guild.id);
}

function cacheStillFresh(cacheTime) {
    return cacheTime && Date.now() - cacheTime < ROLE_CACHE_TTL_MS;
}

async function getGuildRoles(guild, options = {}) {
    if (options.roleCache) {
        return options.roleCache;
    }

    const cache = getBootstrapGuildCache(guild);

    if (cache.guildRoles && cacheStillFresh(cache.guildRolesFetchedAt) && !options.forceRoleRefresh) {
        return cache.guildRoles;
    }

    cache.guildRoles = await guild.roles.fetch();
    cache.guildRolesFetchedAt = Date.now();
    return cache.guildRoles;
}

function rememberRole(guild, role, options = {}) {
    if (!role) {
        return;
    }

    if (options.roleCache) {
        options.roleCache.set(role.id, role);
    }

    const cache = getBootstrapGuildCache(guild);

    if (cache.guildRoles) {
        cache.guildRoles.set(role.id, role);
    }
}

function findConfiguredRole(guildRoles, roleName, roleId, label) {
    if (roleId) {
        const roleById = guildRoles.get(roleId);

        if (roleById) {
            return roleById;
        }

        console.warn(`${label} role ID ${roleId} for "${roleName}" was not found. Falling back to role name lookup.`);
    }

    return guildRoles.find(existingRole => existingRole.name === roleName);
}

function invalidateGuildRoleCache(guild) {
    const cache = getBootstrapGuildCache(guild);

    delete cache.guildRoles;
    delete cache.guildRolesFetchedAt;
    delete cache.rankRoles;
    delete cache.rankRolesBuiltAt;
    delete cache.staffRoles;
    delete cache.staffRolesBuiltAt;
}

async function ensureDatabaseSchema(sql) {
    await sql`
        create table if not exists bot_state (
            key text primary key,
            value text not null,
            updated_at timestamptz not null default now()
        )
    `;

    await sql`
        create table if not exists ranks (
            name text primary key,
            commission_rate numeric(5, 2) not null check (
                commission_rate >= 0
                and commission_rate <= 100
            ),
            is_perm boolean not null default false,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
        )
    `;

    await sql`
        create table if not exists staff_ranks (
            name text primary key,
            ban_point_limit int not null default 0 check (ban_point_limit >= 0),
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
        )
    `;

    await sql`
        alter table staff_ranks
        add column if not exists ban_point_limit int not null default 0 check (ban_point_limit >= 0)
    `;

    for (const rank of RANKS) {
        await sql`
            insert into ranks (
                name,
                commission_rate,
                is_perm
            )
            values (
                ${rank.name},
                ${rank.commissionRate},
                ${rank.isPerm}
            )
            on conflict (name) do update
            set
                commission_rate = excluded.commission_rate,
                is_perm = excluded.is_perm,
                updated_at = now()
        `;
    }

    for (const staffRank of STAFF_RANKS) {
        await sql`
            insert into staff_ranks (
                name,
                ban_point_limit
            )
            values (
                ${staffRank.name},
                ${staffRank.banPoints}
            )
            on conflict (name) do update
            set
                ban_point_limit = excluded.ban_point_limit,
                updated_at = now()
        `;
    }

    await sql`
        create table if not exists players (
            discord_id text primary key,
            discord_username text,
            discord_display_name text,
            minecraft_ign text,
            minecraft_edition text check (minecraft_edition in ('java', 'bedrock')),
            joined_invite_code text,
            joined_via_inviter_discord_id text,
            parent_discord_id text references players(discord_id) on delete set null,
            claims_available int not null default 0,
            donations bigint not null default 0 check (donations >= 0),
            unpaid_commissions bigint not null default 0 check (unpaid_commissions >= 0),
            personal_production bigint not null default 0 check (personal_production >= 0),
            team_overrides bigint not null default 0 check (team_overrides >= 0),
            vouches int not null default 0 check (vouches >= 0),
            admin_vouches int not null default 0 check (admin_vouches >= 0),
            vetoes int not null default 0 check (vetoes >= 0),
            admin_vetoes int not null default 0 check (admin_vetoes >= 0),
            payout_notifications_enabled boolean not null default true,
            rank_name text not null default 'Penguin Soldier' references ranks(name),
            staff_rank_name text references staff_ranks(name),
            ban_points_remaining int not null default 0 check (ban_points_remaining >= 0),
            status text not null default 'active',
            welcome_reminder_sent_at timestamptz,
            account_link_reminder_sent_at timestamptz,
            account_link_reminders_disabled boolean not null default false,
            first_captain_branch_notified_at timestamptz,
            first_general_branch_notified_at timestamptz,
            first_emperor_branch_notified_at timestamptz,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            constraint player_cannot_be_own_parent
                check (parent_discord_id is null or parent_discord_id <> discord_id)
        )
    `;

    await sql`
        alter table players
        add column if not exists discord_display_name text
    `;

    await sql`
        alter table players
        add column if not exists minecraft_ign text
    `;

    await sql`
        alter table players
        add column if not exists minecraft_edition text check (minecraft_edition in ('java', 'bedrock'))
    `;

    await sql`
        alter table players
        add column if not exists joined_invite_code text
    `;

    await sql`
        alter table players
        add column if not exists joined_via_inviter_discord_id text
    `;

    await sql`
        alter table players
        add column if not exists claims_available int not null default 0
    `;

    await sql`
        alter table players
        add column if not exists donations bigint not null default 0 check (donations >= 0)
    `;

    await sql`
        alter table players
        add column if not exists unpaid_commissions bigint not null default 0 check (unpaid_commissions >= 0)
    `;

    await sql`
        alter table players
        add column if not exists personal_production bigint not null default 0 check (personal_production >= 0)
    `;

    await sql`
        alter table players
        add column if not exists team_overrides bigint not null default 0 check (team_overrides >= 0)
    `;

    await sql`
        alter table players
        add column if not exists vouches int not null default 0 check (vouches >= 0)
    `;

    await sql`
        alter table players
        add column if not exists admin_vouches int not null default 0 check (admin_vouches >= 0)
    `;

    await sql`
        alter table players
        add column if not exists vetoes int not null default 0 check (vetoes >= 0)
    `;

    await sql`
        alter table players
        add column if not exists admin_vetoes int not null default 0 check (admin_vetoes >= 0)
    `;

    await sql`
        alter table players
        add column if not exists payout_notifications_enabled boolean not null default true
    `;

    await sql`
        alter table players
        add column if not exists welcome_reminder_sent_at timestamptz
    `;

    await sql`
        alter table players
        add column if not exists account_link_reminder_sent_at timestamptz
    `;

    await sql`
        alter table players
        add column if not exists account_link_reminders_disabled boolean not null default false
    `;

    await sql`
        alter table players
        add column if not exists first_captain_branch_notified_at timestamptz
    `;

    await sql`
        alter table players
        add column if not exists first_general_branch_notified_at timestamptz
    `;

    await sql`
        alter table players
        add column if not exists first_emperor_branch_notified_at timestamptz
    `;

    await sql`
        create table if not exists vc_levels (
            guild_id text not null,
            discord_id text not null,
            voice_seconds bigint not null default 0 check (voice_seconds >= 0),
            voice_minutes bigint not null default 0 check (voice_minutes >= 0),
            voice_xp bigint not null default 0 check (voice_xp >= 0),
            announced_level int default 0 check (announced_level is null or announced_level >= 0),
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            primary key (guild_id, discord_id)
        )
    `;

    await sql`
        alter table vc_levels
        add column if not exists voice_seconds bigint not null default 0 check (voice_seconds >= 0)
    `;

    await sql`
        alter table vc_levels
        add column if not exists announced_level int check (announced_level is null or announced_level >= 0)
    `;

    await sql`
        alter table vc_levels
        alter column announced_level set default 0
    `;

    await sql`
        update vc_levels
        set voice_seconds = voice_minutes * 60
        where voice_seconds = 0
            and voice_minutes > 0
    `;

    await sql`
        create table if not exists vc_active_sessions (
            guild_id text not null,
            discord_id text not null,
            channel_id text not null,
            started_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            primary key (guild_id, discord_id)
        )
    `;

    await sql`
        create table if not exists vc_level_ticks (
            guild_id text not null,
            tick_bucket timestamptz not null,
            created_at timestamptz not null default now(),
            primary key (guild_id, tick_bucket)
        )
    `;

    await sql`
        create table if not exists teams (
            id bigserial primary key,
            guild_id text not null,
            name text not null,
            normalized_name text not null,
            color int not null check (color >= 0 and color <= 16777215),
            owner_discord_id text references players(discord_id) on delete set null,
            role_id text,
            channel_id text,
            status text not null default 'active' check (status in ('active', 'archived')),
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            archived_at timestamptz
        )
    `;

    await sql`
        alter table teams
        add column if not exists normalized_name text
    `;

    await sql`
        alter table teams
        add column if not exists color int not null default 0 check (color >= 0 and color <= 16777215)
    `;

    await sql`
        alter table teams
        add column if not exists owner_discord_id text references players(discord_id) on delete set null
    `;

    await sql`
        alter table teams
        add column if not exists role_id text
    `;

    await sql`
        alter table teams
        add column if not exists channel_id text
    `;

    await sql`
        alter table teams
        add column if not exists status text not null default 'active'
    `;

    await sql`
        alter table teams
        add column if not exists archived_at timestamptz
    `;

    await sql`
        update teams
        set
            normalized_name = lower(regexp_replace(trim(name), '\\s+', ' ', 'g')),
            updated_at = now()
        where normalized_name is null
            or normalized_name = ''
    `;

    await sql`
        alter table teams
        alter column normalized_name set not null
    `;

    await sql`
        alter table teams
        drop constraint if exists teams_status_check
    `;

    await sql`
        alter table teams
        add constraint teams_status_check check (status in ('active', 'archived'))
    `;

    await sql`
        alter table players
        add column if not exists team_id bigint references teams(id) on delete set null
    `;

    await sql`
        create table if not exists team_create_requests (
            id bigserial primary key,
            guild_id text not null,
            owner_discord_id text not null references players(discord_id) on delete cascade,
            requested_by_discord_id text not null,
            name text not null,
            normalized_name text not null,
            color int not null check (color >= 0 and color <= 16777215),
            status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'failed')),
            team_id bigint references teams(id) on delete set null,
            decision_by_discord_id text,
            decision_note text,
            requested_at timestamptz not null default now(),
            decided_at timestamptz,
            updated_at timestamptz not null default now()
        )
    `;

    await sql`
        alter table team_create_requests
        add column if not exists normalized_name text
    `;

    await sql`
        update team_create_requests
        set
            normalized_name = lower(regexp_replace(trim(name), '\\s+', ' ', 'g')),
            updated_at = now()
        where normalized_name is null
            or normalized_name = ''
    `;

    await sql`
        alter table team_create_requests
        alter column normalized_name set not null
    `;

    await sql`
        alter table team_create_requests
        add column if not exists decision_note text
    `;

    await sql`
        alter table team_create_requests
        drop constraint if exists team_create_requests_status_check
    `;

    await sql`
        alter table team_create_requests
        add constraint team_create_requests_status_check check (status in ('pending', 'approved', 'rejected', 'failed'))
    `;

    await sql`
        create table if not exists elections (
            id bigserial primary key,
            status text not null default 'active' check (status in ('active', 'ended', 'cancelled')),
            started_at timestamptz not null default now(),
            ends_at timestamptz not null,
            created_by_discord_id text not null,
            ended_at timestamptz,
            ended_by_discord_id text,
            leaderboard_message_id text,
            pre_start_message_id text,
            board_reset_at timestamptz
        )
    `;

    await sql`
        alter table elections
        add column if not exists board_reset_at timestamptz
    `;

    await sql`
        create table if not exists election_votes (
            election_id bigint not null references elections(id) on delete cascade,
            voter_discord_id text not null references players(discord_id) on delete cascade,
            target_discord_id text not null references players(discord_id) on delete cascade,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            primary key (election_id, voter_discord_id)
        )
    `;

    await sql`
        create table if not exists election_exclusions (
            election_id bigint not null references elections(id) on delete cascade,
            player_discord_id text not null references players(discord_id) on delete cascade,
            removed_by_discord_id text not null,
            created_at timestamptz not null default now(),
            primary key (election_id, player_discord_id)
        )
    `;

    await sql`
        create table if not exists giveaways (
            id bigserial primary key,
            guild_id text not null,
            channel_id text not null,
            message_id text,
            host_discord_id text not null references players(discord_id) on delete cascade,
            amount bigint not null check (amount > 0),
            status text not null default 'active' check (status in ('active', 'ended', 'cancelled')),
            starts_at timestamptz not null default now(),
            ends_at timestamptz not null,
            ended_at timestamptz,
            winner_discord_id text references players(discord_id) on delete set null,
            cleanup_due_at timestamptz,
            cleanup_message_ids jsonb not null default '[]'::jsonb,
            cleaned_at timestamptz
        )
    `;

    await sql`
        alter table giveaways
        add column if not exists cleanup_due_at timestamptz
    `;

    await sql`
        alter table giveaways
        add column if not exists cleanup_message_ids jsonb not null default '[]'::jsonb
    `;

    await sql`
        alter table giveaways
        add column if not exists cleaned_at timestamptz
    `;

    await sql`
        create table if not exists giveaway_entries (
            giveaway_id bigint not null references giveaways(id) on delete cascade,
            player_discord_id text not null references players(discord_id) on delete cascade,
            entered_at timestamptz not null default now(),
            primary key (giveaway_id, player_discord_id)
        )
    `;

    await sql`
        create table if not exists giveaway_payment_requests (
            id bigserial primary key,
            guild_id text not null,
            channel_id text not null,
            host_discord_id text not null references players(discord_id) on delete cascade,
            host_minecraft_ign text not null,
            payment_bot_user text not null,
            amount bigint not null check (amount > 0),
            duration_ms bigint not null check (duration_ms > 0),
            status text not null default 'pending' check (status in ('pending', 'processing', 'hosted', 'cancelled', 'failed')),
            paid_amount bigint,
            payment_message text,
            giveaway_id bigint references giveaways(id) on delete set null,
            created_at timestamptz not null default now(),
            paid_at timestamptz,
            updated_at timestamptz not null default now()
        )
    `;

    await sql`
        create table if not exists donation_payment_requests (
            id bigserial primary key,
            guild_id text not null,
            donor_discord_id text not null references players(discord_id) on delete cascade,
            donor_minecraft_ign text not null,
            payment_bot_user text not null,
            amount bigint not null check (amount > 0),
            status text not null default 'pending' check (status in ('pending', 'processing', 'recorded', 'cancelled', 'failed')),
            paid_amount bigint,
            payment_message text,
            created_at timestamptz not null default now(),
            paid_at timestamptz,
            updated_at timestamptz not null default now()
        )
    `;

    await sql`
        create table if not exists staff_application_review_status (
            channel_id text primary key,
            guild_id text not null,
            applicant_discord_id text not null,
            opened_at timestamptz not null default now(),
            approved_notified_at timestamptz,
            vetoed_at timestamptz,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
        )
    `;

    await sql`
        create table if not exists staff_application_reviews (
            id bigserial primary key,
            guild_id text not null,
            channel_id text not null references staff_application_review_status(channel_id) on delete cascade,
            applicant_discord_id text not null,
            reviewer_discord_id text not null,
            action text not null check (action in ('accept', 'veto')),
            reason text not null,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            unique (channel_id, reviewer_discord_id)
        )
    `;

    await sql`
        alter table staff_application_reviews
        drop constraint if exists staff_application_reviews_action_check
    `;

    await sql`
        alter table staff_application_reviews
        add constraint staff_application_reviews_action_check check (action in ('accept', 'veto'))
    `;

    await sql`
        create index if not exists idx_staff_application_reviews_channel_action
        on staff_application_reviews(channel_id, action)
    `;

    await sql`
        create index if not exists idx_staff_application_review_status_pending
        on staff_application_review_status(guild_id, opened_at)
        where approved_notified_at is null
            and vetoed_at is null
    `;

    await sql`
        create table if not exists team_monthly_rewards (
            id bigserial primary key,
            guild_id text not null,
            reward_month timestamptz not null,
            team_id bigint references teams(id) on delete set null,
            team_name text not null,
            recruit_count int not null default 0 check (recruit_count >= 0),
            prize_amount bigint not null check (prize_amount > 0),
            payer_minecraft_ign text not null default 'rainbowbeltzz',
            member_recruits jsonb not null default '[]'::jsonb,
            payout_summary jsonb not null default '{}'::jsonb,
            status text not null default 'pending_payment' check (
                status in ('pending_payment', 'processing', 'payouts_queued', 'finished', 'failed', 'cancelled')
            ),
            paid_amount bigint,
            payment_message text,
            paid_at timestamptz,
            payout_enqueued_at timestamptz,
            finished_at timestamptz,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            unique (guild_id, reward_month)
        )
    `;

    await sql`
        alter table team_monthly_rewards
        drop constraint if exists team_monthly_rewards_status_check
    `;

    await sql`
        alter table team_monthly_rewards
        add constraint team_monthly_rewards_status_check check (
            status in ('pending_payment', 'processing', 'payouts_queued', 'finished', 'failed', 'cancelled')
        )
    `;

    await sql`
        create index if not exists idx_team_monthly_rewards_pending_payment
        on team_monthly_rewards(guild_id, lower(payer_minecraft_ign), reward_month)
        where status = 'pending_payment'
    `;

    await sql`
        create table if not exists player_vouches (
            target_discord_id text not null references players(discord_id) on delete cascade,
            voucher_discord_id text not null references players(discord_id) on delete cascade,
            created_at timestamptz not null default now(),
            primary key (target_discord_id, voucher_discord_id)
        )
    `;

    await sql`
        create table if not exists player_admin_vouches (
            target_discord_id text not null references players(discord_id) on delete cascade,
            admin_discord_id text not null references players(discord_id) on delete cascade,
            created_at timestamptz not null default now(),
            primary key (target_discord_id, admin_discord_id)
        )
    `;

    await sql`
        create table if not exists player_admin_vetoes (
            target_discord_id text not null references players(discord_id) on delete cascade,
            admin_discord_id text not null references players(discord_id) on delete cascade,
            created_at timestamptz not null default now(),
            primary key (target_discord_id, admin_discord_id)
        )
    `;

    await sql`
        alter table donation_payment_requests
        drop constraint if exists donation_payment_requests_status_check
    `;

    await sql`
        alter table donation_payment_requests
        add constraint donation_payment_requests_status_check check (
            status in ('pending', 'processing', 'recorded', 'cancelled', 'failed')
        )
    `;

    await sql`
        create table if not exists giveaway_boards (
            guild_id text primary key,
            channel_id text not null,
            message_id text not null,
            updated_at timestamptz not null default now()
        )
    `;

    await sql`
        create table if not exists giveaway_payout_batches (
            giveaway_id bigint primary key references giveaways(id) on delete cascade,
            guild_id text not null,
            winner_discord_id text references players(discord_id) on delete set null,
            payout_result jsonb not null default '{}'::jsonb,
            status text not null default 'pending' check (status in ('pending', 'processing', 'finished')),
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            finished_at timestamptz,
            log_sent_at timestamptz
        )
    `;

    await sql`
        create table if not exists giveaway_payout_jobs (
            id bigserial primary key,
            giveaway_id bigint not null references giveaways(id) on delete cascade,
            guild_id text not null,
            recipient_discord_id text not null references players(discord_id) on delete cascade,
            minecraft_name text,
            amount_cents bigint not null check (amount_cents > 0),
            payout_payload jsonb not null default '{}'::jsonb,
            is_winner boolean not null default false,
            status text not null default 'pending' check (
                status in ('pending', 'processing', 'paid', 'credited', 'credit_failed', 'failed', 'skipped', 'manual_review')
            ),
            attempts int not null default 0 check (attempts >= 0),
            reason text,
            response text,
            error text,
            balance_before text,
            balance_after text,
            command_sent_at timestamptz,
            processing_started_at timestamptz,
            paid_at timestamptz,
            credited_at timestamptz,
            earnings_recorded_at timestamptz,
            notification_sent_at timestamptz,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            unique (giveaway_id, recipient_discord_id)
        )
    `;

    await sql`
        alter table giveaway_payout_jobs
        drop constraint if exists giveaway_payout_jobs_status_check
    `;

    await sql`
        alter table giveaway_payout_jobs
        add constraint giveaway_payout_jobs_status_check check (
            status in ('pending', 'processing', 'paid', 'credited', 'credit_failed', 'failed', 'skipped', 'manual_review')
        )
    `;

    await sql`
        create index if not exists idx_giveaways_active_end
        on giveaways(guild_id, status, ends_at)
    `;

    await sql`
        create index if not exists idx_giveaway_payment_requests_pending
        on giveaway_payment_requests(guild_id, lower(host_minecraft_ign), amount, created_at)
        where status = 'pending'
    `;

    await sql`
        create index if not exists idx_donation_payment_requests_pending
        on donation_payment_requests(guild_id, lower(donor_minecraft_ign), amount, created_at)
        where status = 'pending'
    `;

    await sql`
        create index if not exists idx_player_vouches_voucher
        on player_vouches(voucher_discord_id, created_at)
    `;

    await sql`
        create index if not exists idx_player_admin_vouches_admin
        on player_admin_vouches(admin_discord_id, created_at)
    `;

    await sql`
        create index if not exists idx_player_admin_vetoes_admin
        on player_admin_vetoes(admin_discord_id, created_at)
    `;

    await sql`
        create index if not exists idx_giveaways_cleanup_due
        on giveaways(guild_id, cleanup_due_at)
        where cleaned_at is null
    `;

    await sql`
        create index if not exists idx_giveaway_payout_jobs_pending
        on giveaway_payout_jobs(guild_id, status, created_at, id)
        where status in ('pending', 'processing')
    `;

    await sql`
        create index if not exists idx_giveaway_payout_jobs_giveaway
        on giveaway_payout_jobs(giveaway_id, status)
    `;

    await sql`
        create table if not exists commission_payout_jobs (
            id bigserial primary key,
            guild_id text not null,
            recipient_discord_id text not null references players(discord_id) on delete cascade,
            minecraft_name text,
            amount_cents bigint not null check (amount_cents > 0),
            status text not null default 'pending' check (
                status in ('pending', 'processing', 'paid', 'failed', 'skipped', 'manual_review')
            ),
            attempts int not null default 0 check (attempts >= 0),
            reason text,
            response text,
            error text,
            balance_before text,
            balance_after text,
            command_sent_at timestamptz,
            processing_started_at timestamptz,
            paid_at timestamptz,
            deducted_at timestamptz,
            notification_sent_at timestamptz,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
        )
    `;

    await sql`
        alter table commission_payout_jobs
        drop constraint if exists commission_payout_jobs_status_check
    `;

    await sql`
        alter table commission_payout_jobs
        add constraint commission_payout_jobs_status_check check (
            status in ('pending', 'processing', 'paid', 'failed', 'skipped', 'manual_review')
        )
    `;

    await sql`
        create index if not exists idx_commission_payout_jobs_pending
        on commission_payout_jobs(guild_id, status, created_at, id)
        where status in ('pending', 'processing')
    `;

    await sql`
        create unique index if not exists idx_commission_payout_jobs_open_recipient
        on commission_payout_jobs(guild_id, recipient_discord_id)
        where status in ('pending', 'processing', 'manual_review')
    `;

    await sql`
        create table if not exists hourly_recruit_rewards (
            id bigserial primary key,
            guild_id text not null,
            reward_type text not null default 'hourly',
            reward_hour timestamptz not null,
            placement int not null default 1 check (placement > 0),
            winner_discord_id text references players(discord_id) on delete set null,
            recruit_count int not null default 0 check (recruit_count >= 0),
            prize_amount bigint not null check (prize_amount > 0),
            payout_result jsonb not null default '{}'::jsonb,
            status text not null default 'pending' check (status in ('pending', 'processing', 'finished')),
            channel_id text,
            message_id text,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            finished_at timestamptz,
            log_sent_at timestamptz,
            unique (guild_id, reward_hour)
        )
    `;

    await sql`
        alter table hourly_recruit_rewards
        add column if not exists reward_type text not null default 'hourly'
    `;

    await sql`
        alter table hourly_recruit_rewards
        add column if not exists placement int not null default 1 check (placement > 0)
    `;

    await sql`
        alter table hourly_recruit_rewards
        drop constraint if exists hourly_recruit_rewards_guild_id_reward_hour_key
    `;

    await sql`
        create unique index if not exists idx_hourly_recruit_rewards_type_period_place
        on hourly_recruit_rewards(guild_id, reward_type, reward_hour, placement)
    `;

    await sql`
        create table if not exists hourly_recruit_reward_payout_jobs (
            id bigserial primary key,
            reward_id bigint not null references hourly_recruit_rewards(id) on delete cascade,
            guild_id text not null,
            recipient_discord_id text not null references players(discord_id) on delete cascade,
            minecraft_name text,
            amount_cents bigint not null check (amount_cents > 0),
            payout_payload jsonb not null default '{}'::jsonb,
            is_winner boolean not null default false,
            status text not null default 'pending' check (
                status in ('pending', 'processing', 'paid', 'credited', 'credit_failed', 'failed', 'skipped', 'manual_review')
            ),
            attempts int not null default 0 check (attempts >= 0),
            reason text,
            response text,
            error text,
            balance_before text,
            balance_after text,
            command_sent_at timestamptz,
            processing_started_at timestamptz,
            paid_at timestamptz,
            credited_at timestamptz,
            earnings_recorded_at timestamptz,
            notification_sent_at timestamptz,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            unique (reward_id, recipient_discord_id)
        )
    `;

    await sql`
        alter table hourly_recruit_rewards
        drop constraint if exists hourly_recruit_rewards_status_check
    `;

    await sql`
        alter table hourly_recruit_rewards
        add constraint hourly_recruit_rewards_status_check check (
            status in ('pending', 'processing', 'finished')
        )
    `;

    await sql`
        alter table hourly_recruit_reward_payout_jobs
        drop constraint if exists hourly_recruit_reward_payout_jobs_status_check
    `;

    await sql`
        alter table hourly_recruit_reward_payout_jobs
        add column if not exists earnings_recorded_at timestamptz
    `;

    await sql`
        alter table hourly_recruit_reward_payout_jobs
        add constraint hourly_recruit_reward_payout_jobs_status_check check (
            status in ('pending', 'processing', 'paid', 'credited', 'credit_failed', 'failed', 'skipped', 'manual_review')
        )
    `;

    await sql`
        create index if not exists idx_hourly_recruit_rewards_pending
        on hourly_recruit_rewards(guild_id, status, reward_hour)
        where status in ('pending', 'processing')
    `;

    await sql`
        create index if not exists idx_hourly_recruit_reward_jobs_pending
        on hourly_recruit_reward_payout_jobs(guild_id, status, created_at, id)
        where status in ('pending', 'processing')
    `;

    await sql`
        create index if not exists idx_hourly_recruit_reward_jobs_reward
        on hourly_recruit_reward_payout_jobs(reward_id, status)
    `;

    await sql`
        update giveaway_payout_batches
        set
            payout_result = (payout_result #>> '{}')::jsonb,
            updated_at = now()
        where jsonb_typeof(payout_result) = 'string'
    `;

    await sql`
        update giveaway_payout_jobs
        set
            payout_payload = (payout_payload #>> '{}')::jsonb,
            updated_at = now()
        where jsonb_typeof(payout_payload) = 'string'
    `;

    await sql`
        with unrecorded_hourly_jobs as (
            select
                id,
                recipient_discord_id,
                amount_cents,
                is_winner
            from hourly_recruit_reward_payout_jobs
            where status in ('paid', 'credited')
                and earnings_recorded_at is null
        ),
        player_totals as (
            select
                recipient_discord_id,
                coalesce(sum(amount_cents) filter (where is_winner = true), 0)::bigint as personal_amount,
                coalesce(sum(amount_cents) filter (where is_winner = false), 0)::bigint as override_amount
            from unrecorded_hourly_jobs
            group by recipient_discord_id
        ),
        updated_players as (
            update players player
            set
                personal_production = personal_production + player_totals.personal_amount,
                team_overrides = team_overrides + player_totals.override_amount,
                updated_at = now()
            from player_totals
            where player.discord_id = player_totals.recipient_discord_id
            returning player.discord_id
        )
        update hourly_recruit_reward_payout_jobs job
        set
            earnings_recorded_at = now(),
            updated_at = now()
        from unrecorded_hourly_jobs
        where job.id = unrecorded_hourly_jobs.id
            and exists (
                select 1
                from updated_players
                where updated_players.discord_id = unrecorded_hourly_jobs.recipient_discord_id
            )
    `;

    await sql`
        update giveaways
        set cleanup_message_ids = (cleanup_message_ids #>> '{}')::jsonb
        where jsonb_typeof(cleanup_message_ids) = 'string'
    `;

    await sql`
        alter table players
        add column if not exists welcome_completed boolean not null default true
    `;

    await sql`
        alter table players
        add column if not exists direct_recruits_count int not null default 0 check (direct_recruits_count >= 0)
    `;

    await sql`
        alter table players
        add column if not exists weekly_direct_recruits_count int not null default 0 check (weekly_direct_recruits_count >= 0)
    `;

    await sql`
        alter table players
        add column if not exists captain_direct_recruits_count int not null default 0 check (captain_direct_recruits_count >= 0)
    `;

    await sql`
        alter table players
        add column if not exists transferred_at timestamptz
    `;

    await sql`
        update players
        set captain_direct_recruits_count = direct_recruits_count
        where captain_direct_recruits_count <> direct_recruits_count
    `;

    await sql`
        alter table players
        add column if not exists reached_captain_at timestamptz
    `;

    await sql`
        alter table players
        add column if not exists captain_leaderboard_disqualified boolean not null default false
    `;

    await sql`
        create table if not exists captain_speed_runs (
            id bigserial primary key,
            discord_id text not null references players(discord_id) on delete cascade,
            started_at timestamptz not null,
            reached_captain_at timestamptz not null,
            promotion_seconds bigint not null check (promotion_seconds >= 0),
            counts_for_monthly boolean not null default true,
            created_at timestamptz not null default now(),
            unique (discord_id, reached_captain_at)
        )
    `;

    await sql`
        insert into captain_speed_runs (
            discord_id,
            started_at,
            reached_captain_at,
            promotion_seconds
        )
        select
            discord_id,
            created_at,
            reached_captain_at,
            greatest(0, floor(extract(epoch from (reached_captain_at - created_at))))::bigint
        from players
        where reached_captain_at is not null
            and created_at is not null
        on conflict (discord_id, reached_captain_at) do nothing
    `;

    await sql`
        create or replace function record_captain_speed_run()
        returns trigger
        language plpgsql
        as $$
        begin
            if new.reached_captain_at is not null
                and new.created_at is not null
                and new.reached_captain_at is distinct from old.reached_captain_at
            then
                insert into captain_speed_runs (
                    discord_id,
                    started_at,
                    reached_captain_at,
                    promotion_seconds
                )
                values (
                    new.discord_id,
                    new.created_at,
                    new.reached_captain_at,
                    greatest(0, floor(extract(epoch from (new.reached_captain_at - new.created_at))))::bigint
                )
                on conflict (discord_id, reached_captain_at) do nothing;
            end if;

            return new;
        end;
        $$
    `;

    await sql`
        drop trigger if exists record_captain_speed_run_after_update on players
    `;

    await sql`
        create trigger record_captain_speed_run_after_update
        after update of reached_captain_at on players
        for each row
        execute function record_captain_speed_run()
    `;

    await sql`
        create table if not exists recruit_history (
            recruit_discord_id text primary key,
            recruiter_discord_id text not null,
            recruited_at timestamptz not null default now(),
            counts_for_hourly boolean not null default true
        )
    `;

    await sql`
        alter table recruit_history
        add column if not exists counts_for_hourly boolean not null default true
    `;

    await sql`
        insert into recruit_history (
            recruit_discord_id,
            recruiter_discord_id,
            recruited_at,
            counts_for_hourly
        )
        select
            discord_id,
            parent_discord_id,
            created_at,
            true
        from players
        where parent_discord_id is not null
        on conflict (recruit_discord_id) do nothing
    `;

    await sql`
        create index if not exists idx_recruit_history_recruited_at
        on recruit_history(recruited_at)
    `;

    await sql`
        create index if not exists idx_recruit_history_recruiter_time
        on recruit_history(recruiter_discord_id, recruited_at)
    `;

    await sql`
        alter table players
        alter column donations type bigint
    `;

    await sql`
        alter table players
        add column if not exists rank_name text not null default 'Penguin Soldier'
    `;

    await sql`
        alter table players
        add column if not exists staff_rank_name text
    `;

    await sql`
        alter table players
        add column if not exists ban_points_remaining int not null default 0 check (ban_points_remaining >= 0)
    `;

    await sql`
        update players
        set rank_name = ${DEFAULT_RANK_NAME}
        where rank_name is null
    `;

    await sql`
        update players
        set rank_name = ${DEFAULT_RANK_NAME}
        where rank_name not in (
            select name
            from ranks
        )
    `;

    await sql`
        update players
        set staff_rank_name = null
        where staff_rank_name is not null
            and staff_rank_name not in (
                select name
                from staff_ranks
            )
    `;

    await sql`
        update players player
        set
            ban_points_remaining = least(player.ban_points_remaining, coalesce(staff.ban_point_limit, 0)),
            updated_at = now()
        from staff_ranks staff
        where player.staff_rank_name = staff.name
            and player.ban_points_remaining > staff.ban_point_limit
    `;

    await sql`
        update players
        set
            ban_points_remaining = 0,
            updated_at = now()
        where staff_rank_name is null
            and ban_points_remaining <> 0
    `;

    await sql`
        do $$
        begin
            if not exists (
                select 1
                from pg_constraint
                where conname = 'players_rank_name_fkey'
            ) then
                alter table players
                add constraint players_rank_name_fkey
                foreign key (rank_name)
                references ranks(name);
            end if;
        end $$;
    `;

    await sql`
        do $$
        begin
            if not exists (
                select 1
                from pg_constraint
                where conname = 'players_staff_rank_name_fkey'
            ) then
                alter table players
                add constraint players_staff_rank_name_fkey
                foreign key (staff_rank_name)
                references staff_ranks(name);
            end if;
        end $$;
    `;

    await sql`
        create index if not exists idx_players_parent_discord_id
        on players(parent_discord_id)
    `;

    await sql`
        create index if not exists idx_players_status
        on players(status)
    `;

    await sql`
        create index if not exists idx_players_minecraft_ign
        on players(minecraft_ign)
    `;

    await sql`
        create index if not exists idx_players_discord_display_name
        on players(discord_display_name)
    `;

    await sql`
        create index if not exists idx_players_rank_name
        on players(rank_name)
    `;

    await sql`
        create index if not exists idx_players_staff_rank_name
        on players(staff_rank_name)
    `;

    await sql`
        create index if not exists idx_players_team_id
        on players(team_id)
    `;

    await sql`
        create index if not exists idx_teams_guild_status
        on teams(guild_id, status)
    `;

    await sql`
        create index if not exists idx_teams_owner
        on teams(guild_id, owner_discord_id)
    `;

    await sql`
        create unique index if not exists idx_teams_active_name
        on teams(guild_id, normalized_name)
        where status = 'active'
    `;

    await sql`
        create unique index if not exists idx_teams_active_owner
        on teams(guild_id, owner_discord_id)
        where status = 'active'
            and owner_discord_id is not null
    `;

    await sql`
        create index if not exists idx_team_create_requests_pending_owner
        on team_create_requests(guild_id, owner_discord_id, requested_at)
        where status = 'pending'
    `;

    await sql`
        update players player
        set direct_recruits_count = counts.direct_count
        from (
            select
                recruiter.discord_id,
                count(recruit.discord_id)::int as direct_count
            from players recruiter
            left join players recruit
                on recruit.parent_discord_id = recruiter.discord_id
            group by recruiter.discord_id
        ) counts
        where player.discord_id = counts.discord_id
            and player.direct_recruits_count <> counts.direct_count
    `;

    await sql`
        create or replace function current_weekly_recruit_started_at()
        returns timestamptz as $$
        declare
            local_now timestamp;
            friday_noon timestamp;
            scheduled_start timestamptz;
            manual_reset timestamptz;
        begin
            local_now := now() at time zone 'America/Toronto';
            friday_noon := date_trunc('week', local_now) + interval '4 days 12 hours';
            scheduled_start := (
                case
                    when local_now >= friday_noon then friday_noon
                    else friday_noon - interval '7 days'
                end
            ) at time zone 'America/Toronto';

            begin
                select value::timestamptz
                into manual_reset
                from bot_state
                where key = 'weekly_recruits_last_reset_at'
                limit 1;
            exception when others then
                manual_reset := null;
            end;

            return greatest(
                coalesce(manual_reset, '-infinity'::timestamptz),
                scheduled_start
            );
        end;
        $$ language plpgsql stable
    `;

    await sql`
        create or replace function prevent_player_cycle()
        returns trigger as $$
        declare
            current_parent text;
        begin
            if new.parent_discord_id is null then
                return new;
            end if;

            if new.parent_discord_id = new.discord_id then
                raise exception 'A player cannot be their own recruiter.';
            end if;

            current_parent := new.parent_discord_id;

            while current_parent is not null loop
                if current_parent = new.discord_id then
                    raise exception 'Invalid recruiter: a player cannot be placed under their own recruit or descendant.';
                end if;

                select parent_discord_id
                into current_parent
                from players
                where discord_id = current_parent;
            end loop;

            return new;
        end;
        $$ language plpgsql
    `;

    await sql`
        drop trigger if exists trg_prevent_player_cycle on players
    `;

    await sql`
        create trigger trg_prevent_player_cycle
        before insert or update of parent_discord_id
        on players
        for each row
        execute function prevent_player_cycle()
    `;

    await sql`
        create or replace function track_direct_recruits()
        returns trigger as $$
        begin
            if tg_op = 'INSERT' then
                if new.parent_discord_id is not null and new.welcome_completed then
                    update players
                    set
                        direct_recruits_count = direct_recruits_count + 1,
                        weekly_direct_recruits_count = weekly_direct_recruits_count + 1,
                        captain_direct_recruits_count = captain_direct_recruits_count + 1,
                        rank_name = case
                            when captain_direct_recruits_count + 1 >= 3 and rank_name = 'Penguin Soldier' then 'Penguin Captain'
                            else rank_name
                        end,
                        reached_captain_at = case
                            when captain_direct_recruits_count + 1 >= 3 and rank_name = 'Penguin Soldier' then coalesce(reached_captain_at, now())
                            else reached_captain_at
                        end,
                        updated_at = now()
                    where discord_id = new.parent_discord_id;
                end if;

                return new;
            end if;

            if tg_op = 'UPDATE' then
                if old.parent_discord_id is distinct from new.parent_discord_id then
                    if old.parent_discord_id is not null and old.welcome_completed then
                        update players
                        set
                            direct_recruits_count = greatest(direct_recruits_count - 1, 0),
                            captain_direct_recruits_count = greatest(captain_direct_recruits_count - 1, 0),
                            updated_at = now()
                        where discord_id = old.parent_discord_id;
                    end if;

                    if new.parent_discord_id is not null and new.welcome_completed then
                        update players
                        set
                            direct_recruits_count = direct_recruits_count + 1,
                            weekly_direct_recruits_count = weekly_direct_recruits_count + case
                                when old.parent_discord_id is null then 1
                                else 0
                            end,
                            updated_at = now()
                        where discord_id = new.parent_discord_id;
                    end if;

                    update players
                    set transferred_at = coalesce(transferred_at, now()), updated_at = now()
                    where discord_id = new.discord_id;
                end if;

                return new;
            end if;

            if tg_op = 'DELETE' then
                if old.parent_discord_id is not null and old.welcome_completed then
                    update players
                    set
                        direct_recruits_count = greatest(direct_recruits_count - 1, 0),
                        captain_direct_recruits_count = greatest(captain_direct_recruits_count - 1, 0),
                        weekly_direct_recruits_count = greatest(
                            weekly_direct_recruits_count - case
                                when exists (
                                    select 1
                                    from recruit_history history
                                    where history.recruit_discord_id = old.discord_id
                                        and history.recruiter_discord_id = old.parent_discord_id
                                        and history.counts_for_hourly = true
                                        and history.recruited_at >= current_weekly_recruit_started_at()
                                ) then 1
                                else 0
                            end,
                            0
                        ),
                        updated_at = now()
                    where discord_id = old.parent_discord_id;
                end if;

                update recruit_history
                set counts_for_hourly = false
                where recruit_discord_id = old.discord_id
                    and counts_for_hourly = true;

                return old;
            end if;

            return null;
        end;
        $$ language plpgsql
    `;

    await sql`
        drop trigger if exists trg_track_direct_recruits on players
    `;

    await sql`
        create trigger trg_track_direct_recruits
        after insert or update or delete
        on players
        for each row
        execute function track_direct_recruits()
    `;

    await sql`
        create or replace function record_first_recruit()
        returns trigger as $$
        begin
            if new.parent_discord_id is not null and new.welcome_completed then
                insert into recruit_history (
                    recruit_discord_id,
                    recruiter_discord_id,
                    recruited_at,
                    counts_for_hourly
                )
                values (
                    new.discord_id,
                    new.parent_discord_id,
                    now(),
                    true
                )
                on conflict (recruit_discord_id) do nothing;
            end if;

            return new;
        end;
        $$ language plpgsql
    `;

    await sql`
        drop trigger if exists trg_record_first_recruit on players
    `;

    await sql`
        create trigger trg_record_first_recruit
        after insert or update of parent_discord_id
        on players
        for each row
        when (new.parent_discord_id is not null)
        execute function record_first_recruit()
    `;

    await sql`
        create or replace function count_recruit_on_welcome()
        returns trigger as $$
        begin
            if old.welcome_completed = false and new.welcome_completed = true
                and new.parent_discord_id is not null
            then
                if not exists (
                    select 1 from recruit_history
                    where recruit_discord_id = new.discord_id
                ) then
                    update players
                    set
                        direct_recruits_count = direct_recruits_count + 1,
                        weekly_direct_recruits_count = weekly_direct_recruits_count + 1,
                        captain_direct_recruits_count = captain_direct_recruits_count + 1,
                        rank_name = case
                            when captain_direct_recruits_count + 1 >= 3 and rank_name = 'Penguin Soldier' then 'Penguin Captain'
                            else rank_name
                        end,
                        reached_captain_at = case
                            when captain_direct_recruits_count + 1 >= 3 and rank_name = 'Penguin Soldier' then coalesce(reached_captain_at, now())
                            else reached_captain_at
                        end,
                        updated_at = now()
                    where discord_id = new.parent_discord_id;

                    insert into recruit_history (
                        recruit_discord_id, recruiter_discord_id,
                        recruited_at, counts_for_hourly
                    ) values (
                        new.discord_id, new.parent_discord_id,
                        now(), true
                    )
                    on conflict (recruit_discord_id) do nothing;
                end if;
            end if;

            return new;
        end;
        $$ language plpgsql
    `;

    await sql`
        drop trigger if exists trg_count_recruit_on_welcome on players
    `;

    await sql`
        create trigger trg_count_recruit_on_welcome
        after update of welcome_completed
        on players
        for each row
        when (old.welcome_completed = false and new.welcome_completed = true)
        execute function count_recruit_on_welcome()
    `;

    await sql`
        create table if not exists ticket_cooldowns (
            player_discord_id text not null references players(discord_id) on delete cascade,
            ticket_type text not null check (ticket_type in ('media', 'staff')),
            created_at timestamptz not null default now(),
            primary key (player_discord_id, ticket_type)
        )
    `;

    await sql`
        alter table ticket_cooldowns
        drop constraint if exists ticket_cooldowns_player_discord_id_fkey
    `;

    await sql`
        create table if not exists iceberg_members (
            discord_id text primary key references players(discord_id) on delete cascade,
            joined_at timestamptz not null default now()
        )
    `;

    await sql`
        create table if not exists iceberg_plots (
            plot_number int primary key check (plot_number > 0),
            owner_discord_id text references players(discord_id) on delete set null,
            original_price bigint not null check (original_price >= 0),
            bought_at timestamptz,
            current_claimer_discord_id text references players(discord_id) on delete set null,
            claim_expires_at timestamptz,
            updated_at timestamptz not null default now()
        )
    `;

    await sql`
        create table if not exists iceberg_fund (
            id int primary key default 1 check (id = 1),
            balance bigint not null default 0 check (balance >= 0),
            claims_enabled boolean not null default false,
            updated_at timestamptz not null default now()
        )
    `;

    await sql`
        alter table iceberg_fund
        add column if not exists claims_enabled boolean not null default false
    `;

    await sql`
        insert into iceberg_fund (id, balance, claims_enabled) values (1, 0, false)
        on conflict (id) do nothing
    `;

    await sql`
        create table if not exists iceberg_payment_requests (
            id bigserial primary key,
            guild_id text not null,
            player_discord_id text not null references players(discord_id) on delete cascade,
            player_minecraft_ign text not null,
            payment_bot_user text not null,
            amount bigint not null check (amount > 0),
            purpose text not null check (purpose in ('join', 'claim')),
            plot_number int references iceberg_plots(plot_number) on delete set null,
            status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'cancelled', 'expired')),
            paid_amount bigint,
            payment_message text,
            created_at timestamptz not null default now(),
            paid_at timestamptz,
            updated_at timestamptz not null default now()
        )
    `;

    await sql`
        create index if not exists idx_iceberg_payment_requests_pending
        on iceberg_payment_requests(guild_id, lower(player_minecraft_ign), amount, created_at)
        where status = 'pending'
    `;
}

async function ensureRankRoles(guild, options = {}) {
    const cache = getBootstrapGuildCache(guild);

    if (cache.rankRoles && cacheStillFresh(cache.rankRolesBuiltAt) && !options.forceRoleRefresh) {
        return {
            rankRoles: cache.rankRoles,
            rolesCreated: 0,
            rolesUpdated: 0
        };
    }

    const guildRoles = await getGuildRoles(guild, options);
    const rankRoles = new Map();
    let rolesCreated = 0;
    let rolesUpdated = 0;

    for (const rank of RANKS) {
        let role = findConfiguredRole(guildRoles, rank.name, RANK_ROLE_IDS.get(rank.name), 'Penguin rank');

        if (!role) {
            role = await guild.roles.create({
                name: rank.name,
                colors: {
                    primaryColor: rank.color
                },
                hoist: true,
                permissions: 0n,
                reason: 'Penguin Mafia rank setup'
            });

            rolesCreated++;
        } else if (role.name !== rank.name || !role.hoist || role.color !== rank.color) {
            role = await role.edit({
                name: rank.name,
                colors: {
                    primaryColor: rank.color
                },
                hoist: true,
                reason: 'Penguin Mafia rank setup'
            });

            rolesUpdated++;
        }

        rememberRole(guild, role, options);
        rankRoles.set(rank.name, role);
    }

    cache.rankRoles = rankRoles;
    cache.rankRolesBuiltAt = Date.now();

    return {
        rankRoles,
        rolesCreated,
        rolesUpdated
    };
}

async function ensureStaffRoles(guild, options = {}) {
    const cache = getBootstrapGuildCache(guild);

    if (cache.staffRoles && cacheStillFresh(cache.staffRolesBuiltAt) && !options.forceRoleRefresh) {
        return {
            staffRoles: cache.staffRoles,
            rolesCreated: 0,
            rolesUpdated: 0
        };
    }

    const guildRoles = await getGuildRoles(guild, options);
    const staffRoles = new Map();
    let rolesCreated = 0;
    let rolesUpdated = 0;

    for (const staffRank of STAFF_RANKS) {
        let role = findConfiguredRole(guildRoles, staffRank.name, STAFF_ROLE_IDS.get(staffRank.name), 'Staff rank');
        const requiredPermissions = staffRank.permissions || 0n;

        if (!role) {
            role = await guild.roles.create({
                name: staffRank.name,
                colors: {
                    primaryColor: staffRank.color
                },
                hoist: true,
                permissions: requiredPermissions,
                reason: 'Penguin Mafia staff rank setup'
            });

            rolesCreated++;
        } else if (
            role.name !== staffRank.name ||
            !role.hoist ||
            role.color !== staffRank.color ||
            (requiredPermissions !== 0n && !role.permissions.has(requiredPermissions))
        ) {
            role = await role.edit({
                name: staffRank.name,
                colors: {
                    primaryColor: staffRank.color
                },
                hoist: true,
                permissions: role.permissions.bitfield | requiredPermissions,
                reason: 'Penguin Mafia staff rank setup'
            });

            rolesUpdated++;
        }

        rememberRole(guild, role, options);
        staffRoles.set(staffRank.name, role);
    }

    cache.staffRoles = staffRoles;
    cache.staffRolesBuiltAt = Date.now();

    return {
        staffRoles,
        rolesCreated,
        rolesUpdated
    };
}

async function ensureTrainerRole(guild, options = {}) {
    const guildRoles = await getGuildRoles(guild, options);
    let role = findConfiguredRole(guildRoles, TRAINER_ROLE_NAME, TRAINER_ROLE_ID, 'Trainer');
    let roleCreated = false;
    let roleUpdated = false;

    if (!role) {
        role = await guild.roles.create({
            name: TRAINER_ROLE_NAME,
            colors: {
                primaryColor: 0x2ECC71
            },
            hoist: true,
            reason: 'Penguin Mafia trainer role setup'
        });
        roleCreated = true;
    } else if (
        role.name !== TRAINER_ROLE_NAME ||
        !role.hoist
    ) {
        role = await role.edit({
            name: TRAINER_ROLE_NAME,
            hoist: true,
            reason: 'Penguin Mafia trainer role setup'
        });
        roleUpdated = true;
    }

    rememberRole(guild, role, options);

    return {
        trainerRole: role,
        roleCreated,
        roleUpdated
    };
}

async function ensureInfoChannel(guild, name, content, rankRoles, options = {}) {
    const channels = await getGuildChannels(guild, options);
    let channel = options.channelId ? channels.get(options.channelId) : null;

    if (channel && channel.type !== ChannelType.GuildText) {
        console.log(`Configured channel ID for ${name} points to a non-text channel: ${options.channelId}`);
        channel = null;
    }

    if (!channel) {
        channel = channels.find(existingChannel => {
            return existingChannel?.type === ChannelType.GuildText && existingChannel.name === name;
        });
    }

    const rankRolePermissions = [...rankRoles.values()].map(role => ({
        id: role.id,
        type: OverwriteType.Role,
        allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory
        ],
        deny: [
            PermissionFlagsBits.SendMessages
        ]
    }));

    const permissionOverwrites = [
        {
            id: guild.roles.everyone.id,
            type: OverwriteType.Role,
            deny: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages
            ]
        },
        {
            id: guild.client.user.id,
            type: OverwriteType.Member,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ManageMessages
            ]
        },
        ...rankRolePermissions
    ];

    for (const donDiscordId of bootstrapDonDiscordIds()) {
        permissionOverwrites.push({
            id: donDiscordId,
            type: OverwriteType.Member,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ManageMessages
            ]
        });
    }

    if (!channel) {
        channel = await guild.channels.create({
            name,
            type: ChannelType.GuildText,
            permissionOverwrites,
            reason: 'Penguin Mafia information channel setup'
        });
        rememberChannel(options, channel);
    } else {
        await setPermissionOverwritesIfNeeded(
            channel,
            permissionOverwrites,
            'Penguin Mafia information channel permissions'
        );
    }

    const recentMessages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const matchingInfoMessages = [...(recentMessages?.filter(message => {
        return message.author.id === guild.client.user.id && message.content.includes(content.marker);
    }).values() || [])];
    const existingInfoMessage = matchingInfoMessages[0];

    let infoMessage = existingInfoMessage;
    const payload = infoMessagePayload(content);

    if (infoMessage) {
        await infoMessage.edit(payload);
    } else {
        infoMessage = await channel.send(payload);
    }

    if (options.pinInfoMessage && infoMessage && !infoMessage.pinned) {
        await infoMessage.pin('Pin Penguin Mafia information message').catch(error => {
            console.error(`Could not pin info message in ${name}:`);
            console.error(error);
        });
    }

    for (const duplicateMessage of matchingInfoMessages.filter(message => message.id !== existingInfoMessage?.id)) {
        await duplicateMessage.delete().catch(() => null);
    }

    return channel;
}

function infoMessagePayload(content) {
    if (content.body.length <= 2000) {
        return content.body;
    }

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setDescription(content.body.slice(0, 4096));

    return {
        content: `📌 **${content.marker}**`,
        embeds: [embed]
    };
}

function roleOverwrite(role, allow = [], deny = []) {
    return {
        id: role.id,
        type: OverwriteType.Role,
        allow,
        deny
    };
}

function allStaffRoles(staffRoles) {
    return [...STAFF_RANKS]
        .map(staffRank => staffRoles.get(staffRank.name))
        .filter(Boolean);
}

async function getGuildChannels(guild, options = {}) {
    if (options.channelCache) {
        return options.channelCache;
    }

    return guild.channels.fetch();
}

function rememberChannel(options, channel) {
    if (options.channelCache && channel) {
        options.channelCache.set(channel.id, channel);
    }
}

function permissionBits(permissions = []) {
    return permissions.reduce((bits, permission) => bits | BigInt(permission), 0n);
}

function permissionOverwritesMatch(channel, permissionOverwrites) {
    if (channel.permissionOverwrites.cache.size !== permissionOverwrites.length) {
        return false;
    }

    return permissionOverwrites.every(overwrite => {
        const currentOverwrite = channel.permissionOverwrites.cache.get(overwrite.id);

        if (!currentOverwrite || currentOverwrite.type !== overwrite.type) {
            return false;
        }

        return currentOverwrite.allow.bitfield === permissionBits(overwrite.allow) &&
            currentOverwrite.deny.bitfield === permissionBits(overwrite.deny);
    });
}

async function setPermissionOverwritesIfNeeded(channel, permissionOverwrites, reason) {
    if (permissionOverwritesMatch(channel, permissionOverwrites)) {
        return false;
    }

    await channel.permissionOverwrites.set(permissionOverwrites, reason);
    return true;
}

async function ensureManagedChannel(guild, name, type, permissionOverwrites, options = {}) {
    const channels = await getGuildChannels(guild, options);
    const channelNames = new Set([name, ...(options.aliases || [])].map(channelName => {
        return channelName.toLowerCase();
    }));
    let channel = options.channelId ? channels.get(options.channelId) : null;

    if (channel && channel.type !== type) {
        console.log(`Configured channel ID for ${name} points to the wrong channel type: ${options.channelId}`);
        channel = null;
    }

    if (!channel && !options.channelId) {
        channel = channels.find(existingChannel => {
            return existingChannel?.type === type &&
                channelNames.has(existingChannel.name.toLowerCase());
        });
    }

    const channelOptions = {
        name,
        type,
        permissionOverwrites,
        reason: options.reason || 'Penguin Mafia channel setup'
    };

    if (options.parent) {
        channelOptions.parent = options.parent.id;
    }

    if (!channel) {
        channel = await guild.channels.create(channelOptions);
        rememberChannel(options, channel);
    } else {
        await setPermissionOverwritesIfNeeded(
            channel,
            permissionOverwrites,
            'Penguin Mafia channel permissions'
        );

        if (options.parent && channel.parentId !== options.parent.id) {
            await channel.setParent(options.parent.id, {
                lockPermissions: false,
                reason: 'Penguin Mafia channel organization'
            });
        }
    }

    return channel;
}

async function ensureManagedInfoMessage(channel, content, options = {}) {
    const savedInfoMessageId = await savedManagedChannelId(db, options.infoMessageStateKey);
    const savedInfoMessage = savedInfoMessageId
        ? await channel.messages.fetch(savedInfoMessageId).catch(() => null)
        : null;
    const recentMessages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    const matchingInfoMessages = [...(recentMessages?.filter(message => {
        return message.author.id === channel.client.user.id && message.content.includes(content.marker);
    }).values() || [])];
    const savedInfoMessageMatches = savedInfoMessage &&
        savedInfoMessage.author.id === channel.client.user.id &&
        savedInfoMessage.content.includes(content.marker);
    const existingInfoMessage = savedInfoMessageMatches ? savedInfoMessage : matchingInfoMessages[0];

    let infoMessage = existingInfoMessage;
    const payload = infoMessagePayload(content);

    if (infoMessage) {
        await infoMessage.edit(payload);
    } else {
        infoMessage = await channel.send(payload);
    }

    await saveManagedChannelId(db, options.infoMessageStateKey, infoMessage.id);

    if (options.pinInfoMessage && infoMessage && !infoMessage.pinned) {
        await infoMessage.pin('Pin Penguin Mafia information message').catch(error => {
            console.error(`Could not pin info message in ${channel.name}:`);
            console.error(error);
        });
    }

    for (const duplicateMessage of matchingInfoMessages.filter(message => message.id !== existingInfoMessage?.id)) {
        await duplicateMessage.delete().catch(() => null);
    }

    return infoMessage;
}

function botOverwrite(guild) {
    return {
        id: guild.client.user.id,
        type: OverwriteType.Member,
        allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ManageMessages,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.Speak
        ]
    };
}

function donOverwrites(allow) {
    return bootstrapDonDiscordIds().map(donDiscordId => ({
        id: donDiscordId,
        type: OverwriteType.Member,
        allow
    }));
}

function publicReadOverwrites(guild, rankRoles, staffRoles, options = {}) {
    const sendStaffRoles = options.sendStaffRoles || [];
    const sendStaffRoleIds = new Set(sendStaffRoles.map(role => role.id));
    const overwrites = [
        {
            id: guild.roles.everyone.id,
            type: OverwriteType.Role,
            deny: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages
            ]
        },
        botOverwrite(guild),
        ...[...rankRoles.values()].map(role => roleOverwrite(role, [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory
        ], [
            PermissionFlagsBits.SendMessages
        ])),
        ...allStaffRoles(staffRoles).filter(role => !sendStaffRoleIds.has(role.id)).map(role => roleOverwrite(role, [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory
        ], [
            PermissionFlagsBits.SendMessages
        ])),
        ...sendStaffRoles.map(role => roleOverwrite(role, [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.SendMessages
        ]))
    ];

    overwrites.push(...donOverwrites([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageChannels
    ]));

    return overwrites;
}

function staffTextOverwrites(guild, allowedRoles) {
    const overwrites = [
        {
            id: guild.roles.everyone.id,
            type: OverwriteType.Role,
            deny: [
                PermissionFlagsBits.ViewChannel
            ]
        },
        botOverwrite(guild),
        ...allowedRoles.map(role => roleOverwrite(role, [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.SendMessages
        ]))
    ];

    overwrites.push(...donOverwrites([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageChannels
    ]));

    return overwrites;
}

function staffReadOnlyOverwrites(guild, allowedRoles) {
    const overwrites = staffTextOverwrites(guild, allowedRoles).map(overwrite => {
        if (overwrite.id === guild.client.user.id || bootstrapDonDiscordIds().includes(overwrite.id)) {
            return overwrite;
        }

        return {
            ...overwrite,
            deny: [
                ...(overwrite.deny || []),
                PermissionFlagsBits.SendMessages
            ]
        };
    });

    return overwrites;
}

async function savedManagedChannelId(db, key) {
    if (!db) return null;

    const rows = await db`
        select value
        from bot_state
        where key = ${key}
        limit 1
    `;

    return rows[0]?.value || null;
}

async function saveManagedChannelId(db, key, channelId) {
    if (!db || !channelId) return;

    await db`
        insert into bot_state (key, value)
        values (${key}, ${String(channelId)})
        on conflict (key) do update
        set value = excluded.value,
            updated_at = now()
    `;
}

async function ensureInfoChannels(guild, rankRoles, staffRoles = null, db = null) {
    const logChannelSetupStep = createBootstrapTimer(`channel-setup:${guild.name}`);
    logChannelSetupStep('starting managed channel setup');

    if (!staffRoles) {
        logChannelSetupStep('starting staff role lookup');
        ({ staffRoles } = await ensureStaffRoles(guild));
        logChannelSetupStep('staff role lookup ready');
    }

    logChannelSetupStep('starting channel cache fetch');
    const channelCache = await guild.channels.fetch();
    const sharedChannelOptions = {
        channelCache
    };
    logChannelSetupStep(`channel cache ready (${channelCache.size} channels)`);

    const managedWeeklyRecruitsLeaderboard = {
        marker: 'Penguin Mafia Weekly Recruit Leaderboard',
        body:
            `🏆🐧 **Penguin Mafia Weekly Recruit Leaderboard** 🐧🏆\n\n` +
            `The ice board is warming up. Weekly recruit scores will appear here soon.\n\n` +
            `This leaderboard tracks **direct recruits this week** and resets every **Friday at 12:00 PM Eastern Time** (**EDT** during daylight saving time).`
    };

    const managedDonationsLeaderboard = {
        marker: 'Penguin Mafia Top Donators',
        body:
            `💎🐧 **Penguin Mafia Top Donators** 🐧💎\n\n` +
            `The treasure vault is waiting. Top donation totals will appear here soon.\n\n` +
            `This leaderboard tracks all-time donations.\n\n` +
            `To get on this leaderboard, use \`/donate amount\` or fund a \`/giveaway\`. Direct Minecraft payments without one of those requests will not count.`
    };

    const managedTeamMonthlyRecruitsLeaderboard = {
        marker: 'Penguin Mafia Monthly Team Recruit Leaderboard',
        body:
            `🏆🐧 **Penguin Mafia Monthly Team Recruit Leaderboard** 🐧🏆\n\n` +
            `The monthly team standings will appear here soon.\n\n` +
            `This leaderboard tracks each team’s combined direct recruits for the current month and resets on the **1st of every month at 12:00 AM Eastern Time**.`
    };

    const managedRankInfo = {
        marker: 'Penguin Mafia Rank Information',
        body:
            `🐧📜 **Penguin Mafia Rank Information** 📜🐧\n\n` +
            `Welcome to the rank board, penguins. This is where waddlers become leaders. 🧊🎖️\n\n` +
            `Recruiting is one of the biggest ways to rank up. Build your tree, help your penguins grow, and climb together. More penguins, more power. 🐧🌲🐧\n\n` +
            `🧊 **Penguin Soldier** - Starting rank. Fresh on the ice. **40% commission**\n` +
            `🎩 **Penguin Captain** - Requires 3 direct recruits at Penguin Soldier or higher. **60% commission**\n` +
            `⭐ **Penguin General** - Requires 3 direct recruits at Penguin Captain or higher. **80% commission**\n` +
            `👑 **Emperor Penguin** - Requires 2 direct recruits at Penguin General or higher. **90% commission**\n\n` +
            `💰 **Commission Info**\n` +
            `Use \`/pay\` to simulate how rank commission would be split.\n` +
            `Your rank sets your total commission rate. Uplines only receive the positive override above the rate already paid below them.\n` +
            `If a payout reaches an Emperor Penguin, the chain stops there. Any remaining amount goes to that Emperor's direct recruiter when one exists; otherwise unallocated funds go to the Don.\n` +
            `The simulation does not change commissions or player balances. Players without a linked IGN are shown by Discord name.\n\n` +
            `Use \`/eligible\` to check rank eligibility and \`/recruit\` to review recruiting training. Make the Don proud. 👑🐧`
    };

    logChannelSetupStep('starting promotion events channel');
    const managedPromotionEventsChannel = await ensureManagedChannel(
        guild,
        PROMOTION_EVENTS_CHANNEL_NAME,
        ChannelType.GuildText,
        publicReadOverwrites(guild, rankRoles, staffRoles),
        {
            reason: 'Penguin Mafia promotion events channel setup',
            channelId: PROMOTION_EVENTS_CHANNEL_ID,
            channelCache
        }
    );
    logChannelSetupStep('promotion events channel ready');

    logChannelSetupStep('starting rank info channel');
    const managedRankInfoChannel = await ensureInfoChannel(guild, '📜-rank-info', managedRankInfo, rankRoles, {
        ...sharedChannelOptions,
        channelId: RANK_INFO_CHANNEL_ID
    });
    logChannelSetupStep('rank info channel ready');

    const weeklyLeaderboardStateKey = `managed_weekly_recruits_leaderboard_channel:${guild.id}`;
    const savedWeeklyLeaderboardChannelId = await savedManagedChannelId(db, weeklyLeaderboardStateKey);

    logChannelSetupStep('starting weekly recruits leaderboard channel');
    const managedWeeklyRecruitsChannel = await ensureInfoChannel(guild, WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_NAME, managedWeeklyRecruitsLeaderboard, rankRoles, {
        ...sharedChannelOptions,
        db,
        channelId: savedWeeklyLeaderboardChannelId || WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_ID,
        infoMessageStateKey: `managed_weekly_recruits_leaderboard_message:${guild.id}`
    });
    await saveManagedChannelId(db, weeklyLeaderboardStateKey, managedWeeklyRecruitsChannel.id);
    logChannelSetupStep('weekly recruits leaderboard channel ready');

    const teamMonthlyLeaderboardStateKey = `managed_team_monthly_recruits_leaderboard_channel:${guild.id}`;
    const savedTeamMonthlyLeaderboardChannelId = await savedManagedChannelId(db, teamMonthlyLeaderboardStateKey);

    logChannelSetupStep('starting monthly team recruits leaderboard channel');
    const managedTeamMonthlyRecruitsChannel = await ensureInfoChannel(
        guild,
        TEAM_MONTHLY_RECRUITS_LEADERBOARD_CHANNEL_NAME,
        managedTeamMonthlyRecruitsLeaderboard,
        rankRoles,
        {
            ...sharedChannelOptions,
            db,
            channelId: savedTeamMonthlyLeaderboardChannelId || TEAM_WEEKLY_LEADERBOARD_CHANNEL_ID,
            infoMessageStateKey: `managed_team_monthly_recruits_leaderboard_message:${guild.id}`
        }
    );
    await saveManagedChannelId(db, teamMonthlyLeaderboardStateKey, managedTeamMonthlyRecruitsChannel.id);
    logChannelSetupStep('monthly team recruits leaderboard channel ready');

    logChannelSetupStep('starting donations leaderboard channel');
    const managedDonationsLeaderboardChannel = await ensureInfoChannel(guild, DONATIONS_LEADERBOARD_CHANNEL_NAME, managedDonationsLeaderboard, rankRoles, {
        ...sharedChannelOptions,
        channelId: DONATIONS_LEADERBOARD_CHANNEL_ID
    });
    logChannelSetupStep('donations leaderboard channel ready');

    logChannelSetupStep('starting mod log channel');
    const managedModLogChannel = await ensureManagedChannel(
        guild,
        MOD_LOG_CHANNEL_NAME,
        ChannelType.GuildText,
        staffReadOnlyOverwrites(guild, allStaffRoles(staffRoles)),
        {
            reason: 'Penguin Mafia moderation log channel setup',
            channelId: MOD_LOG_CHANNEL_ID,
            channelCache
        }
    );
    logChannelSetupStep('mod log channel ready');

    return {
        donationsLeaderboardChannel: managedDonationsLeaderboardChannel,
        leaderboardCategory: null,
        modLogChannel: managedModLogChannel,
        promotionEventsChannel: managedPromotionEventsChannel,
        rankInfoChannel: managedRankInfoChannel,
        staffCategory: null,
        teamMonthlyRecruitsChannel: managedTeamMonthlyRecruitsChannel,
        weeklyRecruitsChannel: managedWeeklyRecruitsChannel
    };
}

async function syncMemberRankRole(member, rankRoles, rankName) {
    const targetRole = rankRoles.get(rankName) || rankRoles.get(DEFAULT_RANK_NAME);
    const rolesToRemove = [...rankRoles.values()].filter(role => {
        return role.id !== targetRole?.id && member.roles.cache.has(role.id);
    });

    if (rolesToRemove.length > 0) {
        await member.roles.remove(rolesToRemove, 'Sync Penguin Mafia rank role');
    }

    if (targetRole && !member.roles.cache.has(targetRole.id)) {
        await member.roles.add(targetRole, 'Sync Penguin Mafia rank role');
        return true;
    }

    return false;
}

async function removeMemberRankRoles(member, rankRoles) {
    const rolesToRemove = [...rankRoles.values()].filter(role => {
        return member.roles.cache.has(role.id);
    });

    if (rolesToRemove.length > 0) {
        await member.roles.remove(rolesToRemove, 'Penguin Mafia onboarding not completed');
        return rolesToRemove.length;
    }

    return 0;
}

function getMemberStaffRankName(member, staffRoles) {
    for (const staffRank of [...STAFF_RANKS].reverse()) {
        const role = staffRoles.get(staffRank.name);

        if (role && member.roles.cache.has(role.id)) {
            return staffRank.name;
        }
    }

    return null;
}

async function syncMemberStaffRankFromRoles(sql, member, staffRoles) {
    const staffRankName = getMemberStaffRankName(member, staffRoles);

    await sql`
        update players
        set
            staff_rank_name = ${staffRankName},
            ban_points_remaining = case
                when ${staffRankName}::text is null then 0
                else least(
                    ban_points_remaining,
                    coalesce((
                        select ban_point_limit
                        from staff_ranks
                        where name = ${staffRankName}
                    ), 0)
                )
            end,
            updated_at = now()
        where discord_id = ${member.user.id}
            and (
                staff_rank_name is distinct from ${staffRankName}
                or (
                    ${staffRankName}::text is null
                    and ban_points_remaining <> 0
                )
                or ban_points_remaining > coalesce((
                    select ban_point_limit
                    from staff_ranks
                    where name = ${staffRankName}
                ), 0)
            )
    `;

    return staffRankName;
}

module.exports = {
    CAPTAIN_SPEED_LEADERBOARD_CHANNEL_ID,
    DEFAULT_RANK_NAME,
    DONATIONS_LEADERBOARD_CHANNEL_ID,
    DONATIONS_LEADERBOARD_CHANNEL_NAME,
    HOURLY_RECRUITS_LEADERBOARD_CHANNEL_ID,
    ICEBERG_CHANNEL_ID,
    ICEBERG_ENTRY_FEE_CENTS,
    ICEBERG_MEMBERS_CHANNEL_ID,
    ICEBERG_MIN_PLOT_PRICE_CENTS,
    ICEBERG_ROLE_ID,
    MOD_LOG_CHANNEL_ID,
    MOD_LOG_CHANNEL_NAME,
    PROMOTION_EVENTS_CHANNEL_ID,
    PROMOTION_EVENTS_CHANNEL_NAME,
    RANK_ROLE_IDS,
    RANKS,
    STAFF_ROLE_IDS,
    STAFF_RANKS,
    TEAM_CHANNEL_CATEGORY_ID,
    TEAM_WEEKLY_LEADERBOARD_CHANNEL_ID,
    TEAM_MONTHLY_RECRUITS_LEADERBOARD_CHANNEL_NAME,
    TRAINER_ROLE_ID,
    TRAINER_ROLE_NAME,
    VC_LEVEL_LEADERBOARD_CHANNEL_ID,
    WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_ID,
    WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_NAME,
    ensureDatabaseSchema,
    ensureInfoChannels,
    ensureRankRoles,
    ensureStaffRoles,
    ensureTrainerRole,
    getMemberStaffRankName,
    invalidateGuildRoleCache,
    removeMemberRankRoles,
    syncMemberRankRole,
    syncMemberStaffRankFromRoles
};
