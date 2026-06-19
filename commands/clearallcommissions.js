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

module.exports = {
    data: new SlashCommandBuilder()
        .setName('clearallcommissions')
        .setDescription('Clear every player’s unpaid commissions. Don only.'),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const donDiscordId = process.env.DON_DISCORD_ID;

        if (!donDiscordId) {
            await interaction.editReply('❌ DON_DISCORD_ID is missing from your `.env` file.');
            return;
        }

        if (interaction.user.id !== donDiscordId) {
            await interaction.editReply('❌ Only the Don can use `/clearallcommissions`.');
            return;
        }

        try {
            const rows = await sql`
                with cleared as (
                    update players
                    set
                        unpaid_commissions = 0,
                        updated_at = now()
                    where unpaid_commissions > 0
                    returning unpaid_commissions
                )
                select
                    count(*)::int as player_count,
                    coalesce(sum(unpaid_commissions), 0)::text as cleared_total
                from cleared
            `;
            const result = rows[0];

            await interaction.editReply(
                `✅ **All unpaid commissions cleared.**\n\n` +
                `Players cleared: **${result.player_count}**\n` +
                `Total cleared: **${formatCents(result.cleared_total)}**`
            );
        } catch (error) {
            logCommandError(interaction, '/clearallcommissions', error);
            await interaction.editReply(
                `❌ **Clear all commissions failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
