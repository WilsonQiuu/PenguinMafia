const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    ICEBERG_CHANNEL_ID,
    ICEBERG_MEMBERS_CHANNEL_ID
} = require('../utils/bootstrap.js');
const {
    syncIcebergMembershipForGuild,
    updateIcebergChannel,
    updateMembersListChannel
} = require('../utils/iceberg.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reseticeberg')
        .setDescription('Clear all Iceberg plot claims and resync eligible members. Don only.'),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        if (!process.env.DON_DISCORD_ID || interaction.user.id !== process.env.DON_DISCORD_ID) {
            await interaction.editReply('❌ Only the owner can use `/reseticeberg`.');
            return;
        }

        try {
            const clearedPlots = await sql`
                update iceberg_plots
                set
                    owner_discord_id = null,
                    updated_at = now()
                where owner_discord_id is not null
                returning plot_number
            `;
            await sql`delete from iceberg_members`;
            const membership = await syncIcebergMembershipForGuild(interaction.guild, sql);

            // Delete existing bot messages in both channels before recreating the boards.
            for (const channelId of [ICEBERG_CHANNEL_ID, ICEBERG_MEMBERS_CHANNEL_ID]) {
                const channel = interaction.guild.channels.cache.get(channelId) ||
                    (await interaction.guild.channels.fetch(channelId).catch(() => null));
                if (!channel) continue;

                const recent = await channel.messages.fetch({ limit: 20 }).catch(() => null);
                if (recent) {
                    for (const [, msg] of recent) {
                        if (msg.author.id === interaction.client.user.id) {
                            await msg.delete().catch(() => {});
                        }
                    }
                }
            }

            await updateIcebergChannel(interaction.guild, sql).catch(() => {});
            await updateMembersListChannel(interaction.guild, sql).catch(() => {});

            await interaction.editReply(
                `✅ **Iceberg reset complete.**\n\n` +
                `Plot claims cleared: **${clearedPlots.length}**\n` +
                `Eligible Iceberg Penguins restored: **${membership.eligible}**\n` +
                `Boards refreshed.`
            );
        } catch (error) {
            logCommandError(interaction, '/reseticeberg', error);
            await interaction.editReply(`❌ **Reset failed.**\n\`\`\`\n${error.message}\n\`\`\``);
        }
    }
};
