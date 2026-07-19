const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    postBranchMilestoneEvents,
    postPromotionEvent
} = require('../utils/events.js');
const {
    scheduleElectionLeaderboardUpdate
} = require('../utils/elections.js');
const {
    RANK_NAMES,
    evaluateEligibility,
    getNextRank,
    getRankIndex,
    playerName,
    syncRankRole
} = require('../utils/ranks.js');
const {
    isDon: hasDonAccess
} = require('../utils/staff.js');

async function getDirectChildren(playerDiscordId, db = sql) {
    return db`
        select
            discord_id,
            discord_username,
            discord_display_name,
            rank_name
        from players
        where parent_discord_id = ${playerDiscordId}
        order by discord_display_name asc
    `;
}

function promotionAuthorityError(actorRank, playerRank, targetRank) {
    const actorIndex = getRankIndex(actorRank);
    const playerIndex = getRankIndex(playerRank);
    const targetIndex = getRankIndex(targetRank);
    const finalIndex = RANK_NAMES.length - 1;

    if (actorIndex === undefined || playerIndex === undefined || targetIndex === undefined) {
        return 'Could not verify rank hierarchy.';
    }

    if (targetIndex <= playerIndex) {
        return `Target rank \`${targetRank}\` must be higher than current rank \`${playerRank}\`.`;
    }

    if (targetIndex === finalIndex && actorIndex === finalIndex) {
        return null;
    }

    if (actorIndex < playerIndex + 2) {
        return `Your role \`${actorRank}\` is not high enough above \`${playerRank}\` to promote this player.`;
    }

    if (targetIndex >= actorIndex) {
        return `Target rank \`${targetRank}\` must be below your role \`${actorRank}\`.`;
    }

    return null;
}

