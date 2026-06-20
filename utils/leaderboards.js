const {
    DONATIONS_LEADERBOARD_CHANNEL_ID,
    DONATIONS_LEADERBOARD_CHANNEL_NAME,
    HOURLY_RECRUITS_LEADERBOARD_CHANNEL_ID,
    WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_ID,
    WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_NAME
} = require('./bootstrap.js');
const {
    formatDonationAmount
} = require('./donations.js');

const PREVIOUS_WEEKLY_RECRUITS_STATE_KEY = 'previous_weekly_recruits_top_three';

function leaderboardName(player) {
    return player.minecraft_ign ||
        player.discord_display_name ||
        player.discord_username ||
        'Unknown Penguin';
}

function leaderboardLine(index, player, value, suffix) {
    const medals = ['🥇', '🥈', '🥉'];
    const marker = medals[index] || `**${index + 1}.**`;

    return `${marker} **${leaderboardName(player)}** - **${value}** ${suffix}`;
}

async function updateLeaderboardChannel(guild, channelId, channelName, marker, content) {
    const channels = await guild.channels.fetch();
    const channel = channels.get(channelId);

    if (!channel) {
        console.log(`Leaderboard channel ${channelName} was not found by ID ${channelId}.`);
        return false;
    }

    const recentMessages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const matchingMessages = [...(recentMessages?.filter(message => {
        return message.author.id === guild.client.user.id && message.content.includes(marker);
    }).values() || [])];
    const existingMessage = matchingMessages[0];

    if (existingMessage) {
        await existingMessage.edit({
            content,
            allowedMentions: {
                parse: []
            }
        });
    } else {
        await channel.send({
            content,
            allowedMentions: {
                parse: []
            }
        });
    }

    for (const duplicateMessage of matchingMessages.filter(message => message.id !== existingMessage?.id)) {
        await duplicateMessage.delete().catch(() => null);
    }

    return true;
}

async function updateWeeklyRecruitsLeaderboardForGuild(guild, sql) {
    const [weeklyRows, previousRows] = await Promise.all([
        sql`
        select
            discord_id,
            discord_username,
            discord_display_name,
            minecraft_ign,
            weekly_direct_recruits_count
        from players
        where weekly_direct_recruits_count > 0
        order by weekly_direct_recruits_count desc, discord_display_name asc
        limit 10
        `,
        sql`
            select value
            from bot_state
            where key = ${PREVIOUS_WEEKLY_RECRUITS_STATE_KEY}
            limit 1
        `
    ]);
    let previousTopThree = [];

    try {
        previousTopThree = previousRows[0]?.value
            ? JSON.parse(previousRows[0].value)
            : [];
    } catch (error) {
        console.warn(`Could not parse previous weekly recruit winners: ${error.message}`);
    }

    const weeklyLines = weeklyRows.length > 0
        ? weeklyRows.map((player, index) => {
            return leaderboardLine(index, player, player.weekly_direct_recruits_count, 'weekly direct recruits');
        }).join('\n')
        : 'No weekly recruits yet. The ice is quiet... for now. 🧊';
    const previousLines = previousTopThree.length > 0
        ? previousTopThree.map((player, index) => {
            return leaderboardLine(index, player, player.recruit_count, 'weekly direct recruits');
        }).join('\n')
        : 'No previous weekly results have been saved yet.';

    return updateLeaderboardChannel(
        guild,
        WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_ID,
        WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_NAME,
        'Penguin Mafia Weekly Recruit Leaderboard',
        `🏆🐧 **Penguin Mafia Weekly Recruit Leaderboard** 🐧🏆\n\n` +
        `Top 10 penguins by **direct recruits this week**.\n` +
        `The Don resets this board with \`/reset resetweeklyrecruits\`.\n\n` +
        `## Current Week\n${weeklyLines}\n\n` +
        `## Previous Week Top 3\n${previousLines}\n\n`
    );
}

async function resetWeeklyRecruitsAndSaveTopThree(sql) {
    return sql.begin(async transaction => {
        const topThree = await transaction`
            select
                discord_id,
                discord_username,
                discord_display_name,
                minecraft_ign,
                weekly_direct_recruits_count::int as recruit_count
            from players
            where weekly_direct_recruits_count > 0
            order by weekly_direct_recruits_count desc, discord_display_name asc
            limit 3
        `;

        await transaction`
            insert into bot_state (
                key,
                value
            )
            values (
                ${PREVIOUS_WEEKLY_RECRUITS_STATE_KEY},
                ${JSON.stringify(topThree)}
            )
            on conflict (key) do update
            set
                value = excluded.value,
                updated_at = now()
        `;

        await transaction`
            update players
            set
                weekly_direct_recruits_count = 0,
                updated_at = now()
        `;

        return topThree;
    });
}

