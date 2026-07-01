const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    PermissionFlagsBits
} = require('discord.js');

const sql = require('../db.js');
const {
    TEAM_CHANNEL_CATEGORY_ID
} = require('./bootstrap.js');
const {
    updateTeamWeeklyRecruitsLeaderboardForGuild
} = require('./leaderboards.js');

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

function teamChannelName(name) {
    const slug = String(name || 'team')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 84);

    return `team-${slug || 'chat'}`;
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

async function teamLineForRecruiter(db, recruiterId) {
    const team = await fetchPlayerTeam(db, recruiterId);

    return team ? `Team: **${team.name}**\n` : '';
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
                `Approve this to create the Discord role, private team channel, and move their eligible tree into the team.`,
            components: [approvalRow(request.id)]
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
                reason: `Penguin Mafia team renamed by ${ownerDiscordId}`
            }).catch(error => {
                syncFailures.push(`Role: ${error.message}`);
            });
        } else {
            syncFailures.push(`Role ${updatedTeam.role_id} was not found`);
        }
    }

    if (updatedTeam.channel_id) {
        const channel = guild.channels.cache.get(updatedTeam.channel_id) ||
            (await guild.channels.fetch(updatedTeam.channel_id).catch(() => null));

        if (channel) {
            await channel.edit({
                name: teamChannelName(updatedTeam.name),
                reason: `Penguin Mafia team renamed by ${ownerDiscordId}`
            }).catch(error => {
                syncFailures.push(`Channel: ${error.message}`);
            });
        } else {
            syncFailures.push(`Channel ${updatedTeam.channel_id} was not found`);
        }
    }

    await updateTeamWeeklyRecruitsLeaderboardForGuild(guild, db).catch(error => {
        console.error(`Could not refresh team weekly leaderboard for ${guild.name}:`);
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
        console.error(`Could not refresh team weekly leaderboard for ${guild.name}:`);
        console.error(error);
        return false;
    });

    return {
        ...result,
        synced,
        cleanup
    };
}

async function createTeamRoleAndChannel(guild, request) {
    const role = await guild.roles.create({
        name: request.name,
        color: Number(request.color),
        reason: `Penguin Mafia team approved for ${request.owner_discord_id}`
    });
    let channel = null;

    try {
        const permissionOverwrites = [
            {
                id: guild.roles.everyone.id,
                deny: [PermissionFlagsBits.ViewChannel]
            },
            {
                id: role.id,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory
                ]
            },
            {
                id: guild.client.user.id,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.ManageChannels
                ]
            }
        ];

        const createdChannel = await guild.channels.create({
            name: teamChannelName(request.name),
            type: ChannelType.GuildText,
            parent: TEAM_CHANNEL_CATEGORY_ID,
            permissionOverwrites,
            reason: `Penguin Mafia team channel for ${request.name}`
        });
        channel = await guild.channels.fetch(createdChannel.id).catch(() => createdChannel);

        if (!channel?.id || !channel.isTextBased?.()) {
            throw new Error('Team channel was created, but I could not verify the created text channel ID.');
        }

        return {
            role,
            channel
        };
    } catch (error) {
        await role.delete('Team channel creation failed').catch(() => null);
        throw error;
    }
}

async function fetchTeamRoles(db, guildId) {
    const rows = await db`
        select
            id::text as id,
            role_id
        from teams
        where guild_id = ${guildId}
            and role_id is not null
    `;

    return rows.filter(row => row.role_id);
}

