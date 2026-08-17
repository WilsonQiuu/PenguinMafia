const {
    MessageFlags,
    SlashCommandBuilder
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    ICEBERG_PENGUIN_ROLE_ID,
    confirmAction,
    ensureActorInDatabase,
    getTrustProfile,
    logTrustCommand,
    playerName,
    requireVouchAccess,
    syncIcebergPenguinRole,
    icebergRoleLine,
    trustSummary,
    willBeIcebergAfterVouch
} = require('../utils/trust.js');

function vouchKind(access) {
    return access.type === 'admin' ? 'Admin vouch' : 'Iceberg Penguin vouch';
}

function publicVouchKind(access) {
    return access.type === 'admin' ? 'Admin vouch' : 'regular vouch';
}

async function sendVouchNotification(interaction, targetUser, access, result, roleResult) {
    if (!interaction.channel?.isTextBased?.()) {
        return;
    }

    const icebergLine = roleResult?.status === 'added'
        ? `\n🎖️ ${targetUser} also received <@&${ICEBERG_PENGUIN_ROLE_ID}>.`
        : '';

    await interaction.channel.send({
        content:
            `📣 ${targetUser}, ${interaction.user} gave you an **${publicVouchKind(access)}**.\n` +
            `Admin vouches: **${result.player.admin_vouches}**\n` +
            `Total vouches: **${result.player.vouches}**${icebergLine}`,
        allowedMentions: {
            users: [targetUser.id, interaction.user.id],
            parse: []
        }
    }).catch(error => {
        console.error(`Could not send public vouch notification for ${targetUser.id}:`);
        console.error(error);
    });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('vouche')
        .setDescription('Give a player a vouch. Iceberg Penguins give regular vouches; Admins give Admin vouches.')
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

            const deltas = access.type === 'admin'
                ? { admin: 1, total: 1 }
                : { admin: 0, total: 1 };

            const firstConfirmation = await confirmAction(interaction, {
                customIdPrefix: 'vouche',
                confirmLabel: `Confirm ${vouchKind(access)}`,
                content:
                    `⚠️ **Confirm ${vouchKind(access)}**\n\n` +
                    `Player: **${playerName(target, targetUser.username)}** ${targetUser}\n` +
                    `${trustSummary(target)}\n\n` +
                    (
                        access.type === 'admin'
                            ? 'This will add **1 Admin vouch**. Iceberg Penguin needs **2 Admin vouches** and **3 total vouches**.'
                            : 'This will add **1 regular vouch**. Regular vouches from Iceberg Penguins count toward the **3 total vouches** needed for Iceberg Penguin.'
                    ),
                confirmedContent: '⏳ Recording vouch...',
                cancelContent: '❌ Vouch cancelled.',
                expiredContent: '⏰ Vouch confirmation expired.'
            });

            if (!firstConfirmation.confirmed) {
                return;
            }

            if (willBeIcebergAfterVouch(target, deltas)) {
                const icebergConfirmation = await confirmAction(interaction, {
                    customIdPrefix: 'vouche_iceberg',
                    confirmLabel: 'Grant Iceberg Penguin',
                    danger: true,
                    content:
                        `⚠️ **This vouch will grant Iceberg Penguin.**\n\n` +
                        `Player: **${playerName(target, targetUser.username)}** ${targetUser}\n` +
                        `Current Admin vouches: **${target.admin_vouches}**\n` +
                        `Current Total vouches: **${target.vouches}**\n` +
                        `After this vouch: **${Number(target.admin_vouches) + deltas.admin}** Admin, **${Number(target.vouches) + deltas.total}** Total\n\n` +
                        `Are you sure you want to give them <@&${ICEBERG_PENGUIN_ROLE_ID}>?`,
                    confirmedContent: '⏳ Recording vouch and updating Iceberg Penguin...',
                    cancelContent: '❌ Vouch cancelled before Iceberg Penguin was granted.',
                    expiredContent: '⏰ Iceberg Penguin confirmation expired. No vouch was recorded.'
                });

                if (!icebergConfirmation.confirmed) {
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

            const roleResult = result.added
                ? await syncIcebergPenguinRole(
                    interaction.guild,
                    result.player,
                    'Penguin Mafia vouch update'
                ).catch(error => ({
                    status: 'failed',
                    error
                }))
                : null;
            const roleLine = roleResult?.status === 'failed'
                ? `\n⚠️ Vouch was recorded, but I could not update Iceberg Penguin: \`${roleResult.error.message}\``
                : icebergRoleLine(roleResult);

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
                    value: access.type === 'admin' ? access.staffRankName : 'Iceberg Penguin'
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
                    name: 'Iceberg Penguin Role',
                    value: roleResult?.status || 'Not checked'
                }
            ]);

            await sendVouchNotification(interaction, targetUser, access, result, roleResult);

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
