const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    resetWeeklyRecruitsAndSaveTopThree,
    updateLeaderboardsForGuild
} = require('../utils/leaderboards.js');
const {
    DEFAULT_RANK_NAME,
    RANKS,
    STAFF_RANKS,
    ensureDatabaseSchema,
    ensureInfoChannels,
    ensureRankRoles,
    ensureStaffRoles,
    removeMemberRankRoles
} = require('../utils/bootstrap.js');
const {
    startOnboardingForMember
} = require('../utils/onboarding.js');
const {
    isDon: hasDonAccess
} = require('../utils/staff.js');

async function removeMemberStaffRoles(member, staffRoles) {
    const rolesToRemove = [...staffRoles.values()].filter(role => {
        return member.roles.cache.has(role.id);
    });

    if (rolesToRemove.length > 0) {
        await member.roles.remove(rolesToRemove, 'Penguin Mafia reset removed Staff rank');
        return rolesToRemove.length;
    }

    return 0;
}

async function confirmReset(interaction, {
    title,
    body,
    confirmLabel = 'Confirm Reset'
}) {
    const confirmButton = new ButtonBuilder()
        .setCustomId(`reset_confirm:${interaction.id}`)
        .setLabel(confirmLabel)
        .setStyle(ButtonStyle.Danger);

    const cancelButton = new ButtonBuilder()
        .setCustomId(`reset_cancel:${interaction.id}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

    await interaction.editReply({
        content:
            `⚠️ **${title}**\n\n` +
            body,
        components: [row]
    });

    const filter = buttonInteraction => {
        return (
            buttonInteraction.user.id === interaction.user.id &&
            (
                buttonInteraction.customId === `reset_confirm:${interaction.id}` ||
                buttonInteraction.customId === `reset_cancel:${interaction.id}`
            )
        );
    };

    let buttonInteraction;

    try {
        buttonInteraction = await interaction.channel.awaitMessageComponent({
            filter,
            time: 60_000
        });
    } catch {
        await interaction.editReply({
            content: '⏰ Reset confirmation expired.',
            components: []
        });
        return null;
    }

    if (buttonInteraction.customId === `reset_cancel:${interaction.id}`) {
        await buttonInteraction.update({
            content: '❌ Reset cancelled.',
            components: []
        });
        return null;
    }

    return buttonInteraction;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reset')
        .setDescription('Reset Penguin Mafia data. Owner only.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('all')
                .setDescription('Reset all Penguin Mafia data to default settings.')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('resetweeklyrecruits')
                .setDescription('Reset weekly direct recruit counts.')
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

        if (!hasDonAccess(interaction.user.id)) {
            await interaction.editReply(
                '❌ Only the owner can use `/reset`.'
            );
            return;
        }

        const subcommand = interaction.options.getSubcommand(false) || 'all';

        if (subcommand === 'resetweeklyrecruits') {
            const buttonInteraction = await confirmReset(interaction, {
                title: 'Confirm Weekly Recruit Reset',
                body:
                    `This will reset **everyone's weekly direct recruit count** to **0**.\n\n` +
                    `This does not reset ranks, staff, donations, recruiters, or onboarding.`,
                confirmLabel: 'Confirm Weekly Reset'
            });

            if (!buttonInteraction) {
                return;
            }

            try {
                await buttonInteraction.update({
                    content: '🧊 Weekly recruit reset started...',
                    components: []
                });

                const previousTopThree = await resetWeeklyRecruitsAndSaveTopThree(sql);

                await updateLeaderboardsForGuild(interaction.guild, sql);

                const previousSummary = previousTopThree.length > 0
                    ? previousTopThree.map((player, index) => {
                        const medal = ['🥇', '🥈', '🥉'][index];
                        const name =
                            player.minecraft_ign ||
                            player.discord_display_name ||
                            player.discord_username ||
                            player.discord_id;

                        return `${medal} **${name}** — **${player.recruit_count}** recruit${player.recruit_count === 1 ? '' : 's'}`;
                    }).join('\n')
                    : 'No players had weekly recruits before the reset.';

                await interaction.editReply({
                    content:
                        `✅ **Weekly recruits reset.**\n\n` +
                        `All weekly direct recruit counts are now **0**.\n` +
                        `The weekly recruits leaderboard was refreshed.\n\n` +
                        `**Previous Top 3**\n${previousSummary}`
                });
            } catch (error) {
                logCommandError(interaction, '/reset resetweeklyrecruits', error);

                await interaction.editReply({
                    content:
                        `❌ **Weekly recruit reset failed.**\n\n` +
                        `Error:\n\`\`\`\n${error.message}\n\`\`\``
                });
            }

            return;
        }

        const buttonInteraction = await confirmReset(interaction, {
            title: 'Confirm Full Reset',
            body:
                `This will delete and rebuild the \`players\`, \`ranks\`, and \`staff_ranks\` SQL tables.\n` +
                `Everyone will be reset to:\n` +
                `- No Minecraft IGN\n` +
                `- 0 donations\n` +
                `- No recruiter / orphan, except the Don stays active\n` +
                `- No Staff rank\n` +
                `- No visible Penguin rank role\n` +
                `- Welcome onboarding not completed\n\n` +
                `Everyone will be sent back through private welcome onboarding. The ${DEFAULT_RANK_NAME} role is only given after they finish.`
        });

        if (!buttonInteraction) {
            return;
        }

        try {
            await buttonInteraction.update({
                content: '🧊 Reset started. Rebuilding tables, clearing roles, and reopening welcome onboarding...',
                components: []
            });

            await sql`
                drop table if exists players cascade
            `;

            await sql`
                drop table if exists ranks cascade
            `;

            await sql`
                drop table if exists staff_ranks cascade
            `;

            await ensureDatabaseSchema(sql);

            const roleCache = await interaction.guild.roles.fetch();
            const roleCacheOptions = {
                roleCache,
                forceRoleRefresh: true
            };
            const {
                rankRoles,
                rolesCreated,
                rolesUpdated
            } = await ensureRankRoles(interaction.guild, roleCacheOptions);
            const {
                staffRoles,
                rolesCreated: staffRolesCreated,
                rolesUpdated: staffRolesUpdated
            } = await ensureStaffRoles(interaction.guild, roleCacheOptions);

            const {
                donationsLeaderboardChannel,
                modLogChannel,
                promotionEventsChannel,
                weeklyRecruitsChannel
            } = await ensureInfoChannels(interaction.guild, rankRoles, staffRoles);

            const members = await interaction.guild.members.fetch();

            let importedCount = 0;
            let skippedBots = 0;
            let rankRolesRemoved = 0;
            let staffRolesRemoved = 0;
            let onboardingStarted = 0;

            for (const [, member] of members) {
                if (member.user.bot) {
                    skippedBots++;
                    continue;
                }

                const isDon = hasDonAccess(member.user.id);

                await sql`
                    insert into players (
                        discord_id,
                        discord_username,
                        discord_display_name,
                        minecraft_ign,
                        parent_discord_id,
                        claims_available,
                        donations,
                        rank_name,
                        staff_rank_name,
                        ban_points_remaining,
                        status,
                        welcome_completed
                    )
                    values (
                        ${member.user.id},
                        ${member.user.username},
                        ${member.displayName},
                        null,
                        null,
                        0,
                        0,
                        ${DEFAULT_RANK_NAME},
                        null,
                        0,
                        ${isDon ? 'active' : 'orphan'},
                        false
                    )
                `;

                rankRolesRemoved += await removeMemberRankRoles(member, rankRoles);
                staffRolesRemoved += await removeMemberStaffRoles(member, staffRoles);
                await startOnboardingForMember(member);
                onboardingStarted++;

                importedCount++;
            }

            await interaction.editReply({
                content:
                    `✅ **Reset complete.**\n\n` +
                    `SQL tables rebuilt: **players, ranks, staff_ranks**\n` +
                    `Ranks inserted: **${RANKS.length}**\n` +
                    `Staff ranks inserted: **${STAFF_RANKS.length}**\n` +
                    `Discord rank roles created: **${rolesCreated}**\n` +
                    `Discord rank roles updated: **${rolesUpdated}**\n` +
                    `Discord staff roles created: **${staffRolesCreated}**\n` +
                    `Discord staff roles updated: **${staffRolesUpdated}**\n` +
                    `Managed channels ready: ${promotionEventsChannel}, ${weeklyRecruitsChannel}, ${donationsLeaderboardChannel}, ${modLogChannel}\n` +
                    `Players reset/imported: **${importedCount}**\n` +
                    `Penguin rank roles removed: **${rankRolesRemoved}**\n` +
                    `Staff roles removed: **${staffRolesRemoved}**\n` +
                    `Private welcomes started: **${onboardingStarted}**\n` +
                    `Bots skipped: **${skippedBots}**`
            });
        } catch (error) {
            logCommandError(interaction, '/reset', error);

            await interaction.editReply({
                content:
                    `❌ **Reset failed.**\n\n` +
                    `Error:\n\`\`\`\n${error.message}\n\`\`\``
            });
        }
    }
};
