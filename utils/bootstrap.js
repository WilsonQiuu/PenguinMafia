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
        color: 0x95A5A6,
        banPoints: 0
    },
    {
        name: 'Moderator',
        color: 0x3498DB,
        banPoints: 1
    },
    {
        name: 'Sr Moderator',
        color: 0x2ECC71,
        banPoints: 3,
        permissions: PermissionFlagsBits.ManageChannels
    },
    {
        name: 'Admin',
        color: 0xE74C3C,
        banPoints: 5,
        permissions: PermissionFlagsBits.ManageChannels
    }
];

const DEFAULT_RANK_NAME = 'Penguin Soldier';
const PROMOTION_EVENTS_CHANNEL_NAME = '🎉-promotion-events';
const WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_NAME = '🏆-weekly-recruits';
const DONATIONS_LEADERBOARD_CHANNEL_NAME = '💎-top-donators';
const WELCOME_CATEGORY_NAME = '🐧-penguin-processing';
const LEADERBOARD_CATEGORY_NAME = '🏆-leaderboards';
const STAFF_CATEGORY_NAME = '🛡️-staff';
const MOD_LOG_CHANNEL_NAME = 'mod-log';
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
            parent_discord_id text references players(discord_id) on delete set null,
            claims_available int not null default 0,
            donations bigint not null default 0 check (donations >= 0),
            unpaid_commissions bigint not null default 0 check (unpaid_commissions >= 0),
            rank_name text not null default 'Penguin Soldier' references ranks(name),
            staff_rank_name text references staff_ranks(name),
            ban_points_remaining int not null default 0 check (ban_points_remaining >= 0),
            status text not null default 'active',
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
        let role = guildRoles.find(existingRole => existingRole.name === rank.name);

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
        let role = guildRoles.find(existingRole => existingRole.name === staffRank.name);
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

