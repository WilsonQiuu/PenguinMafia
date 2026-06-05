const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('recruits')
        .setDescription('Show all recruits under a player.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player whose recruits you want to see. Defaults to yourself.')
                .setRequired(false)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const playerUser = interaction.options.getUser('player') || interaction.user;

        try {
            const rootRows = await sql`
                select
                    discord_id,
                    discord_username,
                    discord_display_name,
                    minecraft_ign
                from players
                where discord_id = ${playerUser.id}
                limit 1
            `;

            if (rootRows.length === 0) {
                await interaction.editReply(
                    `❌ ${playerUser} is not in the database yet.`
                );
                return;
            }

            const rootPlayer = rootRows[0];

            const children = await sql`
                with recursive descendants as (
                    select
                        discord_id,
                        discord_username,
                        discord_display_name,
                        minecraft_ign,
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
                    d.parent_discord_id,
                    d.depth,
                    parent.discord_display_name as parent_display_name,
                    parent.discord_username as parent_username
                from descendants d
                left join players parent
                    on d.parent_discord_id = parent.discord_id
                order by d.depth asc, d.discord_display_name asc
            `;

            const rootName =
                rootPlayer.discord_display_name ||
                rootPlayer.discord_username ||
                playerUser.username;

            if (children.length === 0) {
                await interaction.editReply(
                    `🐧 **${rootName}** has no recruits.`
                );
                return;
            }

            let message =
                `🐧 **Recruits under ${rootName}**\n\n` +
                `Total recruits: **${children.length}**\n\n`;

            for (const child of children) {
                const childName =
                    child.discord_display_name ||
                    child.discord_username ||
                    'Unknown Player';

                const minecraftIGN =
                    child.minecraft_ign ||
                    'Not linked';

                const parentName =
                    child.parent_display_name ||
                    child.parent_username ||
                    'Unknown Recruiter';

                const indent = '—'.repeat(child.depth - 1);

                message +=
                    `${indent}🐧 **${childName}**\n` +
                    `IGN: \`${minecraftIGN}\`\n` +
                    `Recruiter: \`${parentName}\`\n` +
                    `Depth: \`${child.depth}\`\n\n`;

                if (message.length > 1800) {
                    message += `⚠️ Output too long. Showing partial results only.`;
                    break;
                }
            }

            await interaction.editReply(message);
        } catch (error) {
            logCommandError(interaction, '/recruits', error);

            await interaction.editReply(
                `❌ **Recruits command failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
