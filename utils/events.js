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
            `Promoted by: <@${promoterId}> 👏\n` +
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
            direct_recruits_count
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
            `What they still need:\n${evaluateEligibility(children, nextRank).requirements.join('\n')}`
        : `They are already at the highest Penguin rank. Keep building the tree.`;

    await channel.send({
        content:
            `🌟🐧 **FIRST RECRUIT!** 🐧🌟\n\n` +
            `<@${recruiterId}> got their first direct recruit: <@${recruitId}>!\n` +
            `Recruiter: **${playerName(recruiter, 'Unknown Player')}**\n` +
            `New recruit: **${playerName(recruit || {}, 'Unknown Player')}**\n` +
            `Current rank: **${recruiter.rank_name}**\n\n` +
            `${progressLine}\n\n` +
            `The recruit tree has officially started. 🎉`,
        allowedMentions: {
            users: uniqueMentions(recruiterId, recruitId)
        }
    });

    return true;
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

module.exports = {
    postDonationEvent,
    postFirstRecruitEvent,
    postPromotionEvent,
    postStaffPromotionEvent
};
