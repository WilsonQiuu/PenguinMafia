const {
    ensureStaffRoles,
    syncMemberStaffRankFromRoles
} = require('./bootstrap.js');

const STAFF_KICK_RANKS = new Set([
    'Moderator',
    'Sr Moderator',
    'Admin'
]);
const STAFF_RANK_ORDER = [
    'Trial Mod',
    'Moderator',
    'Sr Moderator',
    'Admin'
];
const BUILT_IN_DON_DISCORD_IDS = [
    '719063111008780338'
];

function parseDiscordIdList(value) {
    return String(value || '')
        .split(/[,\s]+/)
        .map(id => id.trim())
        .filter(Boolean);
}

function donDiscordIds() {
    return [...new Set([
        process.env.DON_DISCORD_ID,
        ...parseDiscordIdList(process.env.ADDITIONAL_DON_DISCORD_IDS),
        ...parseDiscordIdList(process.env.DON_DISCORD_IDS),
        ...BUILT_IN_DON_DISCORD_IDS
    ].filter(Boolean))];
}

function getStaffRankIndex(staffRankName) {
    return STAFF_RANK_ORDER.indexOf(staffRankName);
}

function isDon(userId) {
    return Boolean(userId && donDiscordIds().includes(userId));
}

function parseDiscordId(input) {
    const match = input.trim().match(/^(?:<@!?)?(\d{17,20})>?$/);
    return match ? match[1] : null;
}

async function syncInvokerStaffRank(sql, member) {
    const { staffRoles } = await ensureStaffRoles(member.guild);
    await syncMemberStaffRankFromRoles(sql, member, staffRoles);
}

async function syncMemberStaffRank(sql, member) {
    const { staffRoles } = await ensureStaffRoles(member.guild);
    await syncMemberStaffRankFromRoles(sql, member, staffRoles);
}

async function getStaffProfile(sql, discordId) {
    const rows = await sql`
        select
            player.discord_id,
            player.discord_username,
            player.discord_display_name,
            player.staff_rank_name,
            player.ban_points_remaining,
            coalesce(staff.ban_point_limit, 0)::int as ban_point_limit
        from players player
        left join staff_ranks staff
            on player.staff_rank_name = staff.name
        where player.discord_id = ${discordId}
        limit 1
    `;

    return rows[0] || null;
}

async function requireStaffCanKick(sql, interaction) {
    if (isDon(interaction.user.id)) {
        return {
            isDon: true,
            staffRankName: 'Don',
            banPointsRemaining: null
        };
    }

    await syncInvokerStaffRank(sql, interaction.member);
    const staff = await getStaffProfile(sql, interaction.user.id);

    if (!staff?.staff_rank_name || !STAFF_KICK_RANKS.has(staff.staff_rank_name)) {
        throw new Error('You need Moderator or higher to use /kick.');
    }

    if (Number(staff.ban_point_limit || 0) <= 0) {
        throw new Error(`${staff.staff_rank_name} cannot use /kick.`);
    }

    if (Number(staff.ban_points_remaining || 0) <= 0) {
        throw new Error('You have no ban points remaining. Ask the Don to run /verify for you.');
    }

    return {
        isDon: false,
        staffRankName: staff.staff_rank_name,
        banPointsRemaining: Number(staff.ban_points_remaining || 0)
    };
}

async function requireStaffCanBan(sql, interaction) {
    if (isDon(interaction.user.id)) {
        return {
            isDon: true,
            staffRankName: 'Don',
            banPointsRemaining: null
        };
    }

    await syncInvokerStaffRank(sql, interaction.member);
    const staff = await getStaffProfile(sql, interaction.user.id);

    if (!staff?.staff_rank_name) {
        throw new Error('You need a Staff rank to use this command.');
    }

    if (Number(staff.ban_point_limit || 0) <= 0) {
        throw new Error(`${staff.staff_rank_name} cannot use /ban.`);
    }

    if (Number(staff.ban_points_remaining || 0) <= 0) {
        throw new Error('You have no ban points remaining. Ask the Don to run /verify for you.');
    }

    return {
        isDon: false,
        staffRankName: staff.staff_rank_name,
        banPointsRemaining: Number(staff.ban_points_remaining)
    };
}

async function assertCanModerateTargetStaff(sql, interaction, targetDiscordId, actionName) {
    if (isDon(interaction.user.id)) {
        return null;
    }

    const actor = await getStaffProfile(sql, interaction.user.id);

    if (!actor?.staff_rank_name) {
        throw new Error('You need a Staff rank to use this command.');
    }

    let targetMember = null;

    try {
        targetMember = await interaction.guild.members.fetch(targetDiscordId);
    } catch {
        targetMember = null;
    }

    if (targetMember) {
        await syncMemberStaffRank(sql, targetMember);
    }

    const target = await getStaffProfile(sql, targetDiscordId);

    if (!target?.staff_rank_name) {
        return target;
    }

    const actorRankIndex = getStaffRankIndex(actor.staff_rank_name);
    const targetRankIndex = getStaffRankIndex(target.staff_rank_name);

    if (actorRankIndex === -1 || targetRankIndex === -1) {
        throw new Error('Could not verify Staff rank hierarchy.');
    }

    if (targetRankIndex >= actorRankIndex) {
        throw new Error(
            `You cannot ${actionName} Staff at or above your Staff rank. ` +
            `You are \`${actor.staff_rank_name}\`; target is \`${target.staff_rank_name}\`.`
        );
    }

    return target;
}

async function consumeBanPoint(sql, discordId) {
    const rows = await sql`
        update players player
        set
            ban_points_remaining = ban_points_remaining - 1,
            updated_at = now()
        from staff_ranks staff
        where player.discord_id = ${discordId}
            and player.staff_rank_name = staff.name
            and staff.ban_point_limit > 0
            and player.ban_points_remaining > 0
        returning player.ban_points_remaining
    `;

    if (rows.length === 0) {
        throw new Error('You have no ban points remaining. Ask the Don to run /verify for you.');
    }

    return Number(rows[0].ban_points_remaining);
}

async function refundBanPoint(sql, discordId) {
    await sql`
        update players player
        set
            ban_points_remaining = least(player.ban_points_remaining + 1, coalesce(staff.ban_point_limit, 0)),
            updated_at = now()
        from staff_ranks staff
        where player.discord_id = ${discordId}
            and player.staff_rank_name = staff.name
    `;
}

module.exports = {
    assertCanModerateTargetStaff,
    consumeBanPoint,
    donDiscordIds,
    getStaffProfile,
    getStaffRankIndex,
    isDon,
    parseDiscordId,
    refundBanPoint,
    requireStaffCanBan,
    requireStaffCanKick,
    syncMemberStaffRank,
    syncInvokerStaffRank
};
