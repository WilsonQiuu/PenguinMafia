const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    postBranchMilestoneEvents
} = require('../utils/events.js');
const {
    scheduleElectionLeaderboardUpdate
} = require('../utils/elections.js');
const {
    getRankIndex,
    getPreviousRank,
    playerName,
    syncRankRole
} = require('../utils/ranks.js');
const {
    isDon
} = require('../utils/staff.js');

async function moveHigherRecruitsUpAfterDemotion(sql, playerDiscordId, demotedRank) {
    const demotedRankIndex = getRankIndex(demotedRank);

    if (demotedRankIndex === undefined) {
        return [];
    }

    const playerRows = await sql`
        select
            discord_id,
            parent_discord_id
        from players
        where discord_id = ${playerDiscordId}
        for update
    `;

    const player = playerRows[0];

    if (!player) {
        return [];
    }

    const directRecruits = await sql`
        select
            discord_id,
            discord_username,
            discord_display_name,
            minecraft_ign,
            rank_name
        from players
        where parent_discord_id = ${playerDiscordId}
        for update
    `;

    const higherRecruits = directRecruits.filter(recruit => {
        const recruitRankIndex = getRankIndex(recruit.rank_name);
        return recruitRankIndex !== undefined && recruitRankIndex > demotedRankIndex;
    });

    if (higherRecruits.length === 0) {
        return [];
    }

    await sql`
        update players
        set
            parent_discord_id = ${player.parent_discord_id},
            status = case
                when ${player.parent_discord_id}::text is null then 'orphan'
                else 'active'
            end,
            updated_at = now()
        where discord_id in ${sql(higherRecruits.map(recruit => recruit.discord_id))}
    `;

    return higherRecruits.map(recruit => ({
        ...recruit,
        parent_discord_id: player.parent_discord_id
    }));
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('demote')
        .setDescription('Demote a player to the previous rank. Don only.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player to demote')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const donDiscordId = process.env.DON_DISCORD_ID;

        if (!donDiscordId) {
            await interaction.editReply(
                '❌ DON_DISCORD_ID is missing from your `.env` file.'
            );
            return;
        }

        if (!isDon(interaction.user.id)) {
            await interaction.editReply(
                '❌ Only the Don can use this command.'
            );
            return;
        }

        const playerUser = interaction.options.getUser('player');

        try {
            const playerRows = await sql`
                select
                    discord_id,
                    discord_username,
                    discord_display_name,
                    parent_discord_id,
                    rank_name
                from players
                where discord_id = ${playerUser.id}
                limit 1
            `;

            if (playerRows.length === 0) {
                await interaction.editReply(
                    `${playerUser} is not in the database yet.`
                );
                return;
            }

            const player = playerRows[0];
            const previousRank = getPreviousRank(player.rank_name);

            if (!previousRank) {
                await interaction.editReply(
                    `❌ ${playerUser} is already at the lowest rank: \`${player.rank_name}\`.`
                );
                return;
            }

            const falls = await sql.begin(async sql => {
                await sql`
                    update players
                    set
                        rank_name = ${previousRank},
                        updated_at = now()
                    where discord_id = ${playerUser.id}
                `;

                return moveHigherRecruitsUpAfterDemotion(sql, playerUser.id, previousRank);
            });

            const syncedRole = await syncRankRole(interaction.guild, playerUser.id, previousRank);
            const fallLine = falls.length > 0
                ? `Recruits moved up: **${falls.length}** (${falls.map(fall => playerName(fall)).join(', ')})\n`
                : `Recruits moved up: **0**\n`;

            await interaction.editReply(
                `✅ **Player demoted.**\n\n` +
                `Player: **${playerName(player, playerUser.username)}** ${playerUser}\n` +
                `Old role: \`${player.rank_name}\`\n` +
                `New role: \`${previousRank}\`\n` +
                fallLine +
                `Discord role synced: **${syncedRole ? 'yes' : 'no'}**`
            );

            const milestoneRecruiterIds = new Set([
                player.parent_discord_id,
                ...falls.map(fall => fall.parent_discord_id)
            ].filter(Boolean));

            for (const recruiterId of milestoneRecruiterIds) {
                await postBranchMilestoneEvents(interaction.guild, sql, recruiterId).catch(error => {
                    console.error('Branch milestone event failed after /demote:');
                    console.error(error);
                    return [];
                });
            }

            scheduleElectionLeaderboardUpdate(interaction.guild, sql);
        } catch (error) {
            logCommandError(interaction, '/demote', error);

            await interaction.editReply(
                `❌ **Demote command failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
