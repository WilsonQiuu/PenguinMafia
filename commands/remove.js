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
    canRecruiterTakeRecruit
} = require('../utils/ranks.js');
const {
    donDiscordIds,
    isDon,
    parseDiscordId
} = require('../utils/staff.js');

function playerName(player, fallback = 'Unknown Player') {
    return player.discord_display_name ||
        player.discord_username ||
        fallback;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('remove')
        .setDescription('Remove a player from the database without banning or kicking them. Don only.')
        .addStringOption(option =>
            option
                .setName('player')
                .setDescription('The player mention or Discord ID to remove from the database')
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

        if (!isDon(interaction.user.id)) {
            await interaction.editReply(
                '❌ Only the Don can use this command.'
            );
            return;
        }

        const playerInput = interaction.options.getString('player');
        const playerDiscordId = parseDiscordId(playerInput);

        if (!playerDiscordId) {
            await interaction.editReply(
                '❌ Please provide a valid player mention or Discord ID.'
            );
            return;
        }

        if (donDiscordIds().includes(playerDiscordId)) {
            await interaction.editReply(
                '❌ The Don cannot be removed from the database.'
            );
            return;
        }

        try {
            const playerRows = await sql`
                select
                    child.discord_id,
                    child.discord_username,
                    child.discord_display_name,
                    child.parent_discord_id,
                    parent.discord_display_name as parent_display_name,
                    parent.discord_username as parent_username
                from players child
                left join players parent
                    on child.parent_discord_id = parent.discord_id
                where child.discord_id = ${playerDiscordId}
                limit 1
            `;

            if (playerRows.length === 0) {
                await interaction.editReply(
                    `❌ Player \`${playerDiscordId}\` is not in the database.`
                );
                return;
            }

            const player = playerRows[0];

            const childRows = await sql`
                select count(*)::int as child_count
                from players
                where parent_discord_id = ${playerDiscordId}
            `;

            const playerDisplayName = playerName(player);
            const parentName =
                player.parent_display_name ||
                player.parent_username ||
                'None / Orphan';
            const childCount = childRows[0].child_count;

            const confirmButton = new ButtonBuilder()
                .setCustomId(`remove_confirm:${interaction.id}`)
                .setLabel('Confirm Remove')
                .setStyle(ButtonStyle.Danger);

            const cancelButton = new ButtonBuilder()
                .setCustomId(`remove_cancel:${interaction.id}`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary);

            const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

            await interaction.editReply({
                content:
                    `⚠️ **Confirm Database Remove**\n\n` +
                    `Player: **${playerDisplayName}** \`${player.discord_id}\`\n` +
                    `Recruiter receiving direct recruits: \`${parentName}\`\n` +
                    `Direct recruits to transfer: **${childCount}**\n\n` +
                    `This removes their player row from the database only. It will not ban or kick them from Discord.`,
                components: [row]
            });

            const filter = buttonInteraction => {
                return (
                    buttonInteraction.user.id === interaction.user.id &&
                    (
                        buttonInteraction.customId === `remove_confirm:${interaction.id}` ||
                        buttonInteraction.customId === `remove_cancel:${interaction.id}`
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
                await interaction.editReply({
                    content: '⏰ Database remove confirmation expired.',
                    components: []
                });
                return;
            }

            if (buttonInteraction.customId === `remove_cancel:${interaction.id}`) {
                await buttonInteraction.update({
                    content: '❌ Database remove cancelled.',
                    components: []
                });
                return;
            }

            const result = await sql.begin(async sql => {
                const lockedPlayerRows = await sql`
                    select parent_discord_id
                    from players
                    where discord_id = ${playerDiscordId}
                    for update
                `;

                if (lockedPlayerRows.length === 0) {
                    throw new Error('Player was already removed from the database.');
                }

                const parentDiscordId = lockedPlayerRows[0].parent_discord_id;

                if (parentDiscordId) {
                    const transferRankRows = await sql`
                        select
                            parent.rank_name as recruiter_rank_name,
                            recruit.discord_username,
                            recruit.discord_display_name,
                            recruit.rank_name as recruit_rank_name
                        from players recruit
                        cross join players parent
                        where recruit.parent_discord_id = ${playerDiscordId}
                            and parent.discord_id = ${parentDiscordId}
                    `;

                    const blockedTransfer = transferRankRows.find(row => {
                        return !canRecruiterTakeRecruit(row.recruiter_rank_name, row.recruit_rank_name);
                    });

                    if (blockedTransfer) {
                        throw new Error(
                            `Remove blocked because transferring direct recruits would break rank hierarchy. ` +
                            `Recruit \`${playerName(blockedTransfer)}\` is \`${blockedTransfer.recruit_rank_name}\`, ` +
                            `but the receiving recruiter is \`${blockedTransfer.recruiter_rank_name}\`.`
                        );
                    }
                }

                const transferredRows = await sql`
                    update players
                    set
                        parent_discord_id = ${parentDiscordId},
                        status = case
                            when ${parentDiscordId}::text is null then 'orphan'
                            else status
                        end,
                        updated_at = now()
                    where parent_discord_id = ${playerDiscordId}
                    returning discord_id
                `;

                await sql`
                    delete from players
                    where discord_id = ${playerDiscordId}
                `;

                return {
                    transferredCount: transferredRows.length,
                    parentDiscordId
                };
            });

            const transferTarget = result.parentDiscordId || 'None / Orphan';

            await buttonInteraction.update({
                content:
                    `✅ **Player removed from database.**\n\n` +
                    `Removed: **${playerDisplayName}** \`${player.discord_id}\`\n` +
                    `Discord banned/kicked: **no**\n` +
                    `Direct recruits transferred: **${result.transferredCount}**\n` +
                    `New recruiter for transferred recruits: \`${transferTarget}\``,
                components: []
            });
        } catch (error) {
            logCommandError(interaction, '/remove', error);

            const content =
                `❌ **Remove command failed.**\n\n` +
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
