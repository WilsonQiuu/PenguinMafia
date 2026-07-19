const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    assertCanModerateTargetStaff,
    consumeBanPoint,
    donDiscordIds,
    isDon,
    parseDiscordId,
    refundBanPoint,
    requireStaffCanBan
} = require('../utils/staff.js');
const {
    formatUser,
    postModLog
} = require('../utils/modlogs.js');

function playerName(player, fallback = 'Unknown Player') {
    return player?.discord_display_name ||
        player?.discord_username ||
        fallback;
}

async function logBanCommand(interaction, title, fields) {
    try {
        await postModLog(interaction.guild, title, [
            {
                name: 'Command',
                value: '/ban'
            },
            {
                name: 'Actor',
                value: formatUser(interaction.user)
            },
            ...fields
        ]);
    } catch (error) {
        console.error('Could not write /ban mod log:');
        console.error(error);
    }
}

async function requestBanReason(interaction, playerDisplayName, playerDiscordId) {
    const reasonButtonId = `ban_reason:${interaction.id}`;
    const cancelButtonId = `ban_reason_cancel:${interaction.id}`;
    const modalId = `ban_reason_modal:${interaction.id}`;
    const reasonButton = new ButtonBuilder()
        .setCustomId(reasonButtonId)
        .setLabel('Write Ban Reason')
        .setStyle(ButtonStyle.Primary);
    const cancelButton = new ButtonBuilder()
        .setCustomId(cancelButtonId)
        .setLabel('Cancel Ban')
        .setStyle(ButtonStyle.Secondary);
    const row = new ActionRowBuilder().addComponents(reasonButton, cancelButton);

    await interaction.editReply({
        content:
            `⚠️ **Ban reason required**\n\n` +
            `Player: **${playerDisplayName}** \`${playerDiscordId}\`\n\n` +
            `Write the reason before confirming this ban.`,
        components: [row]
    });

    let buttonInteraction;

    try {
        buttonInteraction = await interaction.channel.awaitMessageComponent({
            filter: componentInteraction => {
                return componentInteraction.user.id === interaction.user.id &&
                    [reasonButtonId, cancelButtonId].includes(componentInteraction.customId);
            },
            time: 60_000
        });
    } catch {
        await interaction.editReply({
            content: '⏰ Ban reason prompt expired.',
            components: []
        });
        return null;
    }

    if (buttonInteraction.customId === cancelButtonId) {
        await buttonInteraction.update({
            content: '❌ Discord ban cancelled.',
            components: []
        });
        return null;
    }

    const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle('Ban Reason')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('reason')
                    .setLabel('Why is this player being banned?')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setMaxLength(700)
            )
        );

    await buttonInteraction.showModal(modal);

    let modalSubmit;

    try {
        modalSubmit = await buttonInteraction.awaitModalSubmit({
            filter: submitInteraction => {
                return submitInteraction.user.id === interaction.user.id &&
                    submitInteraction.customId === modalId;
            },
            time: 5 * 60 * 1000
        });
    } catch {
        await interaction.editReply({
            content: '⏰ Ban reason modal expired.',
            components: []
        });
        return null;
    }

    const reason = modalSubmit.fields.getTextInputValue('reason').trim();
    await modalSubmit.deferUpdate();

    if (!reason) {
        await interaction.editReply({
            content: '❌ A ban reason is required.',
            components: []
        });
        return null;
    }

    return reason;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Discord-ban a player without removing them from the database.')
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription('The Discord user to ban')
                .setRequired(false)
        )
        .addStringOption(option =>
            option
                .setName('player')
                .setDescription('Discord mention or ID to ban, useful if user lookup does not work')
                .setRequired(false)
        )
        .addStringOption(option =>
            option
                .setName('reason')
                .setDescription('Reason for the Discord ban')
                .setRequired(false)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const donDiscordId = process.env.DON_DISCORD_ID;

        if (!donDiscordId) {
            await logBanCommand(interaction, 'Ban Failed', [
                {
                    name: 'Reason',
                    value: 'DON_DISCORD_ID is missing from the .env file.'
                }
            ]);

            await interaction.editReply(
                '❌ DON_DISCORD_ID is missing from your `.env` file.'
            );
            return;
        }

        const playerUser = interaction.options.getUser('user');
        const playerInput = interaction.options.getString('player')?.trim() || '';
        let playerDiscordId = playerUser?.id || null;
        let reason = interaction.options.getString('reason')?.trim() || '';

        if (playerUser && playerInput) {
            await logBanCommand(interaction, 'Ban Failed', [
                {
                    name: 'Target Input',
                    value: `${playerUser.tag || playerUser.username} and ${playerInput}`
                },
                {
                    name: 'Reason',
                    value: 'Both user and player options were provided.'
                }
            ]);

            await interaction.editReply(
                '❌ Use either `user` or `player`, not both.'
            );
            return;
        }

        if (!playerDiscordId && playerInput) {
            playerDiscordId = parseDiscordId(playerInput);
        }

        if (!playerDiscordId) {
            await logBanCommand(interaction, 'Ban Failed', [
                {
                    name: 'Target Input',
                    value: playerInput || 'none'
                },
                {
                    name: 'Reason',
                    value: 'Missing or invalid player mention/Discord ID.'
                }
            ]);

            await interaction.editReply(
                '❌ Please choose a Discord `user` or provide a valid mention/Discord ID in `player`.'
            );
            return;
        }

        if (donDiscordIds().includes(playerDiscordId)) {
            await logBanCommand(interaction, 'Ban Failed', [
                {
                    name: 'Target ID',
                    value: playerDiscordId
                },
                {
                    name: 'Reason',
                    value: 'The Don cannot be banned.'
                }
            ]);

            await interaction.editReply(
                '❌ The Don cannot be banned.'
            );
            return;
        }

        if (playerDiscordId === interaction.user.id) {
            await logBanCommand(interaction, 'Ban Failed', [
                {
                    name: 'Target ID',
                    value: playerDiscordId
                },
                {
                    name: 'Reason',
                    value: 'Actor tried to ban themselves.'
                }
            ]);

            await interaction.editReply(
                '❌ You cannot ban yourself.'
            );
            return;
        }

        try {
            const staffAccess = await requireStaffCanBan(sql, interaction);
            await assertCanModerateTargetStaff(sql, interaction, playerDiscordId, 'ban');

            const playerRows = await sql`
                select
                    discord_id,
                    discord_username,
                    discord_display_name
                from players
                where discord_id = ${playerDiscordId}
                limit 1
            `;
            const player = playerRows[0] || null;
            const playerDisplayName = playerName(player, playerDiscordId);

            if (!reason) {
                reason = await requestBanReason(interaction, playerDisplayName, playerDiscordId);

                if (!reason) {
                    await logBanCommand(interaction, 'Ban Cancelled', [
                        {
                            name: 'Target',
                            value: `${playerDisplayName} (${playerDiscordId})`
                        },
                        {
                            name: 'Reason',
                            value: 'No ban reason was provided.'
                        }
                    ]);
                    return;
                }
            }

            const confirmButton = new ButtonBuilder()
                .setCustomId(`ban_confirm:${interaction.id}`)
                .setLabel('Confirm Ban')
                .setStyle(ButtonStyle.Danger);

            const cancelButton = new ButtonBuilder()
                .setCustomId(`ban_cancel:${interaction.id}`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary);

            const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);
            const pointLine = staffAccess.isDon
                ? 'Ban points: `Don unlimited`'
                : `Ban points after this ban: **${staffAccess.banPointsRemaining - 1}**`;

            await interaction.editReply({
                content:
                    `⚠️ **Confirm Discord Ban**\n\n` +
                    `Player: **${playerDisplayName}** \`${playerDiscordId}\`\n` +
                    `Reason: \`${reason}\`\n` +
                    `${pointLine}\n\n` +
                    `This bans the user from Discord only. The database row will stay untouched.`,
                components: [row]
            });

            const filter = buttonInteraction => {
                return (
                    buttonInteraction.user.id === interaction.user.id &&
                    (
                        buttonInteraction.customId === `ban_confirm:${interaction.id}` ||
                        buttonInteraction.customId === `ban_cancel:${interaction.id}`
                    )
                );
            };

            let buttonInteraction;

            try {
                buttonInteraction = await interaction.channel.awaitMessageComponent({
                    filter,
                    time: 60_000
                });
            } catch {
                await logBanCommand(interaction, 'Ban Cancelled', [
                    {
                        name: 'Target',
                        value: `${playerDisplayName} (${playerDiscordId})`
                    },
                    {
                        name: 'Reason',
                        value: 'Confirmation expired.'
                    }
                ]);

                await interaction.editReply({
                    content: '⏰ Discord ban confirmation expired.',
                    components: []
                });
                return;
            }

            if (buttonInteraction.customId === `ban_cancel:${interaction.id}`) {
                await logBanCommand(interaction, 'Ban Cancelled', [
                    {
                        name: 'Target',
                        value: `${playerDisplayName} (${playerDiscordId})`
                    },
                    {
                        name: 'Reason',
                        value: 'Actor cancelled the confirmation.'
                    }
                ]);

                await buttonInteraction.update({
                    content: '❌ Discord ban cancelled.',
                    components: []
                });
                return;
            }

            let remainingBanPoints = null;
            let consumedPoint = false;

            try {
                if (!isDon(interaction.user.id)) {
                    remainingBanPoints = await consumeBanPoint(sql, interaction.user.id);
                    consumedPoint = true;
                }

                await interaction.guild.bans.create(playerDiscordId, {
                    reason: `Penguin Mafia ban by ${interaction.user.tag || interaction.user.username}: ${reason}`
                });
            } catch (error) {
                if (consumedPoint) {
                    await refundBanPoint(sql, interaction.user.id);
                }

                await logBanCommand(interaction, 'Ban Failed', [
                    {
                        name: 'Target',
                        value: `${playerDisplayName} (${playerDiscordId})`
                    },
                    {
                        name: 'Reason',
                        value: reason
                    },
                    {
                        name: 'Error',
                        value: error.message
                    }
                ]);
                error.modLogWritten = true;

                throw error;
            }

            await logBanCommand(interaction, 'Ban Command Completed', [
                {
                    name: 'Target',
                    value: `${playerDisplayName} (${playerDiscordId})`
                },
                {
                    name: 'Reason',
                    value: reason
                },
                {
                    name: 'Ban Points Remaining',
                    value: remainingBanPoints === null ? 'Don unlimited' : remainingBanPoints
                }
            ]);

            await buttonInteraction.update({
                content:
                    `✅ **Discord ban complete.**\n\n` +
                    `Banned: **${playerDisplayName}** \`${playerDiscordId}\`\n` +
                    `Database removed: **no**\n` +
                    `Ban points remaining: **${remainingBanPoints === null ? 'Don unlimited' : remainingBanPoints}**`,
                components: []
            });
        } catch (error) {
            logCommandError(interaction, '/ban', error);

            if (!error.modLogWritten) {
                await logBanCommand(interaction, 'Ban Failed', [
                    {
                        name: 'Target ID',
                        value: playerDiscordId
                    },
                    {
                        name: 'Reason',
                        value: reason
                    },
                    {
                        name: 'Error',
                        value: error.message
                    }
                ]);
            }

            const content =
                `❌ **Ban command failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``;

            if (interaction.replied || interaction.deferred) {
                await interaction.editReply({
                    content,
                    components: []
                });
            } else {
                await interaction.reply({
                    content,
                    flags: MessageFlags.Ephemeral
                });
            }
        }
    }
};
