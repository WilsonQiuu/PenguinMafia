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
    const hourlyRows = await sql`
        with period as (
            select
                date_trunc('hour', now()) - interval '1 hour' as period_start,
                date_trunc('hour', now()) as period_end
        )
        select
            history.recruiter_discord_id as discord_id,
            recruiter.discord_username,
            recruiter.discord_display_name,
            recruiter.minecraft_ign,
            count(*)::int as recruit_count,
            period.period_start,
            period.period_end
        from recruit_history history
        cross join period
        left join players recruiter
            on recruiter.discord_id = history.recruiter_discord_id
        where history.recruited_at >= period.period_start
            and history.recruited_at < period.period_end
            and history.counts_for_hourly = true
        group by
            history.recruiter_discord_id,
            recruiter.discord_username,
            recruiter.discord_display_name,
            recruiter.minecraft_ign,
            period.period_start,
            period.period_end
        order by recruit_count desc, recruiter.discord_display_name asc nulls last
        limit 10
    `;
    const periodRows = await sql`
        select
            date_trunc('hour', now()) - interval '1 hour' as period_start,
            date_trunc('hour', now()) as period_end
    `;
    const period = hourlyRows[0] || periodRows[0];
    const periodStart = Math.floor(new Date(period.period_start).getTime() / 1000);
    const periodEnd = Math.floor(new Date(period.period_end).getTime() / 1000);
    const topCount = hourlyRows[0]?.recruit_count || 0;
    const topRecruiters = hourlyRows.filter(player => player.recruit_count === topCount);
    const winnerLine = topRecruiters.length === 0
        ? 'No one had a recruit last hour.'
        : topRecruiters.length === 1
            ? `🏆 **Previous Hour Winner:** **${leaderboardName(topRecruiters[0])}** with **${topCount}** recruit${topCount === 1 ? '' : 's'}`
            : `🏆 **Previous Hour Winners:** ${topRecruiters.map(player => `**${leaderboardName(player)}**`).join(', ')} with **${topCount}** recruits each`;
    const hourlyLines = hourlyRows.length > 0
        ? hourlyRows.map((player, index) => {
            return leaderboardLine(
                index,
                player,
                player.recruit_count,
                'hourly direct recruits'
            );
        }).join('\n')
        : 'The ice was quiet during this hour. 🧊';

    return updateLeaderboardChannel(
        guild,
        HOURLY_RECRUITS_LEADERBOARD_CHANNEL_ID,
        'hourly-recruits',
        'Penguin Mafia Hourly Recruit Leaderboard',
        `🏆🐧 **Penguin Mafia Hourly Recruit Leaderboard** 🐧🏆\n\n` +
        `Top 10 penguins by **direct recruits during the last completed hour**.\n` +
        `Hour: <t:${periodStart}:t>–<t:${periodEnd}:t>\n` +
        `Leaves and rejoins do not count as new recruits.\n\n` +
        `${winnerLine}\n\n` +
        `${hourlyLines}\n\n`
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
