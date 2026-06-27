const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    formatUser,
    postModLog
} = require('../utils/modlogs.js');
const {
    isDon,
    parseDiscordId
} = require('../utils/staff.js');
const {
    scheduleLeaderboardsRefreshForGuild
} = require('../utils/leaderboards.js');
const {
    renderGiveaway,
    upsertActiveGiveawaysBoard
} = require('../utils/giveaways.js');

const PREVIEW_LIMIT = 12;

function playerName(player, fallback = 'Unknown Player') {
    return player?.discord_display_name ||
        player?.discord_username ||
        fallback;
}

function playerLabel(player) {
    return `${playerName(player, player.discord_id)} (${player.discord_id})`;
}

function truncateText(value, maxLength = 900) {
    const text = String(value ?? 'Unknown');

    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, maxLength - 3)}...`;
}

function auditReasonText(value, maxLength = 500) {
    return truncateText(value, maxLength).replace(/\n/g, ' ');
}

function treePreview(rows) {
    const previewRows = rows.slice(0, PREVIEW_LIMIT);
    const lines = previewRows.map(row => {
        const indent = '  '.repeat(Math.min(Number(row.depth || 0), 4));
        return `${indent}- ${playerName(row, row.discord_id)} \`${row.discord_id}\``;
    });

    if (rows.length > previewRows.length) {
        lines.push(`...and ${rows.length - previewRows.length} more`);
    }

    return lines.join('\n');
}

function uniqueNonEmpty(values) {
    return [...new Set(values.filter(Boolean))];
}

async function fetchTreeRows(targetDiscordId, db = sql) {
    return db`
        with recursive tree as (
            select
                player.discord_id,
                player.discord_username,
                player.discord_display_name,
                player.parent_discord_id,
                player.joined_invite_code,
                player.joined_via_inviter_discord_id,
                0 as depth,
                array[player.discord_id] as path
            from players player
            where player.discord_id = ${targetDiscordId}

            union all

            select
                child.discord_id,
                child.discord_username,
                child.discord_display_name,
                child.parent_discord_id,
                child.joined_invite_code,
                child.joined_via_inviter_discord_id,
                tree.depth + 1 as depth,
                tree.path || child.discord_id as path
            from players child
            join tree
                on child.parent_discord_id = tree.discord_id
            where child.discord_id <> all(tree.path)
        )
        select *
        from tree
        order by path
    `;
}

async function fetchGiveawayImpact(playerIds, db = sql) {
    const rows = await db`
        select
            (
                select count(*)::int
                from giveaway_entries
                where player_discord_id in ${db(playerIds)}
            ) as active_entries,
            (
                select count(*)::int
                from giveaways
                where host_discord_id in ${db(playerIds)}
                    and status = 'active'
            ) as active_hosted_giveaways,
            (
                select count(*)::int
                from giveaway_payment_requests
                where host_discord_id in ${db(playerIds)}
                    and status in ('pending', 'processing')
            ) as pending_giveaway_payment_requests,
            (
                select count(*)::int
                from donation_payment_requests
                where donor_discord_id in ${db(playerIds)}
                    and status in ('pending', 'processing')
            ) as pending_donation_payment_requests
    `;

    return rows[0] || {
        active_entries: 0,
        active_hosted_giveaways: 0,
        pending_giveaway_payment_requests: 0,
        pending_donation_payment_requests: 0
    };
}

async function fetchAffectedGiveaways(guildId, playerIds, db = sql) {
    return db`
        select distinct
            giveaway.*
        from giveaways giveaway
        left join giveaway_entries entry
            on entry.giveaway_id = giveaway.id
        where giveaway.guild_id = ${guildId}
            and giveaway.status = 'active'
            and (
                giveaway.host_discord_id in ${db(playerIds)}
                or entry.player_discord_id in ${db(playerIds)}
            )
    `;
}

async function fetchGiveawayMessage(guild, giveaway) {
    if (!giveaway?.channel_id || !giveaway?.message_id) {
        return null;
    }

    const channel = guild.channels.cache.get(giveaway.channel_id) ||
        await guild.channels.fetch(giveaway.channel_id).catch(() => null);

    if (!channel?.messages?.fetch) {
        return null;
    }

    return channel.messages.fetch(giveaway.message_id).catch(() => null);
}

