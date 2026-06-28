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
    syncTrustedPenguinRole,
    trustedRoleLine,
    trustSummary
} = require('../utils/trust.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('veto')
        .setDescription('Give a player an Admin veto that blocks Trusted Penguin.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player receiving the Admin veto')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const targetUser = interaction.options.getUser('player');

        if (targetUser.bot) {
            await interaction.editReply('❌ Bots cannot receive Admin vetoes.');
            return;
        }

        if (targetUser.id === interaction.user.id) {
            await interaction.editReply('❌ You cannot Admin-veto yourself.');
            return;
        }

        try {
            const access = await requireAdminTrustAccess(sql, interaction, '/veto');
            await ensureActorInDatabase(sql, interaction.user.id);

            const target = await getTrustProfile(sql, targetUser.id);

            if (!target) {
                await interaction.editReply(
                    `❌ ${targetUser} is not in the database yet. Run \`/setup\` first.`
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

            if (existingRows.length > 0) {
                await interaction.editReply(
                    `ℹ️ You already Admin-vetoed **${playerName(target, targetUser.username)}** ${targetUser}.\n\n` +
                    trustSummary(target)
                );
                return;
            }

            const confirmation = await confirmAction(interaction, {
                customIdPrefix: 'veto',
                confirmLabel: 'Confirm Admin Veto',
                danger: true,
                content:
                    `⚠️ **Confirm Admin Veto**\n\n` +
                    `Player: **${playerName(target, targetUser.username)}** ${targetUser}\n` +
                    `${trustSummary(target)}\n\n` +
                    `This will add **1 Admin veto**. Active Admin vetoes block Trusted Penguin and remove the role if they already have it.`,
                confirmedContent: '⏳ Recording Admin veto and updating Trusted Penguin...',
                cancelContent: '❌ Admin veto cancelled.',
                expiredContent: '⏰ Admin veto confirmation expired.'
            });

            if (!confirmation.confirmed) {
                return;
            }

            const result = await sql.begin(async tx => {
                const insertedRows = await tx`
                    insert into player_admin_vetoes (
                        target_discord_id,
                        admin_discord_id
                    )
                    values (
                        ${targetUser.id},
                        ${interaction.user.id}
                    )
                    on conflict (target_discord_id, admin_discord_id) do nothing
                    returning created_at
                `;

                if (insertedRows.length === 0) {
                    return {
                        added: false,
                        player: await getTrustProfile(tx, targetUser.id)
                    };
                }

                const updatedRows = await tx`
                    update players
                    set
                        admin_vetoes = admin_vetoes + 1,
                        vetoes = vetoes + 1,
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
                    added: true,
                    player: updatedRows[0]
                };
            });

            const roleResult = result.added
                ? await syncTrustedPenguinRole(
                    interaction.guild,
                    result.player,
                    'Penguin Mafia Admin veto update'
                ).catch(error => ({
                    status: 'failed',
                    error
                }))
                : null;
            const roleLine = roleResult?.status === 'failed'
                ? `\n⚠️ Admin veto was recorded, but I could not update Trusted Penguin: \`${roleResult.error.message}\``
                : trustedRoleLine(roleResult);

            await logTrustCommand(interaction, 'Admin Veto Added', '/veto', [
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
                    name: 'Trusted Penguin Role',
                    value: roleResult?.status || 'Not checked'
                }
            ]);

            await interaction.editReply(
                `✅ **Admin veto added.**\n\n` +
                `Player: **${playerName(result.player, targetUser.username)}** ${targetUser}\n` +
                `${trustSummary(result.player)}${roleLine}`
            );
        } catch (error) {
            logCommandError(interaction, '/veto', error);

            await logTrustCommand(interaction, 'Admin Veto Failed', '/veto', [
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
                    `❌ **Admin veto failed.**\n\n` +
                    `Error:\n\`\`\`\n${error.message}\n\`\`\``,
                components: []
            });
        }
    }
};
