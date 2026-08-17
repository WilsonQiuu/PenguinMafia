const {
    MessageFlags,
    SlashCommandBuilder
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    confirmAction,
    ensureActorInDatabase,
    getTrustProfile,
    logTrustCommand,
    playerName,
    requireAdminTrustAccess,
    syncIcebergPenguinRole,
    icebergRoleLine,
    trustSummary
} = require('../utils/trust.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unveto')
        .setDescription('Remove your Admin veto from a player.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player whose Admin veto should be removed')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const targetUser = interaction.options.getUser('player');

        if (targetUser.bot) {
            await interaction.editReply('❌ Bots do not have Admin vetoes.');
            return;
        }

        try {
            const access = await requireAdminTrustAccess(sql, interaction, '/unveto');
            await ensureActorInDatabase(sql, interaction.user.id);

            const target = await getTrustProfile(sql, targetUser.id);

            if (!target) {
                await interaction.editReply(
                    `❌ ${targetUser} is not in the database yet.`
                );
                return;
            }

            const existingRows = await sql`
                select created_at
                from player_admin_vetoes
                where target_discord_id = ${targetUser.id}
                    and admin_discord_id = ${interaction.user.id}
                limit 1
            `;

            if (existingRows.length === 0) {
                await interaction.editReply(
                    `ℹ️ You have not Admin-vetoed **${playerName(target, targetUser.username)}** ${targetUser}.\n\n` +
                    trustSummary(target)
                );
                return;
            }

            const confirmation = await confirmAction(interaction, {
                customIdPrefix: 'unveto',
                confirmLabel: 'Remove Admin Veto',
                content:
                    `⚠️ **Confirm Remove Admin Veto**\n\n` +
                    `Player: **${playerName(target, targetUser.username)}** ${targetUser}\n` +
                    `${trustSummary(target)}\n\n` +
                    `If this removes the last veto and they have enough Admin vouches, Iceberg Penguin may be granted.`,
                confirmedContent: '⏳ Removing Admin veto and updating Iceberg Penguin...',
                cancelContent: '❌ Remove Admin veto cancelled.',
                expiredContent: '⏰ Remove Admin veto confirmation expired.'
            });

            if (!confirmation.confirmed) {
                return;
            }

            const result = await sql.begin(async tx => {
                const deletedRows = await tx`
                    delete from player_admin_vetoes
                    where target_discord_id = ${targetUser.id}
                        and admin_discord_id = ${interaction.user.id}
                    returning target_discord_id
                `;

                if (deletedRows.length === 0) {
                    return {
                        removed: false,
                        player: await getTrustProfile(tx, targetUser.id)
                    };
                }

                const updatedRows = await tx`
                    update players
                    set
                        admin_vetoes = greatest(admin_vetoes - 1, 0),
                        vetoes = greatest(vetoes - 1, 0),
                        updated_at = now()
                    where discord_id = ${targetUser.id}
                    returning
                        discord_id,
                        discord_username,
                        discord_display_name,
                        vouches,
                        admin_vouches,
                        vetoes,
                        admin_vetoes
                `;

                return {
                    removed: true,
                    player: updatedRows[0]
                };
            });

            const roleResult = result.removed
                ? await syncIcebergPenguinRole(
                    interaction.guild,
                    result.player,
                    'Penguin Mafia Admin veto removed'
                ).catch(error => ({
                    status: 'failed',
                    error
                }))
                : null;
            const roleLine = roleResult?.status === 'failed'
                ? `\n⚠️ Admin veto was removed, but I could not update Iceberg Penguin: \`${roleResult.error.message}\``
                : icebergRoleLine(roleResult);

            await logTrustCommand(interaction, 'Admin Veto Removed', '/unveto', [
                {
                    name: 'Player',
                    value: `${targetUser.tag || targetUser.username} (${targetUser.id})`
                },
                {
                    name: 'Actor Staff Rank',
                    value: access.staffRankName
                },
                {
                    name: 'Admin Vetoes',
                    value: String(result.player.admin_vetoes)
                },
                {
                    name: 'Iceberg Penguin Role',
                    value: roleResult?.status || 'Not checked'
                }
            ]);

            await interaction.editReply(
                `✅ **Admin veto removed.**\n\n` +
                `Player: **${playerName(result.player, targetUser.username)}** ${targetUser}\n` +
                `${trustSummary(result.player)}${roleLine}`
            );
        } catch (error) {
            logCommandError(interaction, '/unveto', error);

            await logTrustCommand(interaction, 'Admin Veto Remove Failed', '/unveto', [
                {
                    name: 'Player',
                    value: `${targetUser.tag || targetUser.username} (${targetUser.id})`
                },
                {
                    name: 'Error',
                    value: error.message
                }
            ]);

            await interaction.editReply({
                content:
                    `❌ **Remove Admin veto failed.**\n\n` +
                    `Error:\n\`\`\`\n${error.message}\n\`\`\``,
                components: []
            });
        }
    }
};
