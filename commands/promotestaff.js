const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    postStaffPromotionEvent
} = require('../utils/events.js');
const {
    STAFF_RANKS,
    ensureStaffRoles,
    syncMemberStaffRankFromRoles
} = require('../utils/bootstrap.js');
const {
    getStaffProfile,
    isDon,
    syncInvokerStaffRank
} = require('../utils/staff.js');
const {
    startTrialModOnboardingForMember
} = require('../utils/trialModOnboarding.js');

const STAFF_RANK_NAMES = STAFF_RANKS.map(rank => rank.name);

function playerName(player, fallback = 'Unknown Player') {
    return player?.discord_display_name ||
        player?.discord_username ||
        fallback;
}

function getNextStaffRank(currentStaffRankName) {
    if (!currentStaffRankName) {
        return STAFF_RANK_NAMES[0];
    }

    const currentIndex = STAFF_RANK_NAMES.indexOf(currentStaffRankName);

    if (currentIndex === -1 || currentIndex >= STAFF_RANK_NAMES.length - 1) {
        return null;
    }

    return STAFF_RANK_NAMES[currentIndex + 1];
}

function getTargetStaffRank(currentStaffRankName, requestedStaffRankName) {
    return requestedStaffRankName || getNextStaffRank(currentStaffRankName);
}

function getStaffRankIndex(staffRankName) {
    return STAFF_RANK_NAMES.indexOf(staffRankName);
}

function maxPromotableStaffRank(actorStaffRankName) {
    if (actorStaffRankName === 'Sr Moderator') {
        return 'Moderator';
    }

    if (actorStaffRankName === 'Admin') {
        return 'Sr Moderator';
    }

    return null;
}

