const {
    ChannelType
} = require('discord.js');
const {
    PROMOTION_EVENTS_CHANNEL_ID,
    PROMOTION_EVENTS_CHANNEL_NAME
} = require('./bootstrap.js');
const {
    formatDonationAmount
} = require('./donations.js');
const {
    evaluateEligibility,
    getNextRank,
    playerName
} = require('./ranks.js');

async function findPromotionEventsChannel(guild) {
    const channels = await guild.channels.fetch();
    const channel = channels.get(PROMOTION_EVENTS_CHANNEL_ID);

    return channel?.type === ChannelType.GuildText ? channel : null;
}

function uniqueMentions(...ids) {
    return [...new Set(ids.filter(Boolean))];
}

async function fetchEffectiveTeamName(db, playerId, guildId) {
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
            where player.discord_id = ${playerId}

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
        select coalesce(
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
        ) as team_name
        from recruiter
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
        limit 1
    `;

    return rows[0]?.team_name || null;
}

async function postPromotionEvent(guild, {
    playerId,
    promoterId,
    recruiterId,
    oldRank,
    newRank
}) {
    const channel = await findPromotionEventsChannel(guild);

    if (!channel) {
        console.log(`Promotion event channel ${PROMOTION_EVENTS_CHANNEL_NAME} was not found by ID ${PROMOTION_EVENTS_CHANNEL_ID}.`);
        return false;
    }

    const recruiterLine = recruiterId
        ? `Recruiter notified: <@${recruiterId}> 🐧📬`
        : `Recruiter notified: The Don's iceberg 👑🐧`;

    await channel.send({
        content:
            `🎖️🐧 **PROMOTION ALERT!** 🐧🎖️\n\n` +
            `<@${playerId}> has waddled up from **${oldRank}** to **${newRank}**! 🧊⬆️\n` +
            `${promoterId ? `Promoted by: <@${promoterId}> 👏\n` : ''}` +
            `${recruiterLine}\n\n` +
            `The Penguin Mafia grows stronger. Make some noise! 🎉🐧`,
        allowedMentions: {
            users: uniqueMentions(playerId, promoterId, recruiterId)
        }
    });

    return true;
}

async function postStaffPromotionEvent(guild, {
    playerId,
    promoterId,
    oldRank,
    newRank
}) {
    const channel = await findPromotionEventsChannel(guild);

    if (!channel) {
        console.log(`Promotion event channel ${PROMOTION_EVENTS_CHANNEL_NAME} was not found by ID ${PROMOTION_EVENTS_CHANNEL_ID}.`);
        return false;
    }

    const promotionLine = oldRank
        ? `<@${playerId}> has been promoted from **${oldRank}** to **${newRank}**.`
        : `<@${playerId}> has been promoted to **${newRank}**.`;

    await channel.send({
        content:
            `🛡️🐧 **STAFF PROMOTION ALERT!** 🐧🛡️\n\n` +
            `${promotionLine}\n` +
            `Promoted by: <@${promoterId}> 👏\n\n` +
            `Keep the iceberg fair, steady, and sharp. 🎖️`,
        allowedMentions: {
            users: uniqueMentions(playerId, promoterId)
        }
    });

    return true;
}

async function postTrainerPromotionEvent(guild, {
    playerId
}) {
    const channel = await findPromotionEventsChannel(guild);

    if (!channel) {
        console.log(`Promotion event channel ${PROMOTION_EVENTS_CHANNEL_NAME} was not found by ID ${PROMOTION_EVENTS_CHANNEL_ID}.`);
        return false;
    }

    await channel.send({
        content:
            `🎓🐧 **NEW PENGUIN TRAINER!** 🐧🎓\n\n` +
            `<@${playerId}> has accepted the **Penguin Trainer** role!\n\n` +
            `They can now help guide fresh recruits one iceberg at a time. 🧊📚`,
        allowedMentions: {
            users: uniqueMentions(playerId)
        }
    });

    return true;
}

