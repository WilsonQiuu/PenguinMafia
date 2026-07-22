const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    ICEBERG_ROLE_ID,
    ICEBERG_CHANNEL_ID,
    ICEBERG_MEMBERS_CHANNEL_ID
} = require('../utils/bootstrap.js');
const {
    getIcebergRole,
    updateIcebergChannel,
    updateMembersListChannel
} = require('../utils/iceberg.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reseticeberg')
        .setDescription('Remove Iceberg role from all, reset fund and members. Don only.'),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        if (!process.env.DON_DISCORD_ID || interaction.user.id !== process.env.DON_DISCORD_ID) {
            await interaction.editReply('❌ Only the Don can use `/reseticeberg`.');
            return;
        }

        try {
            const role = await getIcebergRole(interaction.guild);

            if (role) {
                const members = await interaction.guild.members.fetch();
                let removed = 0;

                for (const [, member] of members) {
                    if (member.roles.cache.has(role.id)) {
                        await member.roles.remove(role, 'Iceberg reset by Don');
                        removed++;
                    }
                }

                await sql`
                    delete from iceberg_members
                `;
                await sql`
                    delete from iceberg_plots
                `;
                await sql`
                    update iceberg_fund set balance = 0, updated_at = now() where id = 1
                `;

                // Delete existing bot messages in both channels
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

                await updateIcebergChannel(interaction.guild).catch(() => {});
                await updateMembersListChannel(interaction.guild).catch(() => {});

                await interaction.editReply(
                    `✅ **Iceberg reset complete.**\n\n` +
                    `Role removed from **${removed}** members.\n` +
                    `Builder's Fund reset to **0**.\n` +
                    `Plots and members cleared.\n` +
                    `Channels refreshed.\n\n` +
                    `Run \`/iceberg claims enable\` when ready for new claims.`
                );
            } else {
                await interaction.editReply('❌ Iceberg role not found.');
            }
        } catch (error) {
            logCommandError(interaction, '/reseticeberg', error);
            await interaction.editReply(`❌ **Reset failed.**\n\`\`\`\n${error.message}\n\`\`\``);
        }
    }
};
