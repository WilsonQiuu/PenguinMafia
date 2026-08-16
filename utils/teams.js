const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

const sql = require('../db.js');
const {
    updateTeamWeeklyRecruitsLeaderboardForGuild
} = require('./leaderboards.js');
const {
    isDon
} = require('./staff.js');
const {
    dismissRow
} = require('./dismissible.js');

const TEAM_CREATE_APPROVE_PREFIX = 'team_create_approve:';
const TEAM_CREATE_REJECT_PREFIX = 'team_create_reject:';
const TEAM_COLOR_NAMES = new Map([
    ['black', 0x000000],
    ['white', 0xFFFFFF],
    ['gray', 0x95A5A6],
    ['grey', 0x95A5A6],
    ['red', 0xE74C3C],
    ['orange', 0xE67E22],
    ['yellow', 0xF1C40F],
    ['green', 0x2ECC71],
    ['lime', 0x00FF00],
    ['blue', 0x3498DB],
    ['cyan', 0x1ABC9C],
    ['teal', 0x11806A],
    ['aqua', 0x00FFFF],
    ['purple', 0x9B59B6],
    ['pink', 0xE91E63],
    ['magenta', 0xFF00FF],
    ['gold', 0xFFD700],
    ['brown', 0x8B4513],
    ['navy', 0x34495E],
    ['blurple', 0x5865F2]
]);

