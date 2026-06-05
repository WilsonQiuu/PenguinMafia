const {
    SlashCommandBuilder
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');

const MAX_TREE_NAMES = 50;

function playerName(player, fallback = 'Unknown Player') {
    return player.minecraft_ign ||
        player.discord_display_name ||
        player.discord_username ||
        fallback;
}

function buildTreeLines(root, recruits) {
    const childrenByRecruiter = new Map();
    const subtreeSizes = new Map();

    for (const recruit of recruits) {
        const siblings = childrenByRecruiter.get(recruit.parent_discord_id) || [];
        siblings.push(recruit);
        childrenByRecruiter.set(recruit.parent_discord_id, siblings);
    }

    function countSubtree(playerId) {
        if (subtreeSizes.has(playerId)) {
            return subtreeSizes.get(playerId);
        }

        const children = childrenByRecruiter.get(playerId) || [];
        const size = 1 + children.reduce((sum, child) => sum + countSubtree(child.discord_id), 0);
        subtreeSizes.set(playerId, size);
        return size;
    }

    countSubtree(root.discord_id);

    for (const siblings of childrenByRecruiter.values()) {
        siblings.sort((a, b) => {
            const branchDifference = (subtreeSizes.get(b.discord_id) || 1) - (subtreeSizes.get(a.discord_id) || 1);

            if (branchDifference !== 0) {
                return branchDifference;
            }

            return playerName(a).localeCompare(playerName(b));
        });
    }

    const lines = [
        `${playerName(root)} | ${root.rank_name}`
    ];
    let namedPlayers = 1;
    let hiddenPlayers = 0;

    function walk(recruiterId, prefix = '') {
        const children = childrenByRecruiter.get(recruiterId) || [];

        children.forEach((child, index) => {
            const isLast = index === children.length - 1;
            const connector = isLast ? '`- ' : '|- ';
            const nextPrefix = `${prefix}${isLast ? '   ' : '|  '}`;
            const branchSize = subtreeSizes.get(child.discord_id) || 1;

            if (namedPlayers >= MAX_TREE_NAMES) {
                hiddenPlayers += branchSize;
                return;
            }

            lines.push(`${prefix}${connector}${playerName(child)} | ${child.rank_name}`);
            namedPlayers++;
            walk(child.discord_id, nextPrefix);
        });
    }

    walk(root.discord_id);

    if (hiddenPlayers > 0) {
        lines.push(`... ${hiddenPlayers} more player${hiddenPlayers === 1 ? '' : 's'}`);
    }

    return lines;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('tree')
        .setDescription('Show a text recruit tree for a player.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player whose recruit tree you want to see. Defaults to yourself.')
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

            if (recruits.length === 0) {
                await interaction.editReply(
                    `🐧 **Recruit Tree: ${playerName(root, playerUser.username)}**\n\n` +
                    `Direct recruiter: \`${directRecruiter}\`\n` +
                    `Total recruits: **0**\n\n` +
                    'No recruits yet.'
                );
                return;
            }

            const treeLines = buildTreeLines(root, recruits);
            let treeOutput = treeLines.join('\n');

            if (treeOutput.length > 1700) {
                treeOutput = `${treeOutput.slice(0, 1700)}\n... output too long, showing partial tree only. Use /graph for a visual overview.`;
            }

            await interaction.editReply(
                `🐧 **Recruit Tree: ${playerName(root, playerUser.username)}**\n\n` +
                `Direct recruiter: \`${directRecruiter}\`\n` +
                `Total recruits: **${recruits.length}**\n\n` +
                '```text\n' +
                `${treeOutput}\n` +
                '```'
            );
        } catch (error) {
            logCommandError(interaction, '/tree', error);

            await interaction.editReply(
                `❌ **Tree command failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
