const {
    MessageFlags,
    SlashCommandBuilder
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    TRUSTED_PENGUIN_ROLE_ID,
    confirmAction,
    ensureActorInDatabase,
    getTrustProfile,
    logTrustCommand,
    playerName,
    requireVouchAccess,
    syncTrustedPenguinRole,
    trustedRoleLine,
    trustSummary,
    willBeTrustedAfterVouch
} = require('../utils/trust.js');

function vouchKind(access) {
    return access.type === 'admin' ? 'Admin vouch' : 'Trusted Penguin vouch';
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('vouche')
        .setDescription('Give a player a vouch. Trusted Penguins give regular vouches; Admins give Admin vouches.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player receiving the vouch')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const targetUser = interaction.options.getUser('player');

        if (targetUser.bot) {
            await interaction.editReply('❌ Bots cannot receive vouches.');
            return;
        }

        if (targetUser.id === interaction.user.id) {
            await interaction.editReply('❌ You cannot vouch yourself.');
            return;
        }

        try {
            const access = await requireVouchAccess(sql, interaction);
            await ensureActorInDatabase(sql, interaction.user.id);

            const target = await getTrustProfile(sql, targetUser.id);

            if (!target) {
                await interaction.editReply(
                    `❌ ${targetUser} is not in the database yet. Run \`/setup\` first.`
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

            if (existingRows.length > 0) {
                await interaction.editReply(
                    `ℹ️ You already gave a ${vouchKind(access)} to **${playerName(target, targetUser.username)}** ${targetUser}.\n\n` +
                    trustSummary(target)
                );
                return;
            }

            const firstConfirmation = await confirmAction(interaction, {
                customIdPrefix: 'vouche',
                confirmLabel: `Confirm ${vouchKind(access)}`,
                content:
                    `⚠️ **Confirm ${vouchKind(access)}**\n\n` +
                    `Player: **${playerName(target, targetUser.username)}** ${targetUser}\n` +
                    `${trustSummary(target)}\n\n` +
                    (
                        access.type === 'admin'
                            ? 'This will add **1 Admin vouch**. Admin vouches count toward Trusted Penguin.'
                            : 'This will add **1 regular vouch**. Regular vouches are tracked, but do not count toward Trusted Penguin.'
                    ),
                confirmedContent: access.type === 'admin'
                    ? '⏳ Checking whether this Admin vouch grants Trusted Penguin...'
                    : '⏳ Recording regular vouch...',
                cancelContent: '❌ Vouch cancelled.',
                expiredContent: '⏰ Vouch confirmation expired.'
            });

            if (!firstConfirmation.confirmed) {
                return;
            }

            if (access.type === 'admin' && willBeTrustedAfterVouch(target)) {
                const trustedConfirmation = await confirmAction(interaction, {
                    customIdPrefix: 'vouche_trusted',
                    confirmLabel: 'Grant Trusted Penguin',
                    danger: true,
                    content:
                        `⚠️ **This Admin vouch will grant Trusted Penguin.**\n\n` +
                        `Player: **${playerName(target, targetUser.username)}** ${targetUser}\n` +
                        `Current Admin vouches: **${target.admin_vouches}**\n` +
                        `After this vouch: **${Number(target.admin_vouches) + 1}**\n\n` +
                        `Are you sure you want to give them <@&${TRUSTED_PENGUIN_ROLE_ID}>?`,
                    confirmedContent: '⏳ Recording Admin vouch and updating Trusted Penguin...',
                    cancelContent: '❌ Vouch cancelled before Trusted Penguin was granted.',
                    expiredContent: '⏰ Trusted Penguin confirmation expired. No vouch was recorded.'
                });

                if (!trustedConfirmation.confirmed) {
                    return;
                }
            }

            const result = await sql.begin(async tx => {
                if (access.type === 'admin') {
                    const insertedRows = await tx`
                        insert into player_admin_vouches (
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
                            admin_vouches = admin_vouches + 1,
                            vouches = vouches + 1,
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
                }

                const insertedRows = await tx`
                    insert into player_vouches (
                        target_discord_id,
                        voucher_discord_id
                    )
                    values (
                        ${targetUser.id},
                        ${interaction.user.id}
                    )
                    on conflict (target_discord_id, voucher_discord_id) do nothing
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
                        vouches = vouches + 1,
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

            const roleResult = result.added && access.type === 'admin'
                ? await syncTrustedPenguinRole(
                    interaction.guild,
                    result.player,
                    'Penguin Mafia Admin vouch update'
                ).catch(error => ({
                    status: 'failed',
                    error
                }))
                : null;
            const roleLine = roleResult?.status === 'failed'
                ? `\n⚠️ Admin vouch was recorded, but I could not update Trusted Penguin: \`${roleResult.error.message}\``
                : trustedRoleLine(roleResult);

            if (!result.added) {
                await interaction.editReply(
                    `ℹ️ You already gave a ${vouchKind(access)} to **${playerName(result.player, targetUser.username)}** ${targetUser}.\n\n` +
                    trustSummary(result.player)
                );
                return;
            }

            await logTrustCommand(interaction, `${vouchKind(access)} Added`, '/vouche', [
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
                `✅ **${vouchKind(access)} added.**\n\n` +
                `Player: **${playerName(result.player, targetUser.username)}** ${targetUser}\n` +
                `${trustSummary(result.player)}${roleLine}`
            );
        } catch (error) {
            logCommandError(interaction, '/vouche', error);

            await logTrustCommand(interaction, 'Vouch Failed', '/vouche', [
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
                    `❌ **Vouch failed.**\n\n` +
                    `Error:\n\`\`\`\n${error.message}\n\`\`\``,
                components: []
            });
        }
    }
};
