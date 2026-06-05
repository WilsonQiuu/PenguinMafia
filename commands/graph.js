const {
    SlashCommandBuilder,
    AttachmentBuilder
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    renderRecruitTreeImage
} = require('../utils/treeImage.js');

function playerName(player, fallback = 'Unknown Player') {
    return player.minecraft_ign ||
        player.discord_display_name ||
        player.discord_username ||
        fallback;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('graph')
        .setDescription('Show a visual Penguin Mafia recruit graph for a player.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player whose recruit graph you want to see. Defaults to yourself.')
                .setRequired(false)
        ),

    async execute(interaction) {
        await interaction.deferReply();

        const playerUser = interaction.options.getUser('player') || interaction.user;

        try {
            const rootRows = await sql`
                select
                    child.discord_id,
                    child.discord_username,
                    child.discord_display_name,
                    child.minecraft_ign,
                    child.rank_name,
                    child.parent_discord_id,
                    parent.minecraft_ign as parent_minecraft_ign,
                    parent.discord_display_name as parent_display_name,
                    parent.discord_username as parent_username
                from players child
                left join players parent
                    on child.parent_discord_id = parent.discord_id
                where child.discord_id = ${playerUser.id}
                limit 1
            `;

            if (rootRows.length === 0) {
                await interaction.editReply(
                    `❌ ${playerUser} is not in the database yet.`
                );
                return;
            }

            const root = rootRows[0];

            const recruits = await sql`
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
                select *
                from descendants
                order by depth asc, discord_display_name asc
            `;

            const directRecruiter =
                root.parent_minecraft_ign ||
                root.parent_display_name ||
                root.parent_username ||
                'None / Orphan';
            const imageBuffer = await renderRecruitTreeImage(root, recruits);
            const attachment = new AttachmentBuilder(imageBuffer, {
                name: 'penguin-mafia-recruit-graph.png'
            });
            const largeTreeNotice = recruits.length > 49
                ? '\nLarge tree: biggest branches are shown as cards, with remaining recruits grouped as iceberg dot clusters.'
                : '';

            const content =
                `🐧 **Recruit Graph: ${playerName(root, playerUser.username)}**\n` +
                `Direct recruiter: \`${directRecruiter}\`\n` +
                `Total recruits: **${recruits.length}**${largeTreeNotice}`;

            await interaction.editReply({
                content,
                files: [attachment]
            });
        } catch (error) {
            logCommandError(interaction, '/graph', error);

            await interaction.editReply(
                `❌ **Graph command failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