async function deleteHostedGiveawayMessages(guild, giveaways, reason) {
    let deleted = 0;
    const failed = [];

    for (const giveaway of giveaways) {
        const message = await fetchGiveawayMessage(guild, giveaway);

        if (!message) {
            continue;
        }

        try {
            await message.delete(reason);
            deleted += 1;
        } catch (error) {
            failed.push(`${giveaway.id}: ${error.message}`);
        }
    }

    return {
        deleted,
        failed
    };
}

async function refreshAffectedGiveawayMessages(guild, giveawayIds, db = sql) {
    if (giveawayIds.length === 0) {
        return {
            refreshed: 0,
            failed: []
        };
    }

    const giveaways = await db`
        select
            giveaway.*,
            (
                select count(*)::int
                from giveaway_entries entry
                where entry.giveaway_id = giveaway.id
            ) as entrant_count
        from giveaways giveaway
        where giveaway.id in ${db(giveawayIds)}
    `;
    let refreshed = 0;
    const failed = [];

    for (const giveaway of giveaways) {
        const message = await fetchGiveawayMessage(guild, giveaway);

        if (!message) {
            continue;
        }

        try {
            await message.edit(renderGiveaway(
                giveaway,
                Number(giveaway.entrant_count || 0),
                giveaway.winner_discord_id
            ));
            refreshed += 1;
        } catch (error) {
            failed.push(`${giveaway.id}: ${error.message}`);
        }
    }

    return {
        refreshed,
        failed
    };
}

async function preflightBans(guild, playerIds) {
    const me = guild.members.me || await guild.members.fetchMe();

    if (!me.permissions.has(PermissionFlagsBits.BanMembers)) {
        throw new Error('The bot is missing the Ban Members permission.');
    }

    const blocked = [];

    for (const playerId of playerIds) {
        const member = await guild.members.fetch(playerId).catch(() => null);

        if (member && !member.bannable) {
            blocked.push(`${member.user.tag || member.user.username || playerId} (${playerId})`);
        }
    }

    if (blocked.length > 0) {
        throw new Error(
            `The bot cannot ban these member(s), likely because of Discord role hierarchy:\n` +
            blocked.map(value => `- ${value}`).join('\n')
        );
    }
}

async function invalidateTreeInvites(guild, playerIds, joinedInviteCodes, reason) {
    const playerIdSet = new Set(playerIds);
    const joinedInviteCodeSet = new Set(joinedInviteCodes);
    const deleted = [];
    const failed = [];
    let createdByTreeCount = 0;
    let recordedJoinInviteCount = 0;
    let recordedOutsideInviterCount = 0;

    let invites;

    try {
        invites = await guild.invites.fetch();
    } catch (error) {
        return {
            deleted,
            failed: [`Could not fetch invites: ${error.message}`],
            createdByTreeCount,
            recordedJoinInviteCount,
            recordedOutsideInviterCount
        };
    }

    for (const invite of invites.values()) {
        const createdByTree = Boolean(invite.inviter?.id && playerIdSet.has(invite.inviter.id));
        const isRecordedJoinInvite = joinedInviteCodeSet.has(invite.code);

        if (!createdByTree && !isRecordedJoinInvite) {
            continue;
        }

        if (createdByTree) {
            createdByTreeCount += 1;
        }

        if (isRecordedJoinInvite) {
            recordedJoinInviteCount += 1;

            if (!createdByTree) {
                recordedOutsideInviterCount += 1;
            }
        }

        try {
            await invite.delete(reason);
            deleted.push(invite.code);
        } catch (error) {
            failed.push(`${invite.code}: ${error.message}`);
        }
    }

    try {
        const refreshedInvites = await guild.invites.fetch();
        guild.client.invites.set(
            guild.id,
            new Map(refreshedInvites.map(invite => [invite.code, invite.uses || 0]))
        );
    } catch {
        // The invite cache will also be updated by InviteDelete events. This refresh is best effort.
    }

    return {
        deleted,
        failed,
        createdByTreeCount,
        recordedJoinInviteCount,
        recordedOutsideInviterCount
    };
}

async function banTreeMembers(guild, rows, reason) {
    const banned = [];
    const alreadyBanned = [];
    const failed = [];

    for (const row of rows) {
        try {
            await guild.bans.create(row.discord_id, {
                reason
            });
            banned.push(row.discord_id);
        } catch (error) {
            const existingBan = await guild.bans.fetch(row.discord_id).catch(() => null);

            if (existingBan) {
                alreadyBanned.push(row.discord_id);
                continue;
            }

            failed.push({
                row,
                error
            });
        }
    }

    return {
        banned,
        alreadyBanned,
        failed
    };
}