async function updateDonationLeaderboardForGuild(guild, sql) {
    const donationRows = await sql`
        select
            discord_username,
            discord_display_name,
            minecraft_ign,
            donations
        from players
        where donations > 0
        order by donations desc, discord_display_name asc
        limit 10
    `;

    const donationLines = donationRows.length > 0
        ? donationRows.map((player, index) => {
            return leaderboardLine(index, player, formatDonationAmount(player.donations), 'donated');
        }).join('\n')
        : 'No donations recorded yet. The treasure vault awaits. 💎';

    return updateLeaderboardChannel(
        guild,
        DONATIONS_LEADERBOARD_CHANNEL_ID,
        DONATIONS_LEADERBOARD_CHANNEL_NAME,
        'Penguin Mafia Top Donators',
        `💎🐧 **Penguin Mafia Top Donators** 🐧💎\n\n` +
        `Top 10 penguins by **all-time donations**.\n\n` +
        `${donationLines}\n\n` 
    );
}

async function updateHourlyRecruitsLeaderboardForGuild(guild, sql) {
    const currentHourRows = await sql`
        select
            history.recruiter_discord_id as discord_id,
            recruiter.discord_username,
            recruiter.discord_display_name,
            recruiter.minecraft_ign,
            count(*)::int as recruit_count
        from recruit_history history
        left join players recruiter
            on recruiter.discord_id = history.recruiter_discord_id
        where history.recruited_at >= date_trunc('hour', now())
            and history.recruited_at < date_trunc('hour', now()) + interval '1 hour'
            and history.counts_for_hourly = true
        group by
            history.recruiter_discord_id,
            recruiter.discord_username,
            recruiter.discord_display_name,
            recruiter.minecraft_ign
        order by recruit_count desc, recruiter.discord_display_name asc nulls last
        limit 10
    `;
    const previousHourWinners = await sql`
        with recruiter_totals as (
            select
                history.recruiter_discord_id as discord_id,
                recruiter.discord_username,
                recruiter.discord_display_name,
                recruiter.minecraft_ign,
                count(*)::int as recruit_count
            from recruit_history history
            left join players recruiter
                on recruiter.discord_id = history.recruiter_discord_id
            where history.recruited_at >= date_trunc('hour', now()) - interval '1 hour'
                and history.recruited_at < date_trunc('hour', now())
                and history.counts_for_hourly = true
            group by
                history.recruiter_discord_id,
                recruiter.discord_username,
                recruiter.discord_display_name,
                recruiter.minecraft_ign
        )
        select *
        from recruiter_totals
        where recruit_count = (
            select max(recruit_count)
            from recruiter_totals
        )
        order by discord_display_name asc nulls last
    `;
    const previousTopCount = previousHourWinners[0]?.recruit_count || 0;
    const winnerLine = previousHourWinners.length === 0
        ? 'No one had a recruit last hour.'
        : previousHourWinners.length === 1
            ? `🏆 **Last Hour’s Winner:** **${leaderboardName(previousHourWinners[0])}** with **${previousTopCount}** recruit${previousTopCount === 1 ? '' : 's'}`
            : `🏆 **Last Hour’s Winners:** ${previousHourWinners.map(player => `**${leaderboardName(player)}**`).join(', ')} with **${previousTopCount}** recruits each`;
    const currentHourLines = currentHourRows.length > 0
        ? currentHourRows.map((player, index) => {
            return leaderboardLine(
                index,
                player,
                player.recruit_count,
                'hourly direct recruits'
            );
        }).join('\n')
        : 'No one has a recruit this hour yet.';

    return updateLeaderboardChannel(
        guild,
        HOURLY_RECRUITS_LEADERBOARD_CHANNEL_ID,
        'hourly-recruits',
        'Penguin Mafia Hourly Recruit Leaderboard',
        `🏆🐧 **Penguin Mafia Hourly Recruit Leaderboard** 🐧🏆\n\n` +
        `## This Hour’s Top Recruiters\n${currentHourLines}\n\n` +
        `## Last Hour’s Result\n${winnerLine}\n\n`
    );
}

async function updateLeaderboardsForGuild(guild, sql) {
    await updateWeeklyRecruitsLeaderboardForGuild(guild, sql);
    await updateDonationLeaderboardForGuild(guild, sql);
    await updateHourlyRecruitsLeaderboardForGuild(guild, sql);
}

module.exports = {
    resetWeeklyRecruitsAndSaveTopThree,
    updateDonationLeaderboardForGuild,
    updateHourlyRecruitsLeaderboardForGuild,
    updateWeeklyRecruitsLeaderboardForGuild,
    updateLeaderboardsForGuild
};