async function postFirstRecruitEvent(guild, db, {
    recruiterId,
    recruitId
}) {
    const channel = await findPromotionEventsChannel(guild);

    if (!channel) {
        console.log(`Promotion event channel ${PROMOTION_EVENTS_CHANNEL_NAME} was not found by ID ${PROMOTION_EVENTS_CHANNEL_ID}.`);
        return false;
    }

    const recruiterRows = await db`
        select
            discord_id,
            discord_username,
            discord_display_name,
            minecraft_ign,
            rank_name,
            direct_recruits_count,
            captain_direct_recruits_count
        from players
        where discord_id = ${recruiterId}
        limit 1
    `;
    const recruiter = recruiterRows[0];

    if (!recruiter || recruiter.direct_recruits_count !== 1) {
        return false;
    }

    const recruitRows = await db`
        select
            discord_id,
            discord_username,
            discord_display_name,
            minecraft_ign,
            rank_name
        from players
        where discord_id = ${recruitId}
        limit 1
    `;
    const recruit = recruitRows[0];
    const children = await db`
        select
            discord_id,
            discord_username,
            discord_display_name,
            minecraft_ign,
            rank_name
        from players
        where parent_discord_id = ${recruiterId}
        order by discord_display_name asc
    `;

    const nextRank = getNextRank(recruiter.rank_name);
    const progressLine = nextRank
        ? `Next promotion: **${nextRank}**\n` +
            `What they still need:\n${evaluateEligibility(children, nextRank, {
                captainDirectRecruitsCount: Number(recruiter.captain_direct_recruits_count || 0)
            }).requirements.join('\n')}`
        : `They are already at the highest Penguin rank. Keep building the tree.`;
    const teamName = await fetchEffectiveTeamName(db, recruiterId, guild.id).catch(error => {
        console.error('Could not fetch effective team name for first recruit event:');
        console.error(error);
        return null;
    });
    const teamLine = teamName
        ? `Team: **${teamName}**\n`
        : '';

    await channel.send({
        content:
            `🌟🐧 **FIRST RECRUIT!** 🐧🌟\n\n` +
            `<@${recruiterId}> got their first direct recruit: <@${recruitId}>!\n` +
            `Recruiter: **${playerName(recruiter, 'Unknown Player')}**\n` +
            `New recruit: **${playerName(recruit || {}, 'Unknown Player')}**\n` +
            `Current rank: **${recruiter.rank_name}**\n\n` +
            `${teamLine}` +
            `${progressLine}\n\n` +
            `The recruit tree has officially started. 🎉`,
        allowedMentions: {
            users: uniqueMentions(recruiterId, recruitId)
        }
    });

    return true;
}

const BRANCH_MILESTONES = [
    {
        rankName: 'Penguin Captain',
        columnName: 'first_captain_branch_notified_at',
        title: '🟢⭐ FIRST CAPTAIN BRANCH! ⭐🟢',
        line: 'now has their first **Penguin Captain** under them.',
        flavor: 'The colony is growing. That branch has leadership energy. 🐧🌲'
    },
    {
        rankName: 'Penguin General',
        columnName: 'first_general_branch_notified_at',
        title: '🟡⭐ FIRST GENERAL BRANCH! ⭐🟡',
        line: 'now has their first **Penguin General** under them.',
        flavor: 'That branch is getting powerful. The ice noticed. 🐧⚡'
    },
    {
        rankName: 'Emperor Penguin',
        columnName: 'first_emperor_branch_notified_at',
        title: '🟣⭐ FIRST EMPEROR BRANCH! ⭐🟣',
        line: 'now has their first **Emperor Penguin** under them.',
        flavor: 'Royal ice energy detected. The tree is officially serious. 👑🐧'
    }
];