function normalizeTeamName(name) {
    return String(name || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function validateTeamName(name) {
    const trimmed = String(name || '').trim().replace(/\s+/g, ' ');

    if (trimmed.length < 2) {
        throw new Error('Team name must be at least 2 characters long.');
    }

    if (trimmed.length > 50) {
        throw new Error('Team name must be 50 characters or less.');
    }

    if (!/^[\p{L}\p{N}][\p{L}\p{N}\s'’._-]*$/u.test(trimmed)) {
        throw new Error('Team name can only use letters, numbers, spaces, apostrophes, periods, underscores, and dashes.');
    }

    return trimmed;
}

function parseTeamColor(color) {
    const raw = String(color || '').trim();
    const normalized = raw.toLowerCase().replace(/\s+/g, '');
    const namedColor = TEAM_COLOR_NAMES.get(normalized);

    if (namedColor !== undefined) {
        return namedColor;
    }

    const match = raw.match(/^#?([0-9a-fA-F]{6})$/) || raw.match(/^0x([0-9a-fA-F]{6})$/);

    if (!match) {
        throw new Error(
            'Team color must be a color name like `yellow`, `red`, or `purple`, or a hex color like `#7A5CFF`.'
        );
    }

    return Number.parseInt(match[1], 16);
}

function formatTeamColor(color) {
    return `#${Number(color || 0).toString(16).padStart(6, '0').toUpperCase()}`;
}

function defaultTeamNameForPlayer(player) {
    const slug = String(
        player?.minecraft_ign ||
        player?.discord_display_name ||
        player?.discord_username ||
        player?.discord_id ||
        'player'
    )
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 44);

    return `team-${slug || 'player'}`;
}

function approvalRow(requestId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${TEAM_CREATE_APPROVE_PREFIX}${requestId}`)
            .setLabel('Approve Team')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`${TEAM_CREATE_REJECT_PREFIX}${requestId}`)
            .setLabel('Reject')
            .setStyle(ButtonStyle.Danger)
    );
}

async function fetchPlayerTeam(db, playerDiscordId) {
    const rows = await db`
        select
            team.id::text as id,
            team.name,
            team.color,
            team.role_id,
            team.channel_id,
            team.owner_discord_id
        from players player
        join teams team
            on team.id = player.team_id
            and team.status = 'active'
        where player.discord_id = ${playerDiscordId}
        limit 1
    `;

    return rows[0] || null;
}

async function fetchEffectiveTeamBucket(db, playerDiscordId, guildId = null) {
    const rows = await db`
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
            where player.discord_id = ${playerDiscordId}

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
        recruiter as (
            select *
            from ancestors
            where depth = 0
            limit 1
        ),
        nearest_emperor as (
            select *
            from ancestors
            where rank_name = 'Emperor Penguin'
            order by depth asc
            limit 1
        )
        select
            recruiter.discord_id,
            assigned_team.id::text as assigned_team_id,
            assigned_team.name as assigned_team_name,
            assigned_team.role_id as assigned_team_role_id,
            assigned_team.channel_id as assigned_team_channel_id,
            assigned_team.owner_discord_id as assigned_team_owner_discord_id,
            emperor.discord_id as emperor_discord_id,
            emperor.discord_username as emperor_discord_username,
            emperor.discord_display_name as emperor_discord_display_name,
            emperor.minecraft_ign as emperor_minecraft_ign,
            owned_team.id::text as owned_team_id,
            owned_team.name as owned_team_name,
            owned_team.role_id as owned_team_role_id,
            owned_team.channel_id as owned_team_channel_id,
            owned_team.owner_discord_id as owned_team_owner_discord_id
        from recruiter
        left join nearest_emperor emperor
            on true
        left join teams owned_team
            on owned_team.owner_discord_id = emperor.discord_id
            and owned_team.status = 'active'
            and (${guildId}::text is null or owned_team.guild_id = ${guildId})
        left join teams assigned_team
            on assigned_team.id = recruiter.team_id
            and assigned_team.status = 'active'
            and emperor.discord_id is null
            and (${guildId}::text is null or assigned_team.guild_id = ${guildId})
        limit 1
    `;
    const row = rows[0];

    if (!row) {
        return null;
    }

    if (row.owned_team_id) {
        return {
            id: row.owned_team_id,
            key: `team:${row.owned_team_id}`,
            name: row.owned_team_name,
            role_id: row.owned_team_role_id,
            channel_id: row.owned_team_channel_id,
            owner_discord_id: row.owned_team_owner_discord_id,
            is_virtual: false
        };
    }

    if (row.emperor_discord_id) {
        return {
            id: null,
            key: `emperor:${row.emperor_discord_id}`,
            name: defaultTeamNameForPlayer({
                discord_id: row.emperor_discord_id,
                discord_username: row.emperor_discord_username,
                discord_display_name: row.emperor_discord_display_name,
                minecraft_ign: row.emperor_minecraft_ign
            }),
            role_id: null,
            channel_id: null,
            owner_discord_id: row.emperor_discord_id,
            is_virtual: true
        };
    }

    if (row.assigned_team_id) {
        return {
            id: row.assigned_team_id,
            key: `team:${row.assigned_team_id}`,
            name: row.assigned_team_name,
            role_id: row.assigned_team_role_id,
            channel_id: row.assigned_team_channel_id,
            owner_discord_id: row.assigned_team_owner_discord_id,
            is_virtual: false
        };
    }

    return null;
}

async function teamLineForRecruiter(db, recruiterId, guildId = null) {
    const team = await fetchEffectiveTeamBucket(db, recruiterId, guildId);

    return team ? `Team: **${team.name}**\n` : '';
}

const teamPingCooldowns = new Map();

function canTeamPing(teamId) {
    const lastPing = teamPingCooldowns.get(teamId);
    if (lastPing && Date.now() - lastPing < 60_000) {
        return Math.ceil((60_000 - (Date.now() - lastPing)) / 1000);
    }
    return 0;
}

function consumeTeamPing(teamId) {
    teamPingCooldowns.set(teamId, Date.now());
}

async function requestTeamCreation(interaction, options, db = sql) {
    const donDiscordId = process.env.DON_DISCORD_ID;

    if (!donDiscordId) {
        throw new Error('DON_DISCORD_ID is missing from your `.env` file.');
    }

    const teamName = validateTeamName(options.name);
    const normalizedName = normalizeTeamName(teamName);
    const color = parseTeamColor(options.color);

    const existingRows = await db`
        select
            id,
            name,
            owner_discord_id
        from teams
        where guild_id = ${interaction.guild.id}
            and normalized_name = ${normalizedName}
            and status = 'active'
        limit 1
    `;

    if (existingRows[0]) {
        throw new Error(`A team named "${existingRows[0].name}" already exists.`);
    }

    const pendingRows = await db`
        select id, name
        from team_create_requests
        where guild_id = ${interaction.guild.id}
            and owner_discord_id = ${interaction.user.id}
            and status = 'pending'
        order by requested_at desc
        limit 1
    `;

    if (pendingRows[0]) {
        throw new Error(`You already have a pending team request: "${pendingRows[0].name}". Wait for the Don to approve or reject it first.`);
    }

    const requestRows = await db`
        insert into team_create_requests (
            guild_id,
            owner_discord_id,
            requested_by_discord_id,
            name,
            normalized_name,
            color
        )
        values (
            ${interaction.guild.id},
            ${interaction.user.id},
            ${interaction.user.id},
            ${teamName},
            ${normalizedName},
            ${color}
        )
        returning
            id,
            guild_id,
            owner_discord_id,
            name,
            color
    `;
    const request = requestRows[0];
    let donUser = null;

    try {
        donUser = await interaction.client.users.fetch(donDiscordId);
    } catch (error) {
        await markTeamRequestFailed(db, request.id, donDiscordId, `Could not fetch Don user: ${error.message}`);
        throw new Error(`Could not find the Don for approval DM: ${error.message}`);
    }

    const ownerRows = await db`
        select
            discord_username,
            discord_display_name,
            minecraft_ign,
            rank_name
        from players
        where discord_id = ${interaction.user.id}
        limit 1
    `;
    const owner = ownerRows[0] || {};
    const existingOwnerTeam = await fetchOwnedTeam(db, interaction.guild.id, interaction.user.id);
    const replacementLine = existingOwnerTeam
        ? `\n\nThis will replace their current team: **${existingOwnerTeam.name}**.`
        : '';

    try {
        await donUser.send({
            content:
                `🐧 **Team Creation Request**\n\n` +
                `Player: <@${interaction.user.id}> (${interaction.user.id})\n` +
                `Name: **${request.name}**\n` +
                `Color: **${formatTeamColor(request.color)}**\n` +
                `Rank: **${owner.rank_name || 'Unknown'}**${replacementLine}\n\n` +
                `Approve this to create the Discord team role, keep the team ping, and move their eligible tree into the team.`,
            components: [approvalRow(request.id), dismissRow(donDiscordId)]
        });
    } catch (error) {
        await markTeamRequestFailed(db, request.id, donDiscordId, `Could not DM Don: ${error.message}`);
        throw new Error(`Could not DM the Don for approval: ${error.message}`);
    }

    return request;
}

async function fetchOwnedTeam(db, guildId, ownerDiscordId) {
    const rows = await db`
        select
            id::text as id,
            name,
            normalized_name,
            color,
            role_id,
            channel_id
        from teams
        where guild_id = ${guildId}
            and owner_discord_id = ${ownerDiscordId}
            and status = 'active'
        limit 1
    `;

    return rows[0] || null;
}

async function deleteDiscordTeamResources(guild, teams, reason) {
    const result = {
        deletedChannels: 0,
        deletedRoles: 0,
        failures: []
    };

    for (const team of teams || []) {
        if (team.channel_id) {
            try {
                const channel = guild.channels.cache.get(team.channel_id) ||
                    (await guild.channels.fetch(team.channel_id).catch(() => null));

                if (channel) {
                    await channel.delete(reason);
                    result.deletedChannels++;
                }
            } catch (error) {
                result.failures.push(`Channel ${team.channel_id}: ${error.message}`);
            }
        }

        if (team.role_id) {
            try {
                const role = guild.roles.cache.get(team.role_id) ||
                    (await guild.roles.fetch(team.role_id).catch(() => null));

                if (role) {
                    await role.delete(reason);
                    result.deletedRoles++;
                }
            } catch (error) {
                result.failures.push(`Role ${team.role_id}: ${error.message}`);
            }
        }
    }

    return result;
}

async function deleteArchivedTeamResources(guild, teams, reason = 'Penguin Mafia archived team cleanup') {
    const cleanup = await deleteDiscordTeamResources(guild, teams, reason);

    if (cleanup.failures.length > 0) {
        console.warn(`Team Discord resource cleanup had ${cleanup.failures.length} failure(s) in ${guild.name}: ${cleanup.failures.join('; ')}`);
    }

    return cleanup;
}

async function cleanupLegacyTeamChannelsForGuild(guild, db = sql, reason = 'Penguin Mafia team chats removed') {
    const rows = await db`
        select id::text as id, name, channel_id
        from teams
        where guild_id = ${guild.id}
            and status = 'active'
            and channel_id is not null
    `;
    const result = {
        deletedChannels: 0,
        clearedChannelIds: 0,
        failures: []
    };

    for (const team of rows) {
        try {
            const channel = guild.channels.cache.get(team.channel_id) ||
                (await guild.channels.fetch(team.channel_id).catch(() => null));

            if (channel) {
                await channel.delete(reason);
                result.deletedChannels++;
            }

            const clearedRows = await db`
                update teams
                set
                    channel_id = null,
                    updated_at = now()
                where id = ${team.id}::bigint
                    and channel_id = ${team.channel_id}
                returning id
            `;

            if (clearedRows.length > 0) {
                result.clearedChannelIds++;
            }
        } catch (error) {
            result.failures.push(`Team ${team.name} (${team.channel_id}): ${error.message}`);
        }
    }

    return result;
}

async function renameTeam(guild, ownerDiscordId, name, color, db = sql) {
    const teamName = validateTeamName(name);
    const normalizedName = normalizeTeamName(teamName);
    const teamColor = parseTeamColor(color);
    const team = await fetchOwnedTeam(db, guild.id, ownerDiscordId);

    if (!team) {
        throw new Error('You do not own an active team yet.');
    }

    const conflictRows = await db`
        select id, name
        from teams
        where guild_id = ${guild.id}
            and normalized_name = ${normalizedName}
            and status = 'active'
            and id <> ${team.id}::bigint
        limit 1
    `;

    if (conflictRows[0]) {
        throw new Error(`A team named "${conflictRows[0].name}" already exists.`);
    }

    const updatedRows = await db`
        update teams
        set
            name = ${teamName},
            normalized_name = ${normalizedName},
            color = ${teamColor},
            updated_at = now()
        where id = ${team.id}::bigint
            and guild_id = ${guild.id}
            and owner_discord_id = ${ownerDiscordId}
            and status = 'active'
        returning
            id::text as id,
            name,
            color,
            role_id,
            channel_id
    `;
    const updatedTeam = updatedRows[0];

    if (!updatedTeam) {
        throw new Error('Team was not found or is no longer active.');
    }

    const syncFailures = [];

    if (updatedTeam.role_id) {
        const role = guild.roles.cache.get(updatedTeam.role_id) ||
            (await guild.roles.fetch(updatedTeam.role_id).catch(() => null));

        if (role) {
            await role.edit({
                name: updatedTeam.name,
                color: Number(updatedTeam.color),
                mentionable: true,
                reason: `Penguin Mafia team renamed by ${ownerDiscordId}`
            }).catch(error => {
                syncFailures.push(`Role: ${error.message}`);
            });
        } else {
            syncFailures.push(`Role ${updatedTeam.role_id} was not found`);
        }
    }

    await updateTeamWeeklyRecruitsLeaderboardForGuild(guild, db).catch(error => {
        console.error(`Could not refresh team monthly leaderboard for ${guild.name}:`);
        console.error(error);
        return false;
    });

    return {
        team: updatedTeam,
        syncFailures
    };
}

async function deleteOwnedTeam(guild, ownerDiscordId, db = sql) {
    const result = await db.begin(async transaction => {
        const archivedRows = await transaction`
            update teams
            set
                status = 'archived',
                archived_at = now(),
                updated_at = now()
            where guild_id = ${guild.id}
                and owner_discord_id = ${ownerDiscordId}
                and status = 'active'
            returning
                id::text as id,
                name,
                role_id,
                channel_id
        `;
        const team = archivedRows[0];

        if (!team) {
            throw new Error('You do not own an active team to delete.');
        }

        const clearedRows = await transaction`
            update players
            set
                team_id = null,
                updated_at = now()
            where team_id = ${team.id}::bigint
            returning discord_id
        `;

        return {
            team,
            clearedPlayerIds: clearedRows.map(row => row.discord_id)
        };
    });

    const synced = await syncPlayersTeamRoles(guild, result.clearedPlayerIds, db);
    const cleanup = await deleteArchivedTeamResources(
        guild,
        [result.team],
        `Penguin Mafia team deleted by ${ownerDiscordId}`
    );

    await updateTeamWeeklyRecruitsLeaderboardForGuild(guild, db).catch(error => {
        console.error(`Could not refresh team monthly leaderboard for ${guild.name}:`);
        console.error(error);
        return false;
    });

    return {
        ...result,
        synced,
        cleanup
    };
}

async function createTeamRole(guild, request) {
    const role = await guild.roles.create({
        name: request.name,
        color: Number(request.color),
        mentionable: true,
        reason: `Penguin Mafia team approved for ${request.owner_discord_id}`
    });

    return {
        role,
        channel: null
    };
}

async function fetchTeamRoles(db, guildId) {
    const rows = await db`
        select
            id::text as id,
            name,
            role_id,
            channel_id
        from teams
        where guild_id = ${guildId}
            and role_id is not null
    `;

    return rows.filter(row => row.role_id);
}

async function syncPlayerTeamRole(guild, playerDiscordId, db = sql) {
    const [teamRoles, playerRows, effectiveTeam] = await Promise.all([
        fetchTeamRoles(db, guild.id),
        db`
            select
                player.discord_id
            from players player
            where player.discord_id = ${playerDiscordId}
            limit 1
        `,
        fetchEffectiveTeamBucket(db, playerDiscordId, guild.id)
    ]);
    const player = playerRows[0];

    if (!player) {
        return false;
    }

    const member = await guild.members.fetch(playerDiscordId).catch(() => null);

    if (!member) {
        return false;
    }

    const targetRoleId = effectiveTeam?.role_id || null;
    const roleIdsToRemove = teamRoles
        .map(team => team.role_id)
        .filter(roleId => roleId && roleId !== targetRoleId && member.roles.cache.has(roleId));

    if (roleIdsToRemove.length > 0) {
        await member.roles.remove(roleIdsToRemove, 'Penguin Mafia team sync');
    }

    if (targetRoleId && !member.roles.cache.has(targetRoleId)) {
        await member.roles.add(targetRoleId, 'Penguin Mafia team sync');
    }

    return true;
}

async function syncPlayersTeamRoles(guild, playerIds, db = sql) {
    const uniqueIds = [...new Set(playerIds.filter(Boolean))];
    let synced = 0;

    for (const playerId of uniqueIds) {
        try {
            if (await syncPlayerTeamRole(guild, playerId, db)) {
                synced++;
            }
        } catch (error) {
            console.error(`Could not sync team role for ${playerId} in ${guild.name}:`);
            console.error(error);
        }
    }

    return synced;
}

async function syncAllTeamRoles(guild, db = sql) {
    const [teamRows, playerRows, members] = await Promise.all([
        fetchTeamRoles(db, guild.id),
        db`
            select
                base_player.discord_id,
                bucket.role_id
            from players base_player
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
                    where player.discord_id = base_player.discord_id

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
                select coalesce(owned_team.role_id, assigned_team.role_id) as role_id
                from (select 1 as seed) seed
                left join nearest_emperor emperor
                    on true
                left join teams owned_team
                    on owned_team.owner_discord_id = emperor.discord_id
                    and owned_team.guild_id = ${guild.id}
                    and owned_team.status = 'active'
                left join teams assigned_team
                    on assigned_team.id = base_player.team_id
                    and assigned_team.guild_id = ${guild.id}
                    and assigned_team.status = 'active'
                    and emperor.discord_id is null
            ) bucket
            where bucket.role_id is not null
        `,
        guild.members.fetch()
    ]);
    const allTeamRoleIds = [...new Set(teamRows.map(team => team.role_id).filter(Boolean))];
    const targetRoleByUserId = new Map(playerRows.map(row => [row.discord_id, row.role_id]));
    const result = {
        checked: 0,
        added: 0,
        removed: 0,
        failed: 0,
        legacyChannelsDeleted: 0,
        legacyChannelIdsCleared: 0,
        legacyChannelFailures: []
    };

    for (const [, member] of members) {
        if (member.user.bot) {
            continue;
        }

        result.checked++;

        try {
            const targetRoleId = targetRoleByUserId.get(member.user.id) || null;
            const rolesToRemove = allTeamRoleIds.filter(roleId => {
                return roleId !== targetRoleId && member.roles.cache.has(roleId);
            });

            if (rolesToRemove.length > 0) {
                await member.roles.remove(rolesToRemove, 'Penguin Mafia full team role sync');
                result.removed += rolesToRemove.length;
            }

            if (targetRoleId && !member.roles.cache.has(targetRoleId)) {
                await member.roles.add(targetRoleId, 'Penguin Mafia full team role sync');
                result.added++;
            }
        } catch (error) {
            result.failed++;
            console.error(`Full team role sync failed for ${member.user.tag}:`);
            console.error(error);
        }
    }

    await updateTeamWeeklyRecruitsLeaderboardForGuild(guild, db).catch(error => {
        console.error(`Could not refresh team monthly leaderboard for ${guild.name}:`);
        console.error(error);
        return false;
    });

    const channelCleanup = await cleanupLegacyTeamChannelsForGuild(guild, db);

    result.legacyChannelsDeleted = channelCleanup.deletedChannels;
    result.legacyChannelIdsCleared = channelCleanup.clearedChannelIds;
    result.legacyChannelFailures = channelCleanup.failures;

    return result;
}

async function assignPlayerTreeToTeam(guild, rootDiscordId, targetTeamId, db = sql, options = {}) {
    const normalizedTeamId = targetTeamId ? BigInt(targetTeamId).toString() : null;
    const protectRootOwnedTeam = Boolean(options.protectRootOwnedTeam);
    const affectedRows = await db`
        with recursive team_tree as (
            select
                player.discord_id,
                (
                    ${protectRootOwnedTeam}
                    and player.rank_name = 'Emperor Penguin'
                ) as blocked
            from players player
            where player.discord_id = ${rootDiscordId}

            union all

            select
                child.discord_id,
                (
                    child.rank_name = 'Emperor Penguin'
                    and child.discord_id <> ${rootDiscordId}
                ) as blocked
            from players child
            join team_tree parent
                on child.parent_discord_id = parent.discord_id
            where parent.blocked = false
        ),
        eligible_players as (
            select discord_id
            from team_tree
            where blocked = false
        )
        update players player
        set
            team_id = ${normalizedTeamId}::bigint,
            updated_at = now()
        from eligible_players
        where player.discord_id = eligible_players.discord_id
            and player.team_id is distinct from ${normalizedTeamId}::bigint
        returning player.discord_id
    `;
    const affectedPlayerIds = affectedRows.map(row => row.discord_id);
    const synced = await syncPlayersTeamRoles(guild, affectedPlayerIds, db);

    if (options.refreshLeaderboard !== false) {
        await updateTeamWeeklyRecruitsLeaderboardForGuild(guild, db).catch(error => {
            console.error(`Could not refresh team monthly leaderboard for ${guild.name}:`);
            console.error(error);
            return false;
        });
    }

    return {
        affectedPlayerIds,
        synced
    };
}

async function assignRecruitTreeToRecruiterTeam(guild, rootDiscordId, recruiterId, db = sql) {
    const team = await fetchEffectiveTeamBucket(db, recruiterId, guild.id);
    const assignment = await assignPlayerTreeToTeam(guild, rootDiscordId, team && !team.is_virtual ? team.id : null, db, {
        protectRootOwnedTeam: true
    });

    return {
        ...assignment,
        team
    };
}

async function postTeamRecruitWelcome(guild, recruiterId, recruitId, db = sql, teamOverride = null) {
    void guild;
    void recruiterId;
    void recruitId;
    void db;
    void teamOverride;
    return true;
}

async function postTeamTreeMoveAnnouncement(guild, team, rootDiscordId, recruiterId, affectedCount) {
    void guild;
    void team;
    void rootDiscordId;
    void recruiterId;
    void affectedCount;
    return true;
}

async function pingTeamRole(guild, team, channel = null) {
    if (team?.is_virtual) {
        return {
            sent: false,
            reason: `**${team.name}** is a default Emperor branch and does not have a custom team role yet. Use \`/createteam\` to request a team role.`
        };
    }

    if (!team?.role_id) {
        return { sent: false, reason: 'Team has no role configured.' };
    }

    const cooldown = canTeamPing(team.id);
    if (cooldown > 0) {
        return { sent: false, reason: `Team ping is on cooldown. Try again in **${cooldown}** seconds.` };
    }

    const targetChannel = channel?.isTextBased?.()
        ? channel
        : null;

    if (!targetChannel) {
        return { sent: false, reason: 'Use this command in a text channel so I know where to send the team ping.' };
    }

    consumeTeamPing(team.id);

    await targetChannel.send({
        content: `<@&${team.role_id}>`,
        allowedMentions: {
            roles: [team.role_id],
            parse: []
        }
    });

    return { sent: true };
}

