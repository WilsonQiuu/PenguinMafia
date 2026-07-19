const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    isDon
} = require('../utils/staff.js');

function playerName(player, fallback = 'Unknown Player') {
    return player.discord_display_name ||
        player.discord_username ||
        fallback;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('removerecruiter')
        .setDescription('Remove a player recruiter and make them an orphan. Don only.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player whose recruiter should be removed')
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

        const playerUser = interaction.options.getUser('player');

        if (playerUser.bot) {
            await interaction.editReply(
                '❌ You cannot remove a bot recruiter.'
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
                where child.discord_id = ${playerUser.id}
                limit 1
            `;

            if (playerRows.length === 0) {
                await interaction.editReply(
                    `❌ ${playerUser} is not in the database yet.`
                );
                return;
            }

            const player = playerRows[0];

            if (player.parent_discord_id === null) {
                await interaction.editReply(
                    `❌ **${playerName(player, playerUser.username)}** already has no recruiter.`
                );
                return;
            }

            const oldParentName =
                player.parent_display_name ||
                player.parent_username ||
                'Unknown Recruiter';

            await sql`
                update players
                set
                    parent_discord_id = null,
                    status = 'orphan',
                    updated_at = now()
                where discord_id = ${playerUser.id}
            `;

            await interaction.editReply(
                `✅ **Recruiter removed.**\n\n` +
                `Player: **${playerName(player, playerUser.username)}** \`${playerUser.id}\`\n` +
                `Old recruiter: \`${oldParentName}\`\n\n` +
                `Their own recruits/tree were not changed.`
            );
        } catch (error) {
            logCommandError(interaction, '/removerecruiter', error);

            await interaction.editReply(
                `❌ **Remove recruiter command failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
