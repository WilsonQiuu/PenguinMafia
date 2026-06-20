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
const DONATIONS_LEADERBOARD_CHANNEL_ID = process.env.DONATIONS_LEADERBOARD_CHANNEL_ID || '1512488380280082493';
const WELCOME_CATEGORY_NAME = '🐧-penguin-processing';
const MOD_LOG_CHANNEL_NAME = 'mod-log';
const MOD_LOG_CHANNEL_ID = process.env.MOD_LOG_CHANNEL_ID || '1512488393232355522';
const ROLE_CACHE_TTL_MS = 5 * 60 * 1000;

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
            parent_discord_id text references players(discord_id) on delete set null,
            claims_available int not null default 0,
            donations bigint not null default 0 check (donations >= 0),
            unpaid_commissions bigint not null default 0 check (unpaid_commissions >= 0),
            rank_name text not null default 'Penguin Soldier' references ranks(name),
            staff_rank_name text references staff_ranks(name),
            ban_points_remaining int not null default 0 check (ban_points_remaining >= 0),
            status text not null default 'active',
            welcome_reminder_sent_at timestamptz,
            account_link_reminder_sent_at timestamptz,
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
        add column if not exists welcome_reminder_sent_at timestamptz
    `;

    await sql`
        alter table players
        add column if not exists account_link_reminder_sent_at timestamptz
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
        create index if not exists idx_giveaways_active_end
        on giveaways(guild_id, status, ends_at)
    `;

    await sql`
        create index if not exists idx_giveaways_cleanup_due
        on giveaways(guild_id, cleanup_due_at)
        where cleaned_at is null
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
                if new.parent_discord_id is not null then
                    update players
                    set
                        direct_recruits_count = direct_recruits_count + 1,
                        weekly_direct_recruits_count = weekly_direct_recruits_count + 1,
                        updated_at = now()
                    where discord_id = new.parent_discord_id;
                end if;

                return new;
            end if;

            if tg_op = 'UPDATE' then
                if old.parent_discord_id is distinct from new.parent_discord_id then
                    if old.parent_discord_id is not null then
                        update players
                        set
                            direct_recruits_count = greatest(direct_recruits_count - 1, 0),
                            updated_at = now()
                        where discord_id = old.parent_discord_id;
                    end if;

                    if new.parent_discord_id is not null then
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
                end if;

                return new;
            end if;

            if tg_op = 'DELETE' then
                if old.parent_discord_id is not null then
                    update players
                    set
                        direct_recruits_count = greatest(direct_recruits_count - 1, 0),
                        weekly_direct_recruits_count = greatest(weekly_direct_recruits_count - 1, 0),
                        updated_at = now()
                    where discord_id = old.parent_discord_id;
                end if;

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
            if new.parent_discord_id is not null then
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

    if (!channel && !options.channelId) {
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

    if (process.env.DON_DISCORD_ID) {
        permissionOverwrites.push({
            id: process.env.DON_DISCORD_ID,
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
    const recentMessages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const matchingInfoMessages = [...(recentMessages?.filter(message => {
        return message.author.id === channel.client.user.id && message.content.includes(content.marker);
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

function donOverwrite(allow) {
    if (!process.env.DON_DISCORD_ID) {
        return null;
    }

    return {
        id: process.env.DON_DISCORD_ID,
        type: OverwriteType.Member,
        allow
    };
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

    const don = donOverwrite([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageChannels
    ]);

    if (don) {
        overwrites.push(don);
    }

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

    const don = donOverwrite([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageChannels
    ]);

    if (don) {
        overwrites.push(don);
    }

    return overwrites;
}

function staffReadOnlyOverwrites(guild, allowedRoles) {
    const overwrites = staffTextOverwrites(guild, allowedRoles).map(overwrite => {
        if (overwrite.id === guild.client.user.id || overwrite.id === process.env.DON_DISCORD_ID) {
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

function welcomeCategoryIndex(name) {
    if (name === WELCOME_CATEGORY_NAME) {
        return 1;
    }

    const escapedName = WELCOME_CATEGORY_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = name.match(new RegExp(`^${escapedName}-(\\d+)$`));

    return match ? Number(match[1]) : null;
}

function categoryChildCount(channels, category) {
    return channels.filter(channel => {
        return channel?.parentId === category.id;
    }).size;
}

async function ensureWelcomeCategory(guild, options = {}) {
    const channels = await getGuildChannels(guild, options);
    const processingCategories = channels.filter(existingChannel => {
        return existingChannel?.type === ChannelType.GuildCategory &&
            welcomeCategoryIndex(existingChannel.name) !== null;
    }).sort((first, second) => {
        return welcomeCategoryIndex(first.name) - welcomeCategoryIndex(second.name);
    });

    let category = options.requireAvailableSlot
        ? processingCategories.find(existingCategory => categoryChildCount(channels, existingCategory) < 50)
        : processingCategories.find(existingCategory => existingCategory.name === WELCOME_CATEGORY_NAME);

    if (!category) {
        const existingIndexes = processingCategories.map(existingCategory => {
            return welcomeCategoryIndex(existingCategory.name) || 1;
        });
        const nextIndex = existingIndexes.length > 0
            ? Math.max(...existingIndexes) + 1
            : 1;
        category = await guild.channels.create({
            name: nextIndex === 1 ? WELCOME_CATEGORY_NAME : `${WELCOME_CATEGORY_NAME}-${nextIndex}`,
            type: ChannelType.GuildCategory,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone.id,
                    type: OverwriteType.Role,
                    deny: [
                        PermissionFlagsBits.ViewChannel
                    ]
                }
            ],
            reason: 'Penguin Mafia private welcome category setup'
        });
        rememberChannel(options, category);
    }

    return category;
}

async function ensureInfoChannels(guild, rankRoles, staffRoles = null) {
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
            `This leaderboard tracks all-time donations.`
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

    logChannelSetupStep('starting weekly recruits leaderboard channel');
    const managedWeeklyRecruitsChannel = await ensureInfoChannel(guild, WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_NAME, managedWeeklyRecruitsLeaderboard, rankRoles, {
        ...sharedChannelOptions,
        channelId: WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_ID
    });
    logChannelSetupStep('weekly recruits leaderboard channel ready');

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
    DEFAULT_RANK_NAME,
    DONATIONS_LEADERBOARD_CHANNEL_ID,
    DONATIONS_LEADERBOARD_CHANNEL_NAME,
    HOURLY_RECRUITS_LEADERBOARD_CHANNEL_ID,
    MOD_LOG_CHANNEL_ID,
    MOD_LOG_CHANNEL_NAME,
    PROMOTION_EVENTS_CHANNEL_ID,
    PROMOTION_EVENTS_CHANNEL_NAME,
    RANK_ROLE_IDS,
    RANKS,
    STAFF_ROLE_IDS,
    STAFF_RANKS,
    TRAINER_ROLE_ID,
    TRAINER_ROLE_NAME,
    WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_ID,
    WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_NAME,
    WELCOME_CATEGORY_NAME,
    ensureDatabaseSchema,
    ensureInfoChannels,
    ensureWelcomeCategory,
    ensureRankRoles,
    ensureStaffRoles,
    ensureTrainerRole,
    getMemberStaffRankName,
    invalidateGuildRoleCache,
    removeMemberRankRoles,
    syncMemberRankRole,
    syncMemberStaffRankFromRoles
};