async function ensureInfoChannel(guild, name, content, rankRoles, options = {}) {
    const channels = await getGuildChannels(guild, options);
    let channel = channels.find(existingChannel => {
        return existingChannel?.type === ChannelType.GuildText && existingChannel.name === name;
    });

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

async function ensureCategory(guild, name, permissionOverwrites = [], options = {}) {
    const channels = await getGuildChannels(guild, options);
    let category = channels.find(existingChannel => {
        return existingChannel?.type === ChannelType.GuildCategory &&
            existingChannel.name === name;
    });

    if (!category) {
        category = await guild.channels.create({
            name,
            type: ChannelType.GuildCategory,
            permissionOverwrites,
            reason: 'Penguin Mafia channel organization setup'
        });
        rememberChannel(options, category);
    } else {
        await setPermissionOverwritesIfNeeded(
            category,
            permissionOverwrites,
            'Penguin Mafia category permissions'
        );
    }

    return category;
}

async function ensureManagedChannel(guild, name, type, permissionOverwrites, options = {}) {
    const channels = await getGuildChannels(guild, options);
    const channelNames = new Set([name, ...(options.aliases || [])].map(channelName => {
        return channelName.toLowerCase();
    }));
    let channel = channels.find(existingChannel => {
        return existingChannel?.type === type &&
            channelNames.has(existingChannel.name.toLowerCase());
    });

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

async function maybeMoveChannel(channel, parent) {
    if (channel.parentId !== parent.id) {
        await channel.setParent(parent.id, {
            lockPermissions: false,
            reason: 'Penguin Mafia channel organization'
        });
    }

    return channel;
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
            `This leaderboard tracks **direct recruits this week**. The Don resets it with \`/reset resetweeklyrecruits\`.`
    };

    const managedDonationsLeaderboard = {
        marker: 'Penguin Mafia Top Donators',
        body:
            `💎🐧 **Penguin Mafia Top Donators** 🐧💎\n\n` +
            `The treasure vault is waiting. Top donation totals will appear here soon.\n\n` +
            `This leaderboard tracks all-time donations.`
    };

    const managedPromotionEvents = {
        marker: 'Penguin Mafia Promotion Events',
        body:
            `🎉🐧 **Penguin Mafia Promotion Events** 🐧🎉\n\n` +
            `Promotions and donation announcements will appear here when penguins make moves.`
    };

    logChannelSetupStep('starting leaderboard category');
    const managedLeaderboardCategory = await ensureCategory(guild, LEADERBOARD_CATEGORY_NAME, publicReadOverwrites(guild, rankRoles, staffRoles), sharedChannelOptions);
    logChannelSetupStep('leaderboard category ready');

    const managedStaffCategoryOverwrites = [
        {
            id: guild.roles.everyone.id,
            type: OverwriteType.Role,
            deny: [
                PermissionFlagsBits.ViewChannel
            ]
        },
        botOverwrite(guild),
        ...allStaffRoles(staffRoles).map(role => roleOverwrite(role, [
            PermissionFlagsBits.ViewChannel
        ]))
    ];
    const managedStaffCategoryDon = donOverwrite([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ManageChannels
    ]);

    if (managedStaffCategoryDon) {
        managedStaffCategoryOverwrites.push(managedStaffCategoryDon);
    }

    logChannelSetupStep('starting staff category');
    const managedStaffCategory = await ensureCategory(guild, STAFF_CATEGORY_NAME, managedStaffCategoryOverwrites, sharedChannelOptions);
    logChannelSetupStep('staff category ready');

    logChannelSetupStep('starting promotion events channel');
    const managedPromotionEventsChannel = await ensureInfoChannel(guild, PROMOTION_EVENTS_CHANNEL_NAME, managedPromotionEvents, rankRoles, {
        pinInfoMessage: true,
        channelCache
    });
    logChannelSetupStep('promotion events channel ready');

    logChannelSetupStep('starting weekly recruits leaderboard channel');
    const managedWeeklyRecruitsChannel = await ensureInfoChannel(guild, WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_NAME, managedWeeklyRecruitsLeaderboard, rankRoles, sharedChannelOptions);
    logChannelSetupStep('weekly recruits leaderboard channel ready');

    logChannelSetupStep('starting donations leaderboard channel');
    const managedDonationsLeaderboardChannel = await ensureInfoChannel(guild, DONATIONS_LEADERBOARD_CHANNEL_NAME, managedDonationsLeaderboard, rankRoles, sharedChannelOptions);
    logChannelSetupStep('donations leaderboard channel ready');

    logChannelSetupStep('starting mod log channel');
    const managedModLogChannel = await ensureManagedChannel(
        guild,
        MOD_LOG_CHANNEL_NAME,
        ChannelType.GuildText,
        staffReadOnlyOverwrites(guild, allStaffRoles(staffRoles)),
        {
            parent: managedStaffCategory,
            reason: 'Penguin Mafia moderation log channel setup',
            channelCache
        }
    );
    logChannelSetupStep('mod log channel ready');

    await maybeMoveChannel(managedPromotionEventsChannel, managedLeaderboardCategory);
    await maybeMoveChannel(managedWeeklyRecruitsChannel, managedLeaderboardCategory);
    await maybeMoveChannel(managedDonationsLeaderboardChannel, managedLeaderboardCategory);

    return {
        donationsLeaderboardChannel: managedDonationsLeaderboardChannel,
        leaderboardCategory: managedLeaderboardCategory,
        modLogChannel: managedModLogChannel,
        promotionEventsChannel: managedPromotionEventsChannel,
        staffCategory: managedStaffCategory,
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
    DONATIONS_LEADERBOARD_CHANNEL_NAME,
    MOD_LOG_CHANNEL_NAME,
    PROMOTION_EVENTS_CHANNEL_NAME,
    RANKS,
    STAFF_RANKS,
    WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_NAME,
    WELCOME_CATEGORY_NAME,
    ensureDatabaseSchema,
    ensureInfoChannels,
    ensureWelcomeCategory,
    ensureRankRoles,
    ensureStaffRoles,
    getMemberStaffRankName,
    invalidateGuildRoleCache,
    removeMemberRankRoles,
    syncMemberRankRole,
    syncMemberStaffRankFromRoles
};