async function syncMemberStaffRole(member, staffRoles, staffRankName) {
    const targetRole = staffRoles.get(staffRankName);
    const rolesToRemove = [...staffRoles.values()].filter(role => {
        return role.id !== targetRole?.id && member.roles.cache.has(role.id);
    });

    if (rolesToRemove.length > 0) {
        await member.roles.remove(rolesToRemove, 'Penguin Mafia Staff promotion');
    }

    if (targetRole && !member.roles.cache.has(targetRole.id)) {
        await member.roles.add(targetRole, 'Penguin Mafia Staff promotion');
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('staffpromote')
        .setDescription('Promote a player to the next Staff rank.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player to promote to the next Staff rank')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('rank')
                .setDescription('Optional target Staff rank')
                .setRequired(false)
                .addChoices(
                    { name: 'Trial Mod', value: 'Trial Mod' },
                    { name: 'Moderator', value: 'Moderator' },
                    { name: 'Sr Moderator', value: 'Sr Moderator' },
                    { name: 'Admin', value: 'Admin' }
                )
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

        const playerUser = interaction.options.getUser('player');
        const requestedStaffRank = interaction.options.getString('rank');
        const actorIsDon = isDon(interaction.user.id);

        if (playerUser.bot) {
            await interaction.editReply(
                '❌ Bots cannot be promoted to Staff.'
            );
            return;
        }

        try {
            if (!actorIsDon && playerUser.id === interaction.user.id) {
                await interaction.editReply(
                    '❌ You cannot promote yourself to Staff.'
                );
                return;
            }

            let actorMaxStaffRank = null;
            let actorStaffRank = null;

            if (!actorIsDon) {
                await syncInvokerStaffRank(sql, interaction.member);
                const actorStaff = await getStaffProfile(sql, interaction.user.id);
                actorStaffRank = actorStaff?.staff_rank_name;
                actorMaxStaffRank = maxPromotableStaffRank(actorStaffRank);

                if (!actorMaxStaffRank) {
                    await interaction.editReply(
                        '❌ You need Sr Moderator or higher to use `/staffpromote`.'
                    );
                    return;
                }
            }

            const member = await interaction.guild.members.fetch(playerUser.id).catch(() => null);

            if (!member) {
                await interaction.editReply(
                    `❌ ${playerUser} is not currently in this server.`
                );
                return;
            }

            const { staffRoles } = await ensureStaffRoles(interaction.guild);
            await syncMemberStaffRankFromRoles(sql, member, staffRoles);

            const playerRows = await sql`
                select
                    player.discord_id,
                    player.discord_username,
                    player.discord_display_name,
                    player.staff_rank_name,
                    player.ban_points_remaining
                from players player
                where player.discord_id = ${playerUser.id}
                limit 1
            `;

            if (playerRows.length === 0) {
                await interaction.editReply(
                    `❌ ${playerUser} is not in the database yet. Run \`/setup\` first.`
                );
                return;
            }

            const player = playerRows[0];
            const nextStaffRank = getTargetStaffRank(player.staff_rank_name, requestedStaffRank);

            if (!nextStaffRank) {
                await interaction.editReply(
                    `❌ ${playerUser} is already at the highest Staff rank: \`${player.staff_rank_name}\`.`
                );
                return;
            }

            const currentStaffRankIndex = player.staff_rank_name
                ? getStaffRankIndex(player.staff_rank_name)
                : -1;
            const nextRankIndex = getStaffRankIndex(nextStaffRank);

            if (nextRankIndex === -1) {
                await interaction.editReply(
                    `❌ Unknown target Staff rank: \`${nextStaffRank}\`.`
                );
                return;
            }

            if (nextRankIndex <= currentStaffRankIndex) {
                await interaction.editReply(
                    `❌ Target Staff rank \`${nextStaffRank}\` must be higher than current Staff rank \`${player.staff_rank_name || 'None'}\`.`
                );
                return;
            }

            if (!actorIsDon) {
                const actorRankIndex = getStaffRankIndex(actorStaffRank);
                const maxRankIndex = getStaffRankIndex(actorMaxStaffRank);

                if (actorRankIndex === -1 || nextRankIndex >= actorRankIndex) {
                    await interaction.editReply(
                        `❌ Target Staff rank \`${nextStaffRank}\` must be below your Staff rank \`${actorStaffRank}\`.`
                    );
                    return;
                }

                if (maxRankIndex === -1 || nextRankIndex > maxRankIndex) {
                    await interaction.editReply(
                        `❌ You can only promote Staff up to \`${actorMaxStaffRank}\`.`
                    );
                    return;
                }
            }

            const updatedRows = await sql`
                update players player
                set
                    staff_rank_name = ${nextStaffRank},
                    ban_points_remaining = staff.ban_point_limit,
                    updated_at = now()
                from staff_ranks staff
                where player.discord_id = ${playerUser.id}
                    and staff.name = ${nextStaffRank}
                returning
                    player.discord_username,
                    player.discord_display_name,
                    player.staff_rank_name,
                    player.ban_points_remaining
            `;

            const updatedPlayer = updatedRows[0];
            await syncMemberStaffRole(member, staffRoles, nextStaffRank);

            let trialModOnboardingStarted = false;

            if (nextStaffRank === 'Trial Mod') {
                await startTrialModOnboardingForMember(member);
                trialModOnboardingStarted = true;
            }

            await interaction.editReply(
                `✅ **Staff promotion complete.**\n\n` +
                `Player: **${playerName(updatedPlayer, playerUser.username)}** ${playerUser}\n` +
                `Old Staff rank: \`${player.staff_rank_name || 'None'}\`\n` +
                `New Staff rank: \`${updatedPlayer.staff_rank_name}\`\n` +
                `Ban points: **${updatedPlayer.ban_points_remaining}**` +
                (trialModOnboardingStarted ? `\nTrial Mod onboarding: **started**` : '')
            );

            const eventPosted = await postStaffPromotionEvent(interaction.guild, {
                playerId: playerUser.id,
                promoterId: interaction.user.id,
                oldRank: player.staff_rank_name,
                newRank: updatedPlayer.staff_rank_name
            }).catch(error => {
                console.error('Promotion event channel post failed after /staffpromote:');
                console.error(error);
                return false;
            });

            if (!eventPosted) {
                await interaction.followUp({
                    content: '⚠️ Staff promotion succeeded, but I could not post it in the configured promotion events channel. Check the channel ID.',
                    flags: MessageFlags.Ephemeral
                });
            }
        } catch (error) {
            logCommandError(interaction, '/staffpromote', error);

            await interaction.editReply(
                `❌ **Staff promotion failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
