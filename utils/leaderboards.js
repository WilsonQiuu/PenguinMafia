const {
    DONATIONS_LEADERBOARD_CHANNEL_ID,
    DONATIONS_LEADERBOARD_CHANNEL_NAME,
    WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_ID,
    WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_NAME
} = require('./bootstrap.js');
const {
    formatDonationAmount
} = require('./donations.js');

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
        await existingMessage.edit(content);
    } else {
        await channel.send(content);
    }

    for (const duplicateMessage of matchingMessages.filter(message => message.id !== existingMessage?.id)) {
        await duplicateMessage.delete().catch(() => null);
    }

    return true;
}

async function updateWeeklyRecruitsLeaderboardForGuild(guild, sql) {
    const weeklyRows = await sql`
        select
            discord_username,
            discord_display_name,
            minecraft_ign,
            weekly_direct_recruits_count
        from players
        where weekly_direct_recruits_count > 0
        order by weekly_direct_recruits_count desc, discord_display_name asc
        limit 10
    `;

    const weeklyLines = weeklyRows.length > 0
        ? weeklyRows.map((player, index) => {
            return leaderboardLine(index, player, player.weekly_direct_recruits_count, 'weekly direct recruits');
        }).join('\n')
        : 'No weekly recruits yet. The ice is quiet... for now. 🧊';

    return updateLeaderboardChannel(
        guild,
        WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_ID,
        WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_NAME,
        'Penguin Mafia Weekly Recruit Leaderboard',
        `🏆🐧 **Penguin Mafia Weekly Recruit Leaderboard** 🐧🏆\n\n` +
        `Top 10 penguins by **direct recruits this week**.\n` +
        `The Don resets this board with \`/reset resetweeklyrecruits\`.\n\n` +
        `${weeklyLines}\n\n` 
    );
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

async function updateLeaderboardsForGuild(guild, sql) {
    await updateWeeklyRecruitsLeaderboardForGuild(guild, sql);
    await updateDonationLeaderboardForGuild(guild, sql);
}

module.exports = {
    updateDonationLeaderboardForGuild,
    updateWeeklyRecruitsLeaderboardForGuild,
    updateLeaderboardsForGuild
};
