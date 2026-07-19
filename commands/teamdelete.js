const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    deleteOwnedTeam
} = require('../utils/teams.js');

function confirmationRow(interactionId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`teamdelete_confirm:${interactionId}`)
            .setLabel('Delete Team')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`teamdelete_cancel:${interactionId}`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
    );
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('teamdelete')
        .setDescription('Delete your active team, its private channel, and its team role.'),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        try {
            const teamRows = await sql`
                select
                    id::text as id,
                    name,
                    role_id,
                    channel_id,
                    (
                        select count(*)::int
                        from players
                        where team_id = teams.id
                    ) as member_count
                from teams
                where guild_id = ${interaction.guild.id}
                    and owner_discord_id = ${interaction.user.id}
                    and status = 'active'
                limit 1
            `;
            const team = teamRows[0];

            if (!team) {
                await interaction.editReply('❌ You do not own an active team to delete.');
                return;
            }

            await interaction.editReply({
                content:
                    `⚠️ **Delete Team ${team.name}?**\n\n` +
                    `This will archive the team in the database, remove **${team.member_count}** player(s) from the team, ` +
                    `delete the team role, delete the private team channel, and remove the team from the monthly team leaderboard.\n\n` +
                    `This cannot be undone from Discord.`,
                components: [confirmationRow(interaction.id)]
            });

            const buttonInteraction = await interaction.channel.awaitMessageComponent({
                filter: componentInteraction => {
                    return componentInteraction.user.id === interaction.user.id &&
                        [
                            `teamdelete_confirm:${interaction.id}`,
                            `teamdelete_cancel:${interaction.id}`
                        ].includes(componentInteraction.customId);
                },
                time: 60_000
            }).catch(() => null);

            if (!buttonInteraction) {
                await interaction.editReply({
                    content: '⌛ Team deletion timed out. No changes were made.',
                    components: []
                });
                return;
            }

            await buttonInteraction.deferUpdate();

            if (buttonInteraction.customId === `teamdelete_cancel:${interaction.id}`) {
                await interaction.editReply({
                    content: '✅ Team deletion cancelled.',
                    components: []
                });
                return;
            }

            const result = await deleteOwnedTeam(interaction.guild, interaction.user.id, sql);
            const cleanupWarning = result.cleanup.failures.length > 0
                ? `\n\n⚠️ Cleanup warnings:\n${result.cleanup.failures.map(failure => `- ${failure}`).join('\n')}`
                : '';

            await interaction.editReply({
                content:
                    `✅ **Team deleted.**\n\n` +
                    `Team: **${result.team.name}**\n` +
                    `Players removed from team: **${result.clearedPlayerIds.length}**\n` +
                    `Discord roles synced: **${result.synced}**\n` +
                    `Channels deleted: **${result.cleanup.deletedChannels}**\n` +
                    `Roles deleted: **${result.cleanup.deletedRoles}**${cleanupWarning}`,
                components: []
            });
        } catch (error) {
            logCommandError(interaction, '/teamdelete', error);

            await interaction.editReply({
                content:
                    `❌ **Team delete failed.**\n\n` +
                    `Error:\n\`\`\`\n${error.message}\n\`\`\``,
                components: []
            });
        }
    }
};