async function syncPlayerTeamRole(guild, playerDiscordId, db = sql) {
    const [teamRoles, playerRows] = await Promise.all([
        fetchTeamRoles(db, guild.id),
        db`
            select
                player.discord_id,
                team.id::text as team_id,
                team.role_id
            from players player
            left join teams team
                on team.id = player.team_id
                and team.status = 'active'
            where player.discord_id = ${playerDiscordId}
            limit 1
        `
    ]);
    const player = playerRows[0];

    if (!player) {
        return false;
    }

    const member = await guild.members.fetch(playerDiscordId).catch(() => null);

    if (!member) {
        return false;
    }

    const targetRoleId = player.role_id || null;
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
                player.discord_id,
                team.role_id
            from players player
            join teams team
                on team.id = player.team_id
                and team.status = 'active'
            where team.guild_id = ${guild.id}
                and team.role_id is not null
        `,
        guild.members.fetch()
    ]);
    const allTeamRoleIds = [...new Set(teamRows.map(team => team.role_id).filter(Boolean))];
    const targetRoleByUserId = new Map(playerRows.map(row => [row.discord_id, row.role_id]));
    const result = {
        checked: 0,
        added: 0,
        removed: 0,
        failed: 0
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
        console.error(`Could not refresh team weekly leaderboard for ${guild.name}:`);
        console.error(error);
        return false;
    });

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
                    and exists (
                        select 1
                        from teams owned_team
                        where owned_team.owner_discord_id = player.discord_id
                            and owned_team.status = 'active'
                            and (
                                ${normalizedTeamId}::bigint is null
                                or owned_team.id <> ${normalizedTeamId}::bigint
                            )
                    )
                ) as blocked
            from players player
            where player.discord_id = ${rootDiscordId}

            union all

            select
                child.discord_id,
                (
                    child.rank_name = 'Emperor Penguin'
                    and exists (
                        select 1
                        from teams owned_team
                        where owned_team.owner_discord_id = child.discord_id
                            and owned_team.status = 'active'
                            and (
                                ${normalizedTeamId}::bigint is null
                                or owned_team.id <> ${normalizedTeamId}::bigint
                            )
                    )
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
            console.error(`Could not refresh team weekly leaderboard for ${guild.name}:`);
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
    const team = await fetchPlayerTeam(db, recruiterId);
    const assignment = await assignPlayerTreeToTeam(guild, rootDiscordId, team?.id || null, db, {
        protectRootOwnedTeam: true
    });

    return {
        ...assignment,
        team
    };
}

async function postTeamRecruitWelcome(guild, recruiterId, recruitId, db = sql, teamOverride = null) {
    const team = teamOverride || await fetchPlayerTeam(db, recruiterId);

    if (!team?.channel_id) {
        return false;
    }

    const recruitTeamRows = await db`
        select team_id::text as team_id
        from players
        where discord_id = ${recruitId}
        limit 1
    `;

    if (recruitTeamRows[0]?.team_id !== team.id) {
        return false;
    }

    const channel = guild.channels.cache.get(team.channel_id) ||
        (await guild.channels.fetch(team.channel_id).catch(() => null));

    if (!channel?.isTextBased?.()) {
        return false;
    }

    await channel.send({
        content:
            `🐧 Welcome <@${recruitId}> to **Team ${team.name}**!\n` +
            `Recruited by <@${recruiterId}>.`,
        allowedMentions: {
            users: [recruitId, recruiterId],
            parse: []
        }
    });

    return true;
}

async function postTeamTreeMoveAnnouncement(guild, team, rootDiscordId, recruiterId, affectedCount) {
    if (!team?.channel_id || !affectedCount) {
        return false;
    }

    const channel = guild.channels.cache.get(team.channel_id) ||
        (await guild.channels.fetch(team.channel_id).catch(() => null));

    if (!channel?.isTextBased?.()) {
        return false;
    }

    await channel.send({
        content:
            `🐧 **Team Update**\n\n` +
            `<@${rootDiscordId}>${affectedCount > 1 ? ` and **${affectedCount - 1}** player(s) in their tree` : ''} ` +
            `joined **Team ${team.name}** under <@${recruiterId}>.`,
        allowedMentions: {
            users: [rootDiscordId, recruiterId],
            parse: []
        }
    });

    return true;
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
        const created = await createTeamRoleAndChannel(guild, request);
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
                    ${channel.id},
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
                            and exists (
                                select 1
                                from teams owned_team
                                where owned_team.owner_discord_id = child.discord_id
                                    and owned_team.status = 'active'
                                    and owned_team.id <> ${team.id}::bigint
                            )
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
            console.error(`Could not refresh team weekly leaderboard for ${guild.name}:`);
            console.error(error);
            return false;
        });

        await channel.send({
            content:
                `🐧 **Welcome to Team ${result.team.name}!**\n\n` +
                `<@${request.owner_discord_id}> is the team owner.\n` +
                `Only members with the team role can see this chat.`,
            allowedMentions: {
                users: [request.owner_discord_id],
                parse: []
            }
        }).catch(() => null);

        const ownerUser = await interaction.client.users.fetch(request.owner_discord_id).catch(() => null);

        await ownerUser?.send(
            `✅ The Don approved **Team ${request.name}**.\n` +
            `Your eligible recruit tree has been moved into the team, and your private team chat is ready in **${guild.name}**.`
        ).catch(() => null);

        return {
            ok: true,
            message:
                `✅ **Team approved.**\n\n` +
                `Team: **${request.name}**\n` +
                `Owner: <@${request.owner_discord_id}>\n` +
                `Role: <@&${role.id}>\n` +
                `Channel: <#${result.team.channel_id}>\n` +
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

    if (!process.env.DON_DISCORD_ID || interaction.user.id !== process.env.DON_DISCORD_ID) {
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
    deleteOwnedTeam,
    fetchPlayerTeam,
    formatTeamColor,
    handleTeamApprovalButton,
    normalizeTeamName,
    parseTeamColor,
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
