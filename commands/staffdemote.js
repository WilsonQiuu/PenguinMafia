const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
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
    removeAdminVouchesByAdmin,
    syncIcebergPenguinRole
} = require('../utils/trust.js');

const STAFF_RANK_NAMES = STAFF_RANKS.map(rank => rank.name);

function playerName(player, fallback = 'Unknown Player') {
    return player?.discord_display_name ||
        player?.discord_username ||
        fallback;
}

function getStaffRankIndex(staffRankName) {
    return STAFF_RANK_NAMES.indexOf(staffRankName);
}

function getPreviousStaffRank(currentStaffRankName) {
    const currentIndex = getStaffRankIndex(currentStaffRankName);

    if (currentIndex === -1) {
        return null;
    }

    if (currentIndex === 0) {
        return null;
    }

    return STAFF_RANK_NAMES[currentIndex - 1];
}

function maxManageableStaffRank(actorStaffRankName) {
    if (actorStaffRankName === 'Sr Moderator') {
        return 'Moderator';
    }

    if (actorStaffRankName === 'Admin') {
        return 'Sr Moderator';
    }

    return null;
}

async function syncMemberStaffRole(member, staffRoles, staffRankName) {
    const targetRole = staffRankName ? staffRoles.get(staffRankName) : null;
    const rolesToRemove = [...staffRoles.values()].filter(role => {
        return role.id !== targetRole?.id && member.roles.cache.has(role.id);
    });

    if (rolesToRemove.length > 0) {
        await member.roles.remove(rolesToRemove, 'Penguin Mafia Staff demotion');
    }

    if (targetRole && !member.roles.cache.has(targetRole.id)) {
        await member.roles.add(targetRole, 'Penguin Mafia Staff demotion');
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('staffdemote')
        .setDescription('Demote a player to the previous Staff rank.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The Staff member to demote')
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

        const playerUser = interaction.options.getUser('player');
        const actorIsDon = isDon(interaction.user.id);

        if (playerUser.bot) {
            await interaction.editReply(
                '❌ Bots cannot hold Staff rank.'
            );
            return;
        }

        try {
            if (!actorIsDon && playerUser.id === interaction.user.id) {
                await interaction.editReply(
                    '❌ You cannot demote yourself from Staff.'
                );
                return;
            }

            let actorMaxStaffRank = null;
            let actorStaffRank = null;

            if (!actorIsDon) {
                await syncInvokerStaffRank(sql, interaction.member);
                const actorStaff = await getStaffProfile(sql, interaction.user.id);
                actorStaffRank = actorStaff?.staff_rank_name;
                actorMaxStaffRank = maxManageableStaffRank(actorStaffRank);

                if (!actorMaxStaffRank) {
                    await interaction.editReply(
                        '❌ You need Sr Moderator or higher to use `/staffdemote`.'
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
                    player.staff_rank_name
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

            if (!player.staff_rank_name) {
                await interaction.editReply(
                    `❌ ${playerUser} does not have a Staff rank.`
                );
                return;
            }

            const currentRankIndex = getStaffRankIndex(player.staff_rank_name);

            if (!actorIsDon) {
                const actorRankIndex = getStaffRankIndex(actorStaffRank);
                const maxRankIndex = getStaffRankIndex(actorMaxStaffRank);

                if (actorRankIndex === -1 || currentRankIndex >= actorRankIndex) {
                    await interaction.editReply(
                        `❌ You can only demote Staff below your Staff rank \`${actorStaffRank}\`.`
                    );
                    return;
                }

                if (currentRankIndex === -1 || maxRankIndex === -1 || currentRankIndex > maxRankIndex) {
                    await interaction.editReply(
                        `❌ You can only demote Staff at or below \`${actorMaxStaffRank}\`.`
                    );
                    return;
                }
            }

            const previousStaffRank = getPreviousStaffRank(player.staff_rank_name);
            const updatedRows = previousStaffRank
                ? await sql`
                    update players player
                    set
                        staff_rank_name = ${previousStaffRank},
                        ban_points_remaining = least(player.ban_points_remaining, staff.ban_point_limit),
                        updated_at = now()
                    from staff_ranks staff
                    where player.discord_id = ${playerUser.id}
                        and staff.name = ${previousStaffRank}
                    returning
                        player.discord_username,
                        player.discord_display_name,
                        player.staff_rank_name,
                        player.ban_points_remaining
                `
                : await sql`
                    update players
                    set
                        staff_rank_name = null,
                        ban_points_remaining = 0,
                        updated_at = now()
                    where discord_id = ${playerUser.id}
                    returning
                        discord_username,
                        discord_display_name,
                        staff_rank_name,
                        ban_points_remaining
                `;

            const updatedPlayer = updatedRows[0];
            await syncMemberStaffRole(member, staffRoles, previousStaffRank);

            let removedAdminVouchRows = [];
            let trustRoleSyncFailures = 0;

            if (player.staff_rank_name === 'Admin' && previousStaffRank !== 'Admin') {
                removedAdminVouchRows = await removeAdminVouchesByAdmin(sql, playerUser.id);

                for (const trustProfile of removedAdminVouchRows) {
                    await syncIcebergPenguinRole(
                        interaction.guild,
                        trustProfile,
                        'Penguin Mafia Admin demoted; Admin vouches removed'
                    ).catch(error => {
                        trustRoleSyncFailures += 1;
                        console.error('Iceberg Penguin role sync failed after Admin demotion vouch removal:');
                        console.error(error);
                    });
                }
            }

            const removedAdminVouches = removedAdminVouchRows.reduce((total, row) => {
                return total + Number(row.removed_count || 0);
            }, 0);

            await interaction.editReply(
                `✅ **Staff demotion complete.**\n\n` +
                `Player: **${playerName(updatedPlayer, playerUser.username)}** ${playerUser}\n` +
                `Old Staff rank: \`${player.staff_rank_name}\`\n` +
                `New Staff rank: \`${updatedPlayer.staff_rank_name || 'None'}\`\n` +
                `Ban points: **${updatedPlayer.ban_points_remaining}**` +
                (player.staff_rank_name === 'Admin'
                    ? `\nAdmin vouches removed: **${removedAdminVouches}**` +
                    (trustRoleSyncFailures > 0
                        ? `\nIceberg Penguin role sync failures: **${trustRoleSyncFailures}**`
                        : '')
                    : '')
            );
        } catch (error) {
            logCommandError(interaction, '/staffdemote', error);

            await interaction.editReply(
                `❌ **Staff demotion failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