async function removeTreeFromDatabase(playerIds, db = sql) {
    return db.begin(async tx => {
        const removedEntries = await tx`
            delete from giveaway_entries
            where player_discord_id in ${tx(playerIds)}
            returning giveaway_id, player_discord_id
        `;

        const cancelledGiveawayRequests = await tx`
            update giveaway_payment_requests
            set
                status = 'cancelled',
                updated_at = now()
            where host_discord_id in ${tx(playerIds)}
                and status in ('pending', 'processing')
            returning id
        `;

        const cancelledDonationRequests = await tx`
            update donation_payment_requests
            set
                status = 'cancelled',
                updated_at = now()
            where donor_discord_id in ${tx(playerIds)}
                and status in ('pending', 'processing')
            returning id
        `;

        const deletedPlayers = await tx`
            delete from players
            where discord_id in ${tx(playerIds)}
            returning discord_id
        `;

        const deletedRecruitHistory = await tx`
            delete from recruit_history
            where recruit_discord_id in ${tx(playerIds)}
                or recruiter_discord_id in ${tx(playerIds)}
            returning recruit_discord_id
        `;

        return {
            removedGiveawayEntries: removedEntries.length,
            cancelledGiveawayRequests: cancelledGiveawayRequests.length,
            cancelledDonationRequests: cancelledDonationRequests.length,
            deletedPlayers: deletedPlayers.length,
            deletedRecruitHistory: deletedRecruitHistory.length
        };
    });
}