async function approveTeamRequest(interaction, requestId, db = sql) {
    const requestRows = await db`
        select
            request.id,
            request.guild_id,
            request.owner_discord_id,
            request.name,
            request.normalized_name,
            request.color,
            request.status,
            owner.discord_username,
            owner.discord_display_name,
            owner.minecraft_ign,
            owner.rank_name
        from team_create_requests request
        left join players owner
            on owner.discord_id = request.owner_discord_id
        where request.id = ${requestId}
        limit 1
    `;
    const request = requestRows[0];

    if (!request) {
        return {
            ok: false,
            message: '❌ Team request not found.'
        };
    }

    if (request.status !== 'pending') {
        return {
            ok: false,
            message: `❌ This team request is already **${request.status}**.`
        };
    }

    if (request.rank_name !== 'Emperor Penguin') {
        await markTeamRequestFailed(db, request.id, interaction.user.id, 'Owner is no longer an Emperor Penguin.');
        return {
            ok: false,
            message: '❌ The requester is no longer an Emperor Penguin, so the team was not created.'
        };
    }

    const guild = interaction.client.guilds.cache.get(request.guild_id) ||
        (await interaction.client.guilds.fetch(request.guild_id).catch(() => null));

    if (!guild) {
        return {
            ok: false,
            message: '❌ I could not find the guild for this request.'
        };
    }

    const conflictRows = await db`
        select id, name
        from teams
        where guild_id = ${request.guild_id}
            and normalized_name = ${request.normalized_name}
            and status = 'active'
        limit 1
    `;

    if (conflictRows[0]) {
        await markTeamRequestFailed(db, request.id, interaction.user.id, `Team name conflict with ${conflictRows[0].name}.`);
        return {
            ok: false,
            message: `❌ A team named **${conflictRows[0].name}** already exists.`
        };
    }

    let role = null;
    let channel = null;

    try {
        const created = await createTeamRole(guild, request);
        role = created.role;
        channel = created.channel;

        const result = await db.begin(async transaction => {
            const lockedRows = await transaction`
                select status
                from team_create_requests
                where id = ${request.id}
                for update
            `;

            if (lockedRows[0]?.status !== 'pending') {
                throw new Error(`This request is already ${lockedRows[0]?.status || 'missing'}.`);
            }

            const archivedRows = await transaction`
                update teams
                set
                    status = 'archived',
                    archived_at = now(),
                    updated_at = now()
                where guild_id = ${request.guild_id}
                    and owner_discord_id = ${request.owner_discord_id}
                    and status = 'active'
                returning
                    id::text as id,
                    name,
                    role_id,
                    channel_id
            `;

            const teamRows = await transaction`
                insert into teams (
                    guild_id,
                    name,
                    normalized_name,
                    color,
                    owner_discord_id,
                    role_id,
                    channel_id,
                    status
                )
                values (
                    ${request.guild_id},
                    ${request.name},
                    ${request.normalized_name},
                    ${request.color},
                    ${request.owner_discord_id},
                    ${role.id},
                    ${channel?.id || null},
                    'active'
                )
                returning id::text as id, name, role_id, channel_id
            `;
            const team = teamRows[0];

            const assignedRows = await transaction`
                with recursive team_tree as (
                    select
                        player.discord_id,
                        player.parent_discord_id,
                        false as blocked
                    from players player
                    where player.discord_id = ${request.owner_discord_id}

                    union all

                    select
                        child.discord_id,
                        child.parent_discord_id,
                        (
                            child.rank_name = 'Emperor Penguin'
                            and child.discord_id <> ${request.owner_discord_id}
                        ) as blocked
                    from players child
                    join team_tree parent
                        on child.parent_discord_id = parent.discord_id
                    where parent.blocked = false
                ),
                eligible_players as (
                    select discord_id
                    from team_tree
                    where blocked = false
                )
                update players player
                set
                    team_id = ${team.id}::bigint,
                    updated_at = now()
                from eligible_players
                where player.discord_id = eligible_players.discord_id
                    and player.team_id is distinct from ${team.id}::bigint
                returning player.discord_id
            `;

            const clearedRows = archivedRows.length > 0
                ? await transaction`
                    update players player
                    set
                        team_id = null,
                        updated_at = now()
                    where player.team_id in ${transaction(archivedRows.map(row => BigInt(row.id)))}
                    returning player.discord_id
                `
                : [];

            await transaction`
                update team_create_requests
                set
                    status = 'approved',
                    team_id = ${team.id}::bigint,
                    decision_by_discord_id = ${interaction.user.id},
                    decided_at = now(),
                    updated_at = now()
                where id = ${request.id}
            `;

            return {
                team,
                archivedTeams: archivedRows,
                affectedPlayerIds: [
                    ...assignedRows.map(row => row.discord_id),
                    ...clearedRows.map(row => row.discord_id)
                ],
                archivedCount: archivedRows.length,
                assignedCount: assignedRows.length
            };
        });

        const synced = await syncPlayersTeamRoles(guild, result.affectedPlayerIds, db);
        const cleanup = await deleteArchivedTeamResources(
            guild,
            result.archivedTeams,
            `Penguin Mafia team replaced by ${request.owner_discord_id}`
        );

        await updateTeamWeeklyRecruitsLeaderboardForGuild(guild, db).catch(error => {
            console.error(`Could not refresh team monthly leaderboard for ${guild.name}:`);
            console.error(error);
            return false;
        });

        const ownerUser = await interaction.client.users.fetch(request.owner_discord_id).catch(() => null);

        await ownerUser?.send(
            `✅ The Don approved **Team ${request.name}**.\n` +
            `Your eligible recruit tree has been moved into the team in **${guild.name}**. Your team role can still be pinged with \`/teamping\`.`
        ).catch(() => null);

        return {
            ok: true,
            message:
                `✅ **Team approved.**\n\n` +
                `Team: **${request.name}**\n` +
                `Owner: <@${request.owner_discord_id}>\n` +
                `Role: <@&${role.id}>\n` +
                `Players synced: **${synced}**\n` +
                `Previous owner teams archived: **${result.archivedCount}**\n` +
                `Old team channels deleted: **${cleanup.deletedChannels}**\n` +
                `Old team roles deleted: **${cleanup.deletedRoles}**`
        };
    } catch (error) {
        await channel?.delete('Team approval failed after channel creation').catch(() => null);
        await role?.delete('Team approval failed after role creation').catch(() => null);
        await markTeamRequestFailed(db, request.id, interaction.user.id, error.message).catch(() => null);
        throw error;
    }
}

