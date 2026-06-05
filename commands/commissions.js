const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    formatCents
} = require('../utils/donations.js');

function playerName(player, fallback = 'Unknown Player') {
    return player.discord_display_name ||
        player.discord_username ||
        fallback;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('commissions')
        .setDescription('Check unpaid commissions.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player to check. Don only for other players.')
                .setRequired(false)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const donDiscordId = process.env.DON_DISCORD_ID;
        const requestedUser = interaction.options.getUser('player') || interaction.user;

        if (
            requestedUser.id !== interaction.user.id &&
            (!donDiscordId || interaction.user.id !== donDiscordId)
        ) {
            await interaction.editReply(
                '❌ Only the Don can check another player’s unpaid commissions.'
            );
            return;
        }

        try {
            const rows = await sql`
                select
                    discord_id,
                    discord_username,
                    discord_display_name,
                    minecraft_ign,
                    unpaid_commissions
                from players
                where discord_id = ${requestedUser.id}
                limit 1
            `;

            if (rows.length === 0) {
                await interaction.editReply(
                    `${requestedUser} is not in the database yet.`
                );
                return;
            }

            const player = rows[0];
            const linkStatus = player.minecraft_ign
                ? `Linked IGN: \`${player.minecraft_ign}\``
                : 'Minecraft IGN: `Not linked`';

            await interaction.editReply(
                `💰 **Unpaid Commissions**\n\n` +
                `Player: **${playerName(player, requestedUser.username)}**\n` +
                `${linkStatus}\n` +
                `Amount: **${formatCents(player.unpaid_commissions)}**`
            );
        } catch (error) {
            logCommandError(interaction, '/commissions', error);

            await interaction.editReply(
                `❌ **Commissions command failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
