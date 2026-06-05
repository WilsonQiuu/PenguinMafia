const RANK_NAMES = [
    'Penguin Soldier',
    'Penguin Captain',
    'Penguin General',
    'Emperor Penguin'
];
const {
    ensureRankRoles
} = require('./bootstrap.js');

const RANK_ORDER = new Map(RANK_NAMES.map((rank, index) => [rank, index]));

function getRankIndex(rankName) {
    return RANK_ORDER.get(rankName);
}

function getNextRank(rankName) {
    const rankIndex = getRankIndex(rankName);

    if (rankIndex === undefined || rankIndex >= RANK_NAMES.length - 1) {
        return null;
    }

    return RANK_NAMES[rankIndex + 1];
}

function getPreviousRank(rankName) {
    const rankIndex = getRankIndex(rankName);

    if (rankIndex === undefined || rankIndex <= 0) {
        return null;
    }

    return RANK_NAMES[rankIndex - 1];
}

function canRecruiterTakeRecruit(recruiterRankName, recruitRankName) {
    const recruiterRankIndex = getRankIndex(recruiterRankName);
    const recruitRankIndex = getRankIndex(recruitRankName);

    if (recruiterRankIndex === undefined || recruitRankIndex === undefined) {
        return false;
    }

    return recruiterRankIndex >= recruitRankIndex;
}

function countAtLeast(children, rankName) {
    const minimumRank = getRankIndex(rankName);

    return children.filter(child => {
        const childRank = getRankIndex(child.rank_name);
        return childRank !== undefined && childRank >= minimumRank;
    }).length;
}

function missingLine(label, current, required) {
    const missing = Math.max(0, required - current);
    return `- ${label}: **${current}/${required}**${missing > 0 ? `, need **${missing}** more` : ''}`;
}

function evaluateEligibility(children, targetRank) {
    const totalChildren = children.length;
    const captainOrHigher = countAtLeast(children, 'Penguin Captain');
    const generalOrHigher = countAtLeast(children, 'Penguin General');
    const requirements = [];
    let eligible = false;

    if (targetRank === 'Penguin Captain') {
        eligible = totalChildren >= 3;
        requirements.push(missingLine('Direct recruits at Penguin Soldier or higher', totalChildren, 3));
    } else if (targetRank === 'Penguin General') {
        eligible = captainOrHigher >= 3;
        requirements.push(missingLine('Direct recruits at Penguin Captain or higher', captainOrHigher, 3));
    } else if (targetRank === 'Emperor Penguin') {
        eligible = generalOrHigher >= 2 && captainOrHigher >= 3;
        requirements.push(missingLine('Direct recruits at Penguin General or higher', generalOrHigher, 2));
        requirements.push(missingLine('Total direct recruits at Penguin Captain or higher', captainOrHigher, 3));
    }

    return {
        eligible,
        requirements,
        totalChildren,
        captainOrHigher,
        generalOrHigher
    };
}

function playerName(player, fallback = 'Unknown Player') {
    return player.discord_display_name ||
        player.discord_username ||
        fallback;
}

async function syncRankRole(guild, discordId, rankName) {
    let member = null;

    try {
        member = await guild.members.fetch(discordId);
    } catch {
        return false;
    }

    const { rankRoles } = await ensureRankRoles(guild);
    const rankRoleList = RANK_NAMES
        .map(name => rankRoles.get(name))
        .filter(Boolean);
    const targetRole = rankRoles.get(rankName);

    if (!targetRole) {
        return false;
    }

    const rolesToRemove = rankRoleList.filter(role => role.id !== targetRole?.id && member.roles.cache.has(role.id));

    if (rolesToRemove.length > 0) {
        await member.roles.remove(rolesToRemove, 'Penguin Mafia rank change');
    }

    if (targetRole && !member.roles.cache.has(targetRole.id)) {
        await member.roles.add(targetRole, 'Penguin Mafia rank change');
    }

    return true;
}

module.exports = {
    RANK_NAMES,
    canRecruiterTakeRecruit,
    evaluateEligibility,
    getNextRank,
    getPreviousRank,
    getRankIndex,
    playerName,
    syncRankRole
};
