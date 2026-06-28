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
    requireVouchAccess,
    syncTrustedPenguinRole,
    trustedRoleLine,
    trustSummary
} = require('../utils/trust.js');

function vouchKind(access) {
    return access.type === 'admin' ? 'Admin vouch' : 'Trusted Penguin vouch';
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unvouche')
        .setDescription('Remove your vouch from a player.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player whose vouch should be removed')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const targetUser = interaction.options.getUser('player');

        if (targetUser.bot) {
            await interaction.editReply('❌ Bots do not have vouches.');
            return;
        }

        try {
            const access = await requireVouchAccess(sql, interaction);
            await ensureActorInDatabase(sql, interaction.user.id);

            const target = await getTrustProfile(sql, targetUser.id);

            if (!target) {
                await interaction.editReply(
                    `❌ ${targetUser} is not in the database yet.`
                );
                return;
            }

            const existingRows = access.type === 'admin'
                ? await sql`
                    select created_at
                    from player_admin_vouches
                    where target_discord_id = ${targetUser.id}
                        and admin_discord_id = ${interaction.user.id}
                    limit 1
                `
                : await sql`
                    select created_at
                    from player_vouches
                    where target_discord_id = ${targetUser.id}
                        and voucher_discord_id = ${interaction.user.id}
                    limit 1
                `;

            if (existingRows.length === 0) {
                await interaction.editReply(
                    `ℹ️ You have not given a ${vouchKind(access)} to **${playerName(target, targetUser.username)}** ${targetUser}.\n\n` +
                    trustSummary(target)
                );
                return;
            }

            const confirmation = await confirmAction(interaction, {
                customIdPrefix: 'unvouche',
                confirmLabel: `Remove ${vouchKind(access)}`,
                danger: access.type === 'admin',
                content:
                    `⚠️ **Confirm Remove ${vouchKind(access)}**\n\n` +
                    `Player: **${playerName(target, targetUser.username)}** ${targetUser}\n` +
                    `${trustSummary(target)}\n\n` +
                    (
                        access.type === 'admin'
                            ? 'This may remove Trusted Penguin if they fall below the required Admin vouches.'
                            : 'This removes your regular vouch only. Trusted Penguin status is not based on regular vouches.'
                    ),
                confirmedContent: '⏳ Removing vouch...',
                cancelContent: '❌ Remove vouch cancelled.',
                expiredContent: '⏰ Remove vouch confirmation expired.'
            });

            if (!confirmation.confirmed) {
                return;
            }

            const result = await sql.begin(async tx => {
                if (access.type === 'admin') {
                    const deletedRows = await tx`
                        delete from player_admin_vouches
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
                            admin_vouches = greatest(admin_vouches - 1, 0),
                            vouches = greatest(vouches - 1, 0),
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
                }

                const deletedRows = await tx`
                    delete from player_vouches
                    where target_discord_id = ${targetUser.id}
                        and voucher_discord_id = ${interaction.user.id}
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
                        vouches = greatest(vouches - 1, 0),
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

            const roleResult = result.removed && access.type === 'admin'
                ? await syncTrustedPenguinRole(
                    interaction.guild,
                    result.player,
                    'Penguin Mafia Admin vouch removed'
                ).catch(error => ({
                    status: 'failed',
                    error
                }))
                : null;
            const roleLine = roleResult?.status === 'failed'
                ? `\n⚠️ Admin vouch was removed, but I could not update Trusted Penguin: \`${roleResult.error.message}\``
                : trustedRoleLine(roleResult);

            await logTrustCommand(interaction, `${vouchKind(access)} Removed`, '/unvouche', [
                {
                    name: 'Player',
                    value: `${targetUser.tag || targetUser.username} (${targetUser.id})`
                },
                {
                    name: 'Actor Trust Type',
                    value: access.type === 'admin' ? access.staffRankName : 'Trusted Penguin'
                },
                {
                    name: 'Admin Vouches',
                    value: String(result.player.admin_vouches)
                },
                {
                    name: 'Total Vouches',
                    value: String(result.player.vouches)
                },
                {
                    name: 'Trusted Penguin Role',
                    value: roleResult?.status || 'Not checked'
                }
            ]);

            await interaction.editReply(
                `✅ **${vouchKind(access)} removed.**\n\n` +
                `Player: **${playerName(result.player, targetUser.username)}** ${targetUser}\n` +
                `${trustSummary(result.player)}${roleLine}`
            );
        } catch (error) {
            logCommandError(interaction, '/unvouche', error);

            await logTrustCommand(interaction, 'Vouch Remove Failed', '/unvouche', [
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
                    `❌ **Remove vouch failed.**\n\n` +
                    `Error:\n\`\`\`\n${error.message}\n\`\`\``,
                components: []
            });
        }
    }
};
