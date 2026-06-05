const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    assertCanModerateTargetStaff,
    consumeBanPoint,
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

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Discord-ban a player without removing them from the database.')
        .addStringOption(option =>
            option
                .setName('player')
                .setDescription('The player mention or Discord ID to ban')
                .setRequired(true)
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

        const playerInput = interaction.options.getString('player');
        const playerDiscordId = parseDiscordId(playerInput);
        const reason = interaction.options.getString('reason') || 'No reason provided';

        if (!playerDiscordId) {
            await logBanCommand(interaction, 'Ban Failed', [
                {
                    name: 'Target Input',
                    value: playerInput
                },
                {
                    name: 'Reason',
                    value: 'Invalid player mention or Discord ID.'
                }
            ]);

            await interaction.editReply(
                '❌ Please provide a valid player mention or Discord ID.'
            );
            return;
        }

        if (playerDiscordId === donDiscordId) {
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