async function jumpRecruitersAfterPromotion(sql, playerDiscordId, promotedRank) {
    const promotedRankIndex = getRankIndex(promotedRank);
    const jumps = [];

    if (promotedRankIndex === undefined) {
        return jumps;
    }

    while (true) {
        const rows = await sql`
            select
                player.discord_id,
                player.parent_discord_id as recruiter_discord_id,
                recruiter.discord_username as recruiter_username,
                recruiter.discord_display_name as recruiter_display_name,
                recruiter.minecraft_ign as recruiter_minecraft_ign,
                recruiter.rank_name as recruiter_rank_name,
                recruiter.parent_discord_id as grand_recruiter_discord_id
            from players player
            left join players recruiter
                on player.parent_discord_id = recruiter.discord_id
            where player.discord_id = ${playerDiscordId}
            for update of player
        `;

        const row = rows[0];

        if (!row?.recruiter_discord_id) {
            break;
        }

        const recruiterRankIndex = getRankIndex(row.recruiter_rank_name);

        if (recruiterRankIndex === undefined || promotedRankIndex <= recruiterRankIndex) {
            break;
        }

        await sql`
            select discord_id
            from players
            where discord_id = ${row.recruiter_discord_id}
            for update
        `;

        await sql`
            update players
            set
                parent_discord_id = ${row.grand_recruiter_discord_id},
                status = case
                    when ${row.grand_recruiter_discord_id}::text is null then 'orphan'
                    else 'active'
                end,
                updated_at = now()
            where discord_id = ${playerDiscordId}
        `;

        jumps.push({
            discord_id: row.recruiter_discord_id,
            discord_username: row.recruiter_username,
            discord_display_name: row.recruiter_display_name,
            minecraft_ign: row.recruiter_minecraft_ign,
            rank_name: row.recruiter_rank_name
        });
    }

    return jumps;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('promote')
        .setDescription('Promote a player to the next rank.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player to promote')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('rank')
                .setDescription('Optional target Penguin rank')
                .setRequired(false)
                .addChoices(
                    { name: 'Penguin Captain', value: 'Penguin Captain' },
                    { name: 'Penguin General', value: 'Penguin General' },
                    { name: 'Emperor Penguin', value: 'Emperor Penguin' }
                )
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const donDiscordId = process.env.DON_DISCORD_ID;
        const playerUser = interaction.options.getUser('player');
        const requestedRank = interaction.options.getString('rank');
        const isDon = hasDonAccess(interaction.user.id);

        try {
            const playerRows = await sql`
                select
                    discord_id,
                    discord_username,
                    discord_display_name,
                    rank_name,
                    captain_direct_recruits_count
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
            const nextRank = requestedRank || getNextRank(player.rank_name);

            if (!nextRank) {
                await interaction.editReply(
                    `❌ ${playerUser} is already at the highest rank: \`${player.rank_name}\`.`
                );
                return;
            }

            const currentRankIndex = getRankIndex(player.rank_name);
            const targetRankIndex = getRankIndex(nextRank);

            if (targetRankIndex === undefined) {
                await interaction.editReply(
                    `❌ Unknown target rank: \`${nextRank}\`.`
                );
                return;
            }

            if (currentRankIndex !== undefined && targetRankIndex <= currentRankIndex) {
                await interaction.editReply(
                    `❌ Target rank \`${nextRank}\` must be higher than current rank \`${player.rank_name}\`.`
                );
                return;
            }

            const children = await getDirectChildren(playerUser.id);
            const eligibility = evaluateEligibility(children, nextRank, {
                captainDirectRecruitsCount: Number(player.captain_direct_recruits_count || 0)
            });

            if (!isDon) {
                const actorRows = await sql`
                    select
                        discord_id,
                        discord_username,
                        discord_display_name,
                        rank_name
                    from players
                    where discord_id = ${interaction.user.id}
                    limit 1
                `;

                if (actorRows.length === 0) {
                    await interaction.editReply(
                        '❌ You are not in the database yet.'
                    );
                    return;
                }

                const actor = actorRows[0];

                if (!eligibility.eligible) {
                    await interaction.editReply(
                        `❌ ${playerUser} is not eligible for \`${nextRank}\` yet.\n\n` +
                        eligibility.requirements.join('\n')
                    );
                    return;
                }

                const authorityError = promotionAuthorityError(actor.rank_name, player.rank_name, nextRank);

                if (authorityError) {
                    await interaction.editReply(
                        `❌ ${authorityError}`
                    );
                    return;
                }
            }

            const jumps = await sql.begin(async sql => {
                if (!isDon) {
                    const lockedRows = await sql`
                        select
                            player.rank_name as player_rank_name,
                            player.captain_direct_recruits_count,
                            actor.rank_name as actor_rank_name
                        from players player
                        cross join players actor
                        where player.discord_id = ${playerUser.id}
                            and actor.discord_id = ${interaction.user.id}
                        for update of player, actor
                    `;

                    if (lockedRows.length === 0) {
                        throw new Error('Could not re-check promotion authority.');
                    }

                    const locked = lockedRows[0];
                    const lockedChildren = await getDirectChildren(playerUser.id, sql);
                    const lockedEligibility = evaluateEligibility(lockedChildren, nextRank, {
                        captainDirectRecruitsCount: Number(locked.captain_direct_recruits_count || 0)
                    });

                    const recheckError = promotionAuthorityError(
                        locked.actor_rank_name,
                        locked.player_rank_name,
                        nextRank
                    );

                    if (recheckError) {
                        throw new Error(recheckError);
                    }

                    if (!lockedEligibility.eligible) {
                        throw new Error(
                            `${playerUser.username} is no longer eligible for ${nextRank}.\n\n` +
                            lockedEligibility.requirements.join('\n')
                        );
                    }
                }

                await sql`
                    update players
                    set
                        rank_name = ${nextRank},
                        reached_captain_at = case
                            when ${nextRank} = 'Penguin Captain' and ${player.rank_name} = 'Penguin Soldier'
                            then coalesce(reached_captain_at, now())
                            else reached_captain_at
                        end,
                        updated_at = now()
                    where discord_id = ${playerUser.id}
                `;

                return jumpRecruitersAfterPromotion(sql, playerUser.id, nextRank);
            });

            const syncedRole = await syncRankRole(interaction.guild, playerUser.id, nextRank);
            const currentRecruiterRows = await sql`
                select parent_discord_id
                from players
                where discord_id = ${playerUser.id}
                limit 1
            `;
            const jumpLine = jumps.length > 0
                ? `\nHierarchy jumps: **${jumps.length}** (${jumps.map(jump => playerName(jump)).join(', ')})\n`
                : '\nHierarchy jumps: **0**\n';

            await interaction.editReply(
                `✅ **Player promoted.**\n\n` +
                `Player: **${playerName(player, playerUser.username)}** ${playerUser}\n` +
                `Old role: \`${player.rank_name}\`\n` +
                `New role: \`${nextRank}\`\n` +
                `Eligible: **${eligibility.eligible ? 'yes' : 'no'}**\n` +
                jumpLine +
                `Discord role synced: **${syncedRole ? 'yes' : 'no'}**`
            );

            const eventPosted = await postPromotionEvent(interaction.guild, {
                playerId: playerUser.id,
                promoterId: interaction.user.id,
                recruiterId: currentRecruiterRows[0]?.parent_discord_id,
                oldRank: player.rank_name,
                newRank: nextRank
            }).catch(error => {
                console.error('Promotion event channel post failed after /promote:');
                console.error(error);
                return false;
            });

            if (!eventPosted) {
                await interaction.followUp({
                    content: '⚠️ Promotion succeeded, but I could not post it in the configured promotion events channel. Check the channel ID.',
                    flags: MessageFlags.Ephemeral
                });
            }

            await postBranchMilestoneEvents(interaction.guild, sql, currentRecruiterRows[0]?.parent_discord_id).catch(error => {
                console.error('Branch milestone event failed after /promote:');
                console.error(error);
                return [];
            });

            scheduleElectionLeaderboardUpdate(interaction.guild, sql);
        } catch (error) {
            logCommandError(interaction, '/promote', error);

            await interaction.editReply(
                `❌ **Promote command failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
