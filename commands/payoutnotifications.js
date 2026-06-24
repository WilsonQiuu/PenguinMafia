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
        .setName('payoutnotifications')
        .setDescription('Turn giveaway payout DM notifications on or off.')
        .addStringOption(option =>
            option
                .setName('setting')
                .setDescription('Choose whether payout DMs are enabled.')
                .setRequired(true)
                .addChoices(
                    {
                        name: 'On',
                        value: 'on'
                    },
                    {
                        name: 'Off',
                        value: 'off'
                    },
                    {
                        name: 'Status',
                        value: 'status'
                    }
                )
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const setting = interaction.options.getString('setting', true);

        try {
            if (setting === 'status') {
                const rows = await sql`
                    select payout_notifications_enabled
                    from players
                    where discord_id = ${interaction.user.id}
                    limit 1
                `;

                if (rows.length === 0) {
                    await interaction.editReply('You are not in the player database yet.');
                    return;
                }

                await interaction.editReply(
                    rows[0].payout_notifications_enabled
                        ? '✅ Payout DM notifications are currently **on**.'
                        : '🔕 Payout DM notifications are currently **off**.'
                );
                return;
            }

            const enabled = setting === 'on';
            const rows = await sql`
                update players
                set
                    payout_notifications_enabled = ${enabled},
                    updated_at = now()
                where discord_id = ${interaction.user.id}
                returning payout_notifications_enabled
            `;

            if (rows.length === 0) {
                await interaction.editReply('You are not in the player database yet.');
                return;
            }

            await interaction.editReply(
                enabled
                    ? '✅ Payout DM notifications are now **on**.'
                    : '🔕 Payout DM notifications are now **off**.'
            );
        } catch (error) {
            logCommandError(interaction, '/payoutnotifications', error);

            await interaction.editReply(
                `❌ **Payout notification setting failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
