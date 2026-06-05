const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    formatDonationAmount
} = require('../utils/donations.js');

function playerName(player, fallback = 'Unknown Player') {
    return player.minecraft_ign ||
        player.discord_display_name ||
        player.discord_username ||
        fallback;
}

function donFallbackName() {
    return process.env.DON_DISCORD_ID
        ? `The Don (${process.env.DON_DISCORD_ID})`
        : 'The Don';
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('info')
        .setDescription('Show a player profile and their recruit tree.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player to look up')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const playerUser = interaction.options.getUser('player');

        try {
            const playerRows = await sql`
                select
                    child.discord_id,
                    child.discord_username,
                    child.discord_display_name,
                    child.minecraft_ign,
                    child.donations,
                    child.rank_name,
                    child.staff_rank_name,
                    child.ban_points_remaining,
                    child.parent_discord_id,
                    child.direct_recruits_count,
                    child.weekly_direct_recruits_count,
                    parent.minecraft_ign as parent_minecraft_ign,
                    parent.discord_display_name as parent_display_name,
                    parent.discord_username as parent_username
                from players child
                left join players parent
                    on child.parent_discord_id = parent.discord_id
                where child.discord_id = ${playerUser.id}
                limit 1
            `;

            if (playerRows.length === 0) {
                await interaction.editReply(
                    `${playerUser} is not in the database yet.`
                );
                return;
            }

            const player = playerRows[0];
            const displayName = playerName(player, playerUser.username);
            const minecraftIGN = player.minecraft_ign || 'Not linked';
            const directParent =
                player.parent_minecraft_ign ||
                player.parent_display_name ||
                player.parent_username ||
                'None / Orphan';

            const emperorRows = await sql`
                with recursive ancestors as (
                    select
                        parent.discord_id,
                        parent.discord_username,
                        parent.discord_display_name,
                        parent.minecraft_ign,
                        parent.rank_name,
                        parent.parent_discord_id,
                        1 as depth
                    from players child
                    join players parent
                        on child.parent_discord_id = parent.discord_id
                    where child.discord_id = ${playerUser.id}

                    union all

                    select
                        parent.discord_id,
                        parent.discord_username,
                        parent.discord_display_name,
                        parent.minecraft_ign,
                        parent.rank_name,
                        parent.parent_discord_id,
                        ancestors.depth + 1 as depth
                    from players parent
                    join ancestors
                        on ancestors.parent_discord_id = parent.discord_id
                )
                select *
                from ancestors
                where rank_name = 'Emperor Penguin'
                order by depth asc
                limit 1
            `;

            let hierarchyOwner = emperorRows[0];

            if (!hierarchyOwner) {
                const donRows = process.env.DON_DISCORD_ID
                    ? await sql`
                        select
                            discord_id,
                            discord_username,
                            discord_display_name,
                            minecraft_ign,
                            rank_name
                        from players
                        where discord_id = ${process.env.DON_DISCORD_ID}
                        limit 1
                    `
                    : [];

                hierarchyOwner = donRows[0] || {
                    discord_id: process.env.DON_DISCORD_ID || null,
                    discord_username: donFallbackName(),
                    discord_display_name: 'The Don',
                    minecraft_ign: null,
                    rank_name: 'Don'
                };
            }

            const children = await sql`
                with recursive descendants as (
                    select
                        discord_id,
                        discord_username,
                        discord_display_name,
                        minecraft_ign,
                        rank_name,
                        parent_discord_id,
                        1 as depth
                    from players
                    where parent_discord_id = ${playerUser.id}

                    union all

                    select
                        p.discord_id,
                        p.discord_username,
                        p.discord_display_name,
                        p.minecraft_ign,
                        p.rank_name,
                        p.parent_discord_id,
                        descendants.depth + 1 as depth
                    from players p
                    join descendants
                        on p.parent_discord_id = descendants.discord_id
                )
                select
                    d.discord_id,
                    d.discord_username,
                    d.discord_display_name,
                    d.minecraft_ign,
                    d.rank_name,
                    d.parent_discord_id,
                    d.depth
                from descendants d
                order by d.depth asc, d.discord_display_name asc
            `;

            let message =
                `**Player Info: ${displayName}**\n\n` +
                `Discord: ${playerUser} \`${player.discord_id}\`\n` +
                `IGN: \`${minecraftIGN}\`\n` +
                `Donations: \`${formatDonationAmount(player.donations)}\`\n` +
                `Role: \`${player.rank_name}\`\n` +
                `Staff role: \`${player.staff_rank_name || 'None'}\`\n` +
                `Ban points: **${player.ban_points_remaining}**\n` +
                `Direct recruiter: \`${directParent}\`\n` +
                `Under hierarchy: \`${playerName(hierarchyOwner, donFallbackName())}\`` +
                `\n` +
                `Direct recruits: **${player.direct_recruits_count}**\n` +
                `Weekly direct recruits: **${player.weekly_direct_recruits_count}**\n` +
                `Total recruit tree: **${children.length}**`;

            await interaction.editReply(message);
        } catch (error) {
            logCommandError(interaction, '/info', error);

            await interaction.editReply(
                `**Info command failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