async function postBranchMilestoneEvents(guild, db, recruiterId) {
    if (!recruiterId) {
        return [];
    }

    const channel = await findPromotionEventsChannel(guild);

    if (!channel) {
        console.log(`Promotion event channel ${PROMOTION_EVENTS_CHANNEL_NAME} was not found by ID ${PROMOTION_EVENTS_CHANNEL_ID}.`);
        return [];
    }

    const recruiterRows = await db`
        select
            discord_id,
            discord_username,
            discord_display_name,
            minecraft_ign,
            rank_name,
            first_captain_branch_notified_at,
            first_general_branch_notified_at,
            first_emperor_branch_notified_at
        from players
        where discord_id = ${recruiterId}
        limit 1
    `;
    const recruiter = recruiterRows[0];

    if (!recruiter) {
        return [];
    }

    const children = await db`
        select rank_name, count(*)::int as count
        from players
        where parent_discord_id = ${recruiterId}
            and rank_name in ('Penguin Captain', 'Penguin General', 'Emperor Penguin')
        group by rank_name
    `;
    const counts = new Map(children.map(row => [row.rank_name, Number(row.count)]));
    const posted = [];

    for (const milestone of BRANCH_MILESTONES) {
        if (recruiter[milestone.columnName] || (counts.get(milestone.rankName) || 0) < 1) {
            continue;
        }

        const updatedRows = await db`
            update players
            set
                ${db(milestone.columnName)} = now(),
                updated_at = now()
            where discord_id = ${recruiterId}
                and ${db(milestone.columnName)} is null
            returning discord_id
        `;

        if (updatedRows.length === 0) {
            continue;
        }

        await channel.send({
            content:
                `${milestone.title}\n\n` +
                `<@${recruiterId}> ${milestone.line}\n` +
                `Penguin: **${playerName(recruiter, 'Unknown Player')}**\n` +
                `Current rank: **${recruiter.rank_name}**\n\n` +
                `${milestone.flavor}`,
            allowedMentions: {
                users: uniqueMentions(recruiterId)
            }
        });

        posted.push(milestone.rankName);
    }

    return posted;
}

async function postDonationEvent(guild, {
    playerId,
    amount,
    newTotal
}) {
    const channel = await findPromotionEventsChannel(guild);

    if (!channel) {
        console.log(`Promotion event channel ${PROMOTION_EVENTS_CHANNEL_NAME} was not found by ID ${PROMOTION_EVENTS_CHANNEL_ID}.`);
        return false;
    }

    await channel.send({
        content:
            `💎🐧 **DONATION DROP!** 🐧💎\n\n` +
            `<@${playerId}> donated **${formatDonationAmount(amount)}** to the Penguin Mafia! 🧊💰\n` +
            `New all-time total: **${formatDonationAmount(newTotal)}**\n\n` +
            `The vault is getting shinier. 👑✨`,
        allowedMentions: {
            users: uniqueMentions(playerId)
        }
    });

    return true;
}

async function postGiveawayDonationEvent(guild, {
    playerId,
    amount,
    newTotal
}) {
    const channel = await findPromotionEventsChannel(guild);

    if (!channel) {
        console.log(`Promotion event channel ${PROMOTION_EVENTS_CHANNEL_NAME} was not found by ID ${PROMOTION_EVENTS_CHANNEL_ID}.`);
        return false;
    }

    await channel.send({
        content:
            `🎁💎 **GIVEAWAY DONATION!** 💎🎁\n\n` +
            `<@${playerId}> hosted a **${formatDonationAmount(amount)}** giveaway for the Penguin Mafia.\n` +
            `This counts toward their donation total.\n` +
            `New all-time total: **${formatDonationAmount(newTotal)}**`,
        allowedMentions: {
            users: uniqueMentions(playerId)
        }
    });

    return true;
}

async function postAutoPromotionEventIfDue(guild, db, playerId, oldRank) {
    const rows = await db`
        select rank_name from players where discord_id = ${playerId} limit 1
    `;
    const newRank = rows[0]?.rank_name;

    if (!newRank || !oldRank || newRank === oldRank) {
        return false;
    }

    return postPromotionEvent(guild, {
        playerId,
        promoterId: null,
        recruiterId: null,
        oldRank,
        newRank
    });
}

module.exports = {
    postAutoPromotionEventIfDue,
    postBranchMilestoneEvents,
    postDonationEvent,
    postGiveawayDonationEvent,
    postFirstRecruitEvent,
    postPromotionEvent,
    postStaffPromotionEvent,
    postTrainerPromotionEvent
};