async function logBanTreeCommand(interaction, title, fields) {
    try {
        await postModLog(interaction.guild, title, [
            {
                name: 'Command',
                value: '/bantree'
            },
            {
                name: 'Actor',
                value: formatUser(interaction.user)
            },
            ...fields
        ]);
    } catch (error) {
        console.error('Could not write /bantree mod log:');
        console.error(error);
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('bantree')
        .setDescription('Ban a player and their entire recruit tree, then remove them from the database. Don only.')
        .addStringOption(option =>
            option
                .setName('player')
                .setDescription('The root player mention or Discord ID')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('reason')
                .setDescription('Reason shown in Discord audit logs')
                .setMaxLength(300)
                .setRequired(false)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        if (!process.env.DON_DISCORD_ID) {
            await interaction.editReply('❌ DON_DISCORD_ID is missing from your `.env` file.');
            return;
        }

        if (!isDon(interaction.user.id)) {
            await interaction.editReply('❌ Only the Don can use `/bantree`.');
            return;
        }

        const playerInput = interaction.options.getString('player', true);
        const targetDiscordId = parseDiscordId(playerInput);
        const reason = (
            interaction.options.getString('reason') ||
            `Recruit tree banned by ${interaction.user.tag || interaction.user.username}`
        ).trim();

        if (!targetDiscordId) {
            await interaction.editReply('❌ Please provide a valid player mention or Discord ID.');
            return;
        }

        if (targetDiscordId === process.env.DON_DISCORD_ID) {
            await interaction.editReply('❌ The Don cannot be banned or removed.');
            return;
        }

        if (targetDiscordId === interaction.user.id) {
            await interaction.editReply('❌ You cannot ban your own tree.');
            return;
        }

        try {
            const treeRows = await fetchTreeRows(targetDiscordId, sql);

            if (treeRows.length === 0) {
                await interaction.editReply(`❌ Player \`${targetDiscordId}\` is not in the database.`);
                return;
            }

            const playerIds = treeRows.map(row => row.discord_id);

            if (playerIds.includes(process.env.DON_DISCORD_ID)) {
                await interaction.editReply('❌ This tree includes the Don, so `/bantree` is blocked.');
                return;
            }

            await preflightBans(interaction.guild, playerIds);

            const giveawayImpact = await fetchGiveawayImpact(playerIds, sql);
            const affectedGiveaways = await fetchAffectedGiveaways(interaction.guild.id, playerIds, sql);
            const joinedInviteCodes = uniqueNonEmpty(treeRows.map(row => row.joined_invite_code));
            const target = treeRows[0];

            const confirmButton = new ButtonBuilder()
                .setCustomId(`bantree_confirm:${interaction.id}`)
                .setLabel('Confirm Ban Tree')
                .setStyle(ButtonStyle.Danger);

            const cancelButton = new ButtonBuilder()
                .setCustomId(`bantree_cancel:${interaction.id}`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary);

            const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

            await interaction.editReply({
                content:
                    `⚠️ **Confirm Ban Tree**\n\n` +
                    `Root: **${playerName(target, targetDiscordId)}** \`${targetDiscordId}\`\n` +
                    `Players to ban and remove: **${treeRows.length}**\n` +
                    `Active giveaway entries to remove: **${giveawayImpact.active_entries}**\n` +
                    `Active giveaways hosted by this tree: **${giveawayImpact.active_hosted_giveaways}**\n` +
                    `Pending giveaway payment requests to cancel: **${giveawayImpact.pending_giveaway_payment_requests}**\n` +
                    `Pending donation requests to cancel: **${giveawayImpact.pending_donation_payment_requests}**\n` +
                    `Recorded join invite codes to invalidate: **${joinedInviteCodes.length}**\n\n` +
                    `This will also delete invite links created by anyone in the tree. If a recorded join invite was created by someone outside the tree, only that invite link is deleted; that inviter is not banned.\n\n` +
                    `Reason: \`${reason.replace(/`/g, "'")}\`\n\n` +
                    `Preview:\n\`\`\`\n${treePreview(treeRows)}\n\`\`\``,
                components: [row]
            });

            const filter = buttonInteraction => {
                return (
                    buttonInteraction.user.id === interaction.user.id &&
                    (
                        buttonInteraction.customId === `bantree_confirm:${interaction.id}` ||
                        buttonInteraction.customId === `bantree_cancel:${interaction.id}`
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
                await logBanTreeCommand(interaction, 'Ban Tree Cancelled', [
                    {
                        name: 'Root',
                        value: playerLabel(target)
                    },
                    {
                        name: 'Reason',
                        value: 'Confirmation expired.'
                    }
                ]);

                await interaction.editReply({
                    content: '⏰ Ban tree confirmation expired.',
                    components: []
                });
                return;
            }

            if (buttonInteraction.customId === `bantree_cancel:${interaction.id}`) {
                await logBanTreeCommand(interaction, 'Ban Tree Cancelled', [
                    {
                        name: 'Root',
                        value: playerLabel(target)
                    },
                    {
                        name: 'Reason',
                        value: 'Actor cancelled the confirmation.'
                    }
                ]);

                await buttonInteraction.update({
                    content: '❌ Ban tree cancelled.',
                    components: []
                });
                return;
            }

            await buttonInteraction.update({
                content:
                    `⏳ Banning **${treeRows.length}** player${treeRows.length === 1 ? '' : 's'} and invalidating invites...`,
                components: []
            });

            const auditReason = auditReasonText(
                `Penguin Mafia /bantree by ${interaction.user.tag || interaction.user.username}: ${reason}`
            );
            const inviteResult = await invalidateTreeInvites(
                interaction.guild,
                playerIds,
                joinedInviteCodes,
                auditReason
            );
            const banResult = await banTreeMembers(interaction.guild, treeRows, auditReason);

            if (banResult.failed.length > 0) {
                const failedText = banResult.failed
                    .slice(0, 10)
                    .map(result => `- ${playerLabel(result.row)}: ${result.error.message}`)
                    .join('\n');

                await logBanTreeCommand(interaction, 'Ban Tree Failed', [
                    {
                        name: 'Root',
                        value: playerLabel(target)
                    },
                    {
                        name: 'Banned Before Failure',
                        value: String(banResult.banned.length)
                    },
                    {
                        name: 'Failed Bans',
                        value: truncateText(failedText)
                    }
                ]);

                await interaction.editReply(
                    `❌ **Ban tree stopped before database removal.**\n\n` +
                    `Banned: **${banResult.banned.length}**\n` +
                    `Already banned: **${banResult.alreadyBanned.length}**\n` +
                    `Failed: **${banResult.failed.length}**\n\n` +
                    `Failures:\n\`\`\`\n${failedText}\n\`\`\`\n` +
                    `No command-side database removal was run because every player must be ban-ready first.`
                );
                return;
            }

            const databaseResult = await removeTreeFromDatabase(playerIds, sql);
            const playerIdSet = new Set(playerIds);
            const hostedAffectedGiveaways = affectedGiveaways.filter(giveaway => {
                return playerIdSet.has(giveaway.host_discord_id);
            });
            const remainingAffectedGiveawayIds = uniqueNonEmpty(
                affectedGiveaways
                    .filter(giveaway => !playerIdSet.has(giveaway.host_discord_id))
                    .map(giveaway => giveaway.id)
            );
            const hostedMessageResult = await deleteHostedGiveawayMessages(
                interaction.guild,
                hostedAffectedGiveaways,
                auditReason
            );
            const refreshedGiveawayResult = await refreshAffectedGiveawayMessages(
                interaction.guild,
                remainingAffectedGiveawayIds,
                sql
            );

            scheduleLeaderboardsRefreshForGuild(interaction.guild, sql);

            await upsertActiveGiveawaysBoard(interaction.guild, sql).catch(error => {
                console.error('Could not refresh active giveaway board after /bantree:');
                console.error(error);
            });

            const inviteFailureLine = inviteResult.failed.length > 0
                ? `\nInvite delete failures: **${inviteResult.failed.length}**`
                : '';
            const giveawayMessageFailureCount =
                hostedMessageResult.failed.length + refreshedGiveawayResult.failed.length;
            const giveawayMessageFailureLine = giveawayMessageFailureCount > 0
                ? `\nGiveaway message update failures: **${giveawayMessageFailureCount}**`
                : '';

            await logBanTreeCommand(interaction, 'Ban Tree Completed', [
                {
                    name: 'Root',
                    value: playerLabel(target)
                },
                {
                    name: 'Players Banned',
                    value: String(banResult.banned.length)
                },
                {
                    name: 'Players Already Banned',
                    value: String(banResult.alreadyBanned.length)
                },
                {
                    name: 'Players Removed From DB',
                    value: String(databaseResult.deletedPlayers)
                },
                {
                    name: 'Invites Deleted',
                    value:
                        `${inviteResult.deleted.length} total; ` +
                        `${inviteResult.createdByTreeCount} created by tree; ` +
                        `${inviteResult.recordedOutsideInviterCount} recorded join invite(s) from outside inviter.`
                },
                {
                    name: 'Giveaway Entries Removed',
                    value: String(databaseResult.removedGiveawayEntries)
                },
                {
                    name: 'Giveaway Messages Updated',
                    value:
                        `${hostedMessageResult.deleted} hosted message(s) deleted; ` +
                        `${refreshedGiveawayResult.refreshed} affected message(s) refreshed; ` +
                        `${giveawayMessageFailureCount} failure(s).`
                },
                {
                    name: 'Reason',
                    value: reason
                }
            ]);

            await interaction.editReply(
                `✅ **Ban tree complete.**\n\n` +
                `Root: **${playerName(target, targetDiscordId)}** \`${targetDiscordId}\`\n` +
                `Players banned: **${banResult.banned.length}**\n` +
                `Players already banned: **${banResult.alreadyBanned.length}**\n` +
                `Players removed from DB: **${databaseResult.deletedPlayers}**\n` +
                `Recruit history rows deleted: **${databaseResult.deletedRecruitHistory}**\n` +
                `Giveaway entries removed: **${databaseResult.removedGiveawayEntries}**\n` +
                `Pending giveaway requests cancelled: **${databaseResult.cancelledGiveawayRequests}**\n` +
                `Pending donation requests cancelled: **${databaseResult.cancelledDonationRequests}**\n` +
                `Hosted giveaway messages deleted: **${hostedMessageResult.deleted}**\n` +
                `Affected giveaway messages refreshed: **${refreshedGiveawayResult.refreshed}**\n` +
                `Invites deleted: **${inviteResult.deleted.length}**\n` +
                `- Created by banned tree members: **${inviteResult.createdByTreeCount}**\n` +
                `- Recorded join invites: **${inviteResult.recordedJoinInviteCount}**\n` +
                `- Recorded join invites from outside inviter: **${inviteResult.recordedOutsideInviterCount}**${inviteFailureLine}${giveawayMessageFailureLine}`
            );
        } catch (error) {
            logCommandError(interaction, '/bantree', error);

            await logBanTreeCommand(interaction, 'Ban Tree Failed', [
                {
                    name: 'Target Input',
                    value: playerInput
                },
                {
                    name: 'Error',
                    value: error.message
                }
            ]);

            await interaction.editReply({
                content:
                    `❌ **Ban tree failed.**\n\n` +
                    `Error:\n\`\`\`\n${error.message}\n\`\`\``,
                components: []
            });
        }
    }
};