async function markTeamRequestFailed(db, requestId, actorId, note) {
    await db`
        update team_create_requests
        set
            status = 'failed',
            decision_by_discord_id = ${actorId},
            decision_note = ${note},
            decided_at = now(),
            updated_at = now()
        where id = ${requestId}
            and status = 'pending'
    `;
}

async function rejectTeamRequest(interaction, requestId, db = sql) {
    const rows = await db`
        update team_create_requests
        set
            status = 'rejected',
            decision_by_discord_id = ${interaction.user.id},
            decided_at = now(),
            updated_at = now()
        where id = ${requestId}
            and status = 'pending'
        returning
            owner_discord_id,
            name
    `;
    const request = rows[0];

    if (!request) {
        return {
            ok: false,
            message: '❌ Team request was not found or is no longer pending.'
        };
    }

    const ownerUser = await interaction.client.users.fetch(request.owner_discord_id).catch(() => null);

    await ownerUser?.send(
        `❌ The Don rejected your team request for **${request.name}**.`
    ).catch(() => null);

    return {
        ok: true,
        message: `✅ Rejected **${request.name}**.`
    };
}

async function handleTeamApprovalButton(interaction, db = sql) {
    const isApprove = interaction.customId.startsWith(TEAM_CREATE_APPROVE_PREFIX);
    const isReject = interaction.customId.startsWith(TEAM_CREATE_REJECT_PREFIX);

    if (!isApprove && !isReject) {
        return false;
    }

    if (!isDon(interaction.user.id)) {
        await interaction.reply({
            content: '❌ Only the Don can approve or reject team requests.'
        });
        return true;
    }

    await interaction.deferReply();

    const requestId = interaction.customId.slice(
        isApprove ? TEAM_CREATE_APPROVE_PREFIX.length : TEAM_CREATE_REJECT_PREFIX.length
    );
    const result = isApprove
        ? await approveTeamRequest(interaction, requestId, db)
        : await rejectTeamRequest(interaction, requestId, db);

    await interaction.message?.edit({
        components: []
    }).catch(() => null);

    await interaction.editReply({
        content: result.message,
        allowedMentions: {
            users: [],
            roles: [],
            parse: []
        }
    });

    return true;
}

module.exports = {
    assignPlayerTreeToTeam,
    assignRecruitTreeToRecruiterTeam,
    cleanupLegacyTeamChannelsForGuild,
    deleteOwnedTeam,
    fetchEffectiveTeamBucket,
    fetchPlayerTeam,
    formatTeamColor,
    handleTeamApprovalButton,
    normalizeTeamName,
    parseTeamColor,
    pingTeamRole,
    postTeamRecruitWelcome,
    postTeamTreeMoveAnnouncement,
    renameTeam,
    requestTeamCreation,
    syncAllTeamRoles,
    syncPlayerTeamRole,
    syncPlayersTeamRoles,
    teamLineForRecruiter,
    validateTeamName
};
