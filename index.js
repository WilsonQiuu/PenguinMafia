require('dotenv').config();

const sql = require('./db.js');
const {
    logCommandError
} = require('./utils/logging.js');
const {
    DEFAULT_RANK_NAME,
    ensureDatabaseSchema,
    ensureInfoChannels,
    ensureRankRoles,
    ensureStaffRoles,
    ensureTrainerRole,
    invalidateGuildRoleCache,
    removeMemberRankRoles,
    syncMemberRankRole,
    syncMemberStaffRankFromRoles
} = require('./utils/bootstrap.js');
const {
    updateHourlyRecruitsLeaderboardForGuild,
    updateLeaderboardsForGuild
} = require('./utils/leaderboards.js');
const {
    postBranchMilestoneEvents,
    postFirstRecruitEvent
} = require('./utils/events.js');
const {
    ensureGettingPromotedInfoBoard,
    ensureRecruitCommandInfoBoard
} = require('./utils/commandInfo.js');
const {
    ensureElectionCommandsBoard,
    ensureElectionStartingSoonBoard,
    finishExpiredElectionsForGuild,
    removePlayerFromActiveElection,
    resetExpiredElectionResultBoardForGuild,
    updateElectionLeaderboard
} = require('./utils/elections.js');
const {
    runFridayNoonScheduleForGuild
} = require('./utils/weeklySchedule.js');
const {
    cleanupWelcomeChannelsForMissingMembers,
    handleWelcomeButton,
    handleWelcomeModal,
    remindIncompleteWelcomeMembers,
    startOnboardingForMember
} = require('./utils/onboarding.js');
const {
    handleAccountLinkButton,
    handleAccountLinkModal,
    remindUnlinkedPlayers
} = require('./utils/accountLinkReminders.js');
const {
    handleTrialModButton
} = require('./utils/trialModOnboarding.js');
const {
    handleTrainerButton
} = require('./utils/trainerOnboarding.js');
const {
    cleanupEndedGiveawaysForGuild,
    handleGiveawayButton,
    handleGiveawayLinkModal,
    finishExpiredGiveawaysForGuild,
    processIncomingGiveawayPayment,
    upsertActiveGiveawaysBoard
} = require('./utils/giveaways.js');
const {
    formatDonationAmount
} = require('./utils/donations.js');
const {
    processPendingCommissionPayoutsForGuild,
    processPendingGiveawayPayoutsForGuild
} = require('./utils/commissionPayments.js');
const {
    ensureReactionRolesMessage,
    handleReactionRole
} = require('./utils/reactionRoles.js');
const {
    editModLog,
    findModLogChannel,
    formatChannel,
    formatUser,
    postModLog,
    truncateValue
} = require('./utils/modlogs.js');
const {
    ensureMinecraftBotLogChannel,
    postMinecraftBotLog
} = require('./utils/minecraftBotLogs.js');
const {
    emitMinecraftEvent,
    minecraftEvents,
    startMinecraftBot,
    stopMinecraftBot
} = require('./minecraft-bot.js');

const fs = require('fs');
const path = require('path');

const {
    REST,
    Routes,
    Client,
    GatewayIntentBits,
    Partials,
    Collection,
    ActivityType,
    PresenceUpdateStatus,
    Events,
    MessageFlags,
    AuditLogEvent,
    ChannelType
} = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildInvites,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildVoiceStates
    ],
    partials: [
        Partials.Channel,
        Partials.GuildMember,
        Partials.Message,
        Partials.Reaction,
        Partials.User
    ]
});

client.commands = new Collection();
client.invites = new Collection();
client.joinBatches = new Collection();

const COMMUNITY_ONBOARDING_ROLE_CACHE_MS = 5 * 60 * 1000;
const communityOnboardingRoleCache = new Map();

function isDisabledEnvironmentValue(value) {
    return ['0', 'false', 'no', 'off'].includes(String(value || '').trim().toLowerCase());
}

function isEnabledEnvironmentValue(value) {
    return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function shouldAutoStartMinecraftBot() {
    if (isDisabledEnvironmentValue(process.env.MINECRAFT_AUTO_START)) {
        return false;
    }

    if (isEnabledEnvironmentValue(process.env.MINECRAFT_AUTO_START)) {
        return true;
    }

    return Boolean(process.env.MINECRAFT_HOST?.trim() && process.env.MINECRAFT_EMAIL?.trim());
}

function autoStartMinecraftBot() {
    if (!shouldAutoStartMinecraftBot()) {
        console.log('Minecraft bot auto-start disabled or missing Minecraft configuration.');
        return;
    }

    try {
        const result = startMinecraftBot({
            actorTag: 'Railway/process startup',
            source: 'Discord ready auto-start'
        });

        console.log(`Minecraft bot auto-start requested: ${result.status}.`);
    } catch (error) {
        console.error('Minecraft bot auto-start failed:');
        console.error(error);
        emitMinecraftEvent(
            'Minecraft Auto-Start Failed',
            error.message,
            'error',
            {
                Source: 'Discord ready auto-start'
            }
        );
    }
}

minecraftEvents.on('log', event => {
    for (const [, guild] of client.guilds.cache) {
        postMinecraftBotLog(guild, event).catch(error => {
            console.error(`Could not post Minecraft bot log for ${guild.name}:`);
            console.error(error);
        });

        if (event.title === 'Incoming Payment Received') {
            const payment = {
                player: event.details?.Player,
                amount: event.details?.Amount,
                message: event.details?.['Server response']
            };

            processIncomingGiveawayPayment(guild, payment, sql)
                .then(result => {
                    if (result.status === 'hosted') {
                        emitMinecraftEvent(
                            'Paid Giveaway Hosted',
                            `${result.request.host_minecraft_ign} funded a giveaway.`,
                            'success',
                            {
                                Host: `<@${result.request.host_discord_id}>`,
                                'Minecraft IGN': result.request.host_minecraft_ign,
                                'Required amount': formatDonationAmount(result.request.amount),
                                'Paid amount': formatDonationAmount(result.paidAmount),
                                Giveaway: result.message?.url || 'Board message unavailable'
                            }
                        );
                    } else if (result.status === 'too_low') {
                        emitMinecraftEvent(
                            'Giveaway Payment Too Low',
                            `${result.request.host_minecraft_ign} paid less than their pending giveaway amount.`,
                            'warning',
                            {
                                Host: `<@${result.request.host_discord_id}>`,
                                'Minecraft IGN': result.request.host_minecraft_ign,
                                'Required amount': formatDonationAmount(result.request.amount),
                                'Paid amount': formatDonationAmount(result.paidAmount)
                            }
                        );
                    }
                })
                .catch(error => {
                    emitMinecraftEvent(
                        'Paid Giveaway Hosting Failed',
                        error.message,
                        'error',
                        {
                            Player: payment.player,
                            Amount: payment.amount
                        }
                    );
                });
        }
    }
});

const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID || '1512488354044711052';

const deployCommands = async () => {
    try {
        const commands = [];
        const commandFiles = fs
            .readdirSync(path.join(__dirname, 'commands'))
            .filter(file => file.endsWith('.js'));

        for (const file of commandFiles) {
            const command = require(`./commands/${file}`);

            if ('data' in command && 'execute' in command) {
                commands.push(command.data.toJSON());
            } else {
                console.log(`[WARNING] The command at ./commands/${file} is missing a required "data" or "execute" property.`);
            }
        }

        const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

        console.log(`Started refreshing ${commands.length} application (/) commands.`);

        const data = await rest.put(
            Routes.applicationGuildCommands(
                process.env.CLIENT_ID,
                process.env.GUILD_ID
            ),
            { body: commands }
        );

        console.log(`Successfully reloaded ${data.length} application (/) commands.`);
    } catch (error) {
        console.error(`Error occurred while refreshing application (/) commands: ${error}`);
    }
};

function createStartupTimer(guildName) {
    const startedAt = Date.now();
    let lastStepAt = startedAt;

    return function logStartupStep(step) {
        const now = Date.now();
        const stepMs = now - lastStepAt;
        const totalMs = now - startedAt;

        console.log(`[startup:${guildName}] ${step} | step=${stepMs}ms total=${totalMs}ms`);
        lastStepAt = now;
    };
}

function startupMemberLabel(member) {
    const displayName =
        member.displayName ||
        member.user.globalName ||
        member.user.username;

    return `${displayName} (${member.user.id})`;
}

function logStartupMemberStep(guild, memberIndex, memberCount, member, step, startedAt = null) {
    const timing = startedAt === null
        ? ''
        : ` | elapsed=${Date.now() - startedAt}ms`;

    console.log(
        `[startup:${guild.name}] member ${memberIndex}/${memberCount} ${startupMemberLabel(member)} ${step}${timing}`
    );
}

async function safeInteractionErrorReply(interaction, content) {
    try {
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({
                content,
                flags: MessageFlags.Ephemeral
            });
        } else {
            await interaction.reply({
                content,
                flags: MessageFlags.Ephemeral
            });
        }
    } catch (error) {
        if (error.code === 10003 || error.code === 10008 || error.code === 10062) {
            console.warn(
                `Could not send interaction error reply because the target is gone. ` +
                `Interaction=${interaction.id}, code=${error.code}, message=${error.message}`
            );
            return;
        }

        throw error;
    }
}

async function setupGuildOnStartup(guild) {
    const logStartupStep = createStartupTimer(guild.name);

    await ensureDatabaseSchema(sql);
    logStartupStep('database schema ready');

    const {
        rankRoles,
        rolesCreated,
        rolesUpdated
    } = await ensureRankRoles(guild);
    logStartupStep('rank roles ready');

    const {
        staffRoles,
        rolesCreated: staffRolesCreated,
        rolesUpdated: staffRolesUpdated
    } = await ensureStaffRoles(guild);
    logStartupStep('staff roles ready');

    const {
        roleCreated: trainerRoleCreated,
        roleUpdated: trainerRoleUpdated
    } = await ensureTrainerRole(guild);
    logStartupStep('trainer role ready');

    await ensureInfoChannels(guild, rankRoles, staffRoles);
    logStartupStep('managed channels ready');

    await ensureMinecraftBotLogChannel(guild);
    logStartupStep('private Minecraft bot log channel ready');

    console.log(
        `Startup setup complete for ${guild.name}: ` +
        `roles created=${rolesCreated}, roles updated=${rolesUpdated}, ` +
        `staff roles created=${staffRolesCreated}, staff roles updated=${staffRolesUpdated}, ` +
        `trainer role created=${trainerRoleCreated ? 1 : 0}, trainer role updated=${trainerRoleUpdated ? 1 : 0}. ` +
        `Member sync will run last.`
    );

    return {
        guild,
        rankRoles,
        rolesCreated,
        rolesUpdated,
        staffRoles,
        staffRolesCreated,
        staffRolesUpdated
    };
}

function logMemberSyncProgress(guild, state, processedCount, totalCount) {
    if (totalCount <= 0) {
        return;
    }

    const percent = Math.floor((processedCount / totalCount) * 100);

    while (state.nextPercent <= 100 && percent >= state.nextPercent) {
        console.log(`[member-sync:${guild.name}] ${state.nextPercent}% complete (${processedCount}/${totalCount} members processed)`);
        state.nextPercent += 10;
    }
}

async function removeMissingSoldiers(guild, members) {
    const memberIds = [...members.keys()];

    if (memberIds.length === 0) {
        return [];
    }

    const removedRows = await sql`
        with missing_players as (
            select
                player.discord_id,
                player.discord_display_name,
                player.discord_username,
                player.rank_name
            from players player
            where player.rank_name = 'Penguin Soldier'
                and player.discord_id not in ${sql(memberIds)}
        )
        delete from players
        using missing_players
        where players.discord_id = missing_players.discord_id
        returning
            players.discord_id,
            players.discord_display_name,
            players.discord_username,
            players.rank_name
    `;

    if (removedRows.length > 0) {
        const removedNames = removedRows.map(player => {
            return player.discord_display_name ||
                player.discord_username ||
                player.discord_id;
        });

        console.log(
            `Removed ${removedRows.length} missing Penguin Soldier${removedRows.length === 1 ? '' : 's'} ` +
            `from ${guild.name}: ${removedNames.join(', ')}`
        );
    }

    return removedRows;
}

async function syncGuildMembersOnStartup(startupContext) {
    const {
        guild,
        rankRoles,
        rolesCreated,
        rolesUpdated,
        staffRoles,
        staffRolesCreated,
        staffRolesUpdated
    } = startupContext;
    const logStartupStep = createStartupTimer(`member-sync:${guild.name}`);
    const shouldRunFullStartupSync = process.env.FULL_STARTUP_SYNC !== 'false';

    if (!shouldRunFullStartupSync) {
        const missingRankScan = await startOnboardingForMembersMissingRankRole(guild, rankRoles);
        logStartupStep('missing-rank onboarding scan complete');

        console.log(
            `Startup member scan complete for ${guild.name}: ` +
            `members checked=${missingRankScan.checkedCount}, missing rank welcomes started=${missingRankScan.onboardingStarted}, bots skipped=${missingRankScan.skippedBots}. ` +
            `Full member sync skipped because FULL_STARTUP_SYNC=false.`
        );
        return;
    }

    let addedCount = 0;
    let updatedCount = 0;
    let skippedBots = 0;
    let rankRolesAssigned = 0;
    let staffRanksSynced = 0;
    let onboardingStarted = 0;
    let failedMemberSyncs = 0;

    const members = await guild.members.fetch();
    logStartupStep(`fetched ${members.size} members`);

    let memberIndex = 0;
    const progressState = {
        nextPercent: 10
    };
    const shouldLogMemberSync = process.env.STARTUP_MEMBER_DEBUG === 'true';
    const slowMemberSyncMs = Number(process.env.STARTUP_MEMBER_SLOW_MS || 1000);
    let startupChannelCache = null;
    async function getStartupChannelCache() {
        if (!startupChannelCache) {
            startupChannelCache = await guild.channels.fetch();
            logStartupStep(`startup member channel cache ready (${startupChannelCache.size} channels)`);
        }

        return startupChannelCache;
    }

    for (const [, member] of members) {
        memberIndex++;

        if (member.user.bot) {
            skippedBots++;
            if (shouldLogMemberSync) {
                logStartupMemberStep(guild, memberIndex, members.size, member, 'skipped bot');
            }
            logMemberSyncProgress(guild, progressState, memberIndex, members.size);
            continue;
        }

        const memberStartedAt = Date.now();
        if (shouldLogMemberSync) {
            logStartupMemberStep(guild, memberIndex, members.size, member, 'starting');
        }

        try {
        const displayName =
            member.displayName ||
            member.user.globalName ||
            member.user.username;

        const isDon =
            process.env.DON_DISCORD_ID &&
            member.user.id === process.env.DON_DISCORD_ID;

        if (shouldLogMemberSync) {
            logStartupMemberStep(guild, memberIndex, members.size, member, 'starting database upsert', memberStartedAt);
        }

        const rows = await sql`
            insert into players (
                discord_id,
                discord_username,
                discord_display_name,
                minecraft_ign,
                parent_discord_id,
                claims_available,
                rank_name,
                status,
                welcome_completed
            )
            values (
                ${member.user.id},
                ${member.user.username},
                ${displayName},
                null,
                null,
                0,
                ${DEFAULT_RANK_NAME},
                ${isDon ? 'active' : 'orphan'},
                ${isDon}
            )
            on conflict (discord_id) do update
            set
                discord_username = excluded.discord_username,
                discord_display_name = excluded.discord_display_name,
                updated_at = now()
            returning
                rank_name,
                parent_discord_id,
                welcome_completed,
                (xmax = 0) as inserted
        `;

        if (shouldLogMemberSync) {
            logStartupMemberStep(guild, memberIndex, members.size, member, 'database upsert ready', memberStartedAt);
        }

        if (rows[0].inserted) {
            addedCount++;
        } else {
            updatedCount++;
        }

        if (shouldLogMemberSync) {
            logStartupMemberStep(guild, memberIndex, members.size, member, 'starting staff rank sync', memberStartedAt);
        }

        const staffRankName = await syncMemberStaffRankFromRoles(sql, member, staffRoles);

        if (shouldLogMemberSync) {
            logStartupMemberStep(guild, memberIndex, members.size, member, 'staff rank sync ready', memberStartedAt);
        }

        if (staffRankName) {
            staffRanksSynced++;
        }

        const hasAnyRankRole = [...rankRoles.values()].some(role => {
            return member.roles.cache.has(role.id);
        });
        const needsWelcomeForMissingRankRole =
            !isDon &&
            !hasAnyRankRole &&
            rows[0].rank_name === DEFAULT_RANK_NAME;

        if (!rows[0].welcome_completed || needsWelcomeForMissingRankRole) {
            if (needsWelcomeForMissingRankRole && rows[0].welcome_completed) {
                if (shouldLogMemberSync) {
                    logStartupMemberStep(guild, memberIndex, members.size, member, 'starting welcome status reset', memberStartedAt);
                }

                await sql`
                    update players
                    set
                        welcome_completed = false,
                        updated_at = now()
                    where discord_id = ${member.user.id}
                `;

                if (shouldLogMemberSync) {
                    logStartupMemberStep(guild, memberIndex, members.size, member, 'welcome status reset ready', memberStartedAt);
                }
            }

            if (shouldLogMemberSync) {
                logStartupMemberStep(guild, memberIndex, members.size, member, 'starting rank role removal', memberStartedAt);
            }

            await removeMemberRankRoles(member, rankRoles);

            if (shouldLogMemberSync) {
                logStartupMemberStep(guild, memberIndex, members.size, member, 'rank role removal ready', memberStartedAt);
                logStartupMemberStep(guild, memberIndex, members.size, member, 'starting onboarding', memberStartedAt);
            }

            await startOnboardingForMember(member, {
                channelCache: await getStartupChannelCache(),
                recruiterId: rows[0].parent_discord_id
            });

            if (shouldLogMemberSync) {
                logStartupMemberStep(guild, memberIndex, members.size, member, 'onboarding ready', memberStartedAt);
                logStartupMemberStep(guild, memberIndex, members.size, member, 'complete', memberStartedAt);
            } else if (Date.now() - memberStartedAt >= slowMemberSyncMs) {
                logStartupMemberStep(guild, memberIndex, members.size, member, 'completed slowly', memberStartedAt);
            }

            onboardingStarted++;
            logMemberSyncProgress(guild, progressState, memberIndex, members.size);
            continue;
        }

        if (shouldLogMemberSync) {
            logStartupMemberStep(guild, memberIndex, members.size, member, 'starting rank role sync', memberStartedAt);
        }

        const assignedRole = await syncMemberRankRole(member, rankRoles, rows[0].rank_name);

        if (shouldLogMemberSync) {
            logStartupMemberStep(guild, memberIndex, members.size, member, 'rank role sync ready', memberStartedAt);
            logStartupMemberStep(guild, memberIndex, members.size, member, 'complete', memberStartedAt);
        } else if (Date.now() - memberStartedAt >= slowMemberSyncMs) {
            logStartupMemberStep(guild, memberIndex, members.size, member, 'completed slowly', memberStartedAt);
        }

        if (assignedRole) {
            rankRolesAssigned++;
        }

        logMemberSyncProgress(guild, progressState, memberIndex, members.size);
        } catch (error) {
            failedMemberSyncs++;
            console.error(`Member sync failed for ${startupMemberLabel(member)} in ${guild.name}:`);
            console.error(error);
            logMemberSyncProgress(guild, progressState, memberIndex, members.size);
        }
    }
    logStartupStep(`member sync loop complete (${members.size} fetched)`);

    const removedMissingSoldiers = await removeMissingSoldiers(guild, members);
    logStartupStep(`missing soldier cleanup complete (${removedMissingSoldiers.length} removed)`);

    if (removedMissingSoldiers.length > 0) {
        await updateLeaderboardsForGuild(guild, sql).catch(error => {
            console.error('Leaderboard refresh failed after missing soldier cleanup:');
            console.error(error);
        });
    }

    console.log(
        `Startup sync complete for ${guild.name}: ` +
        `roles created=${rolesCreated}, roles updated=${rolesUpdated}, ` +
        `staff roles created=${staffRolesCreated}, staff roles updated=${staffRolesUpdated}, ` +
        `players added=${addedCount}, players updated=${updatedCount}, ` +
        `rank roles assigned=${rankRolesAssigned}, staff ranks synced=${staffRanksSynced}, onboarding started=${onboardingStarted}, ` +
        `bots skipped=${skippedBots}, member sync failures=${failedMemberSyncs}, missing soldiers removed=${removedMissingSoldiers.length}.`
    );

    const deletedWelcomeChannels = await cleanupWelcomeChannelsForMissingMembers(guild, members);
    logStartupStep(`stale welcome cleanup complete (${deletedWelcomeChannels.length} channels deleted)`);
}

async function syncMemberRoleFromDatabase(member) {
    const rows = await sql`
        select
            rank_name,
            welcome_completed
        from players
        where discord_id = ${member.user.id}
        limit 1
    `;

    const rankName = rows[0]?.rank_name || DEFAULT_RANK_NAME;
    const { rankRoles } = await ensureRankRoles(member.guild);

    if (!rows[0]?.welcome_completed) {
        await removeMemberRankRoles(member, rankRoles);
        return false;
    }

    await syncMemberRankRole(member, rankRoles, rankName);
    return true;
}

async function startOnboardingForMembersMissingRankRole(guild, rankRoles) {
    const members = await guild.members.fetch();
    let channelCache = null;
    let checkedCount = 0;
    let skippedBots = 0;
    let onboardingStarted = 0;

    for (const [, member] of members) {
        if (member.user.bot) {
            skippedBots++;
            continue;
        }

        checkedCount++;

        const hasAnyRankRole = [...rankRoles.values()].some(role => {
            return member.roles.cache.has(role.id);
        });

        if (hasAnyRankRole) {
            continue;
        }

        const displayName =
            member.displayName ||
            member.user.globalName ||
            member.user.username;
        const isDon =
            process.env.DON_DISCORD_ID &&
            member.user.id === process.env.DON_DISCORD_ID;

        const rows = await sql`
            insert into players (
                discord_id,
                discord_username,
                discord_display_name,
                minecraft_ign,
                parent_discord_id,
                claims_available,
                rank_name,
                status,
                welcome_completed
            )
            values (
                ${member.user.id},
                ${member.user.username},
                ${displayName},
                null,
                null,
                0,
                ${DEFAULT_RANK_NAME},
                ${isDon ? 'active' : 'orphan'},
                false
            )
            on conflict (discord_id) do update
            set
                discord_username = excluded.discord_username,
                discord_display_name = excluded.discord_display_name,
                welcome_completed = false,
                updated_at = now()
            returning parent_discord_id
        `;

        if (!channelCache) {
            channelCache = await guild.channels.fetch();
        }

        await startOnboardingForMember(member, {
            channelCache,
            recruiterId: rows[0]?.parent_discord_id
        });
        onboardingStarted++;
    }

    return {
        checkedCount,
        skippedBots,
        onboardingStarted
    };
}

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);

    if ('data' in command && 'execute' in command) {
        client.commands.set(command.data.name, command);
    } else {
        console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
    }
}

async function updateAllLeaderboards() {
    for (const [, guild] of client.guilds.cache) {
        try {
            await updateLeaderboardsForGuild(guild, sql);
        } catch (error) {
            console.error(`Leaderboard update failed for ${guild.name}:`);
            console.error(error);
        }
    }
}

async function saveMemberWithParent(guild, member, inviter) {
    let inviterMember = null;

    try {
        inviterMember = await guild.members.fetch(inviter.id);
    } catch {
        inviterMember = null;
    }

    const memberDisplayName =
        member.displayName ||
        member.user.globalName ||
        member.user.username;

    const inviterDisplayName =
        inviterMember?.displayName ||
        inviter.globalName ||
        inviter.username;

    await sql.begin(async sql => {
        // Make sure inviter exists in database first
        await sql`
            insert into players (
                discord_id,
                discord_username,
                discord_display_name,
                minecraft_ign,
                parent_discord_id,
                claims_available,
                rank_name,
                status,
                welcome_completed
            )
            values (
                ${inviter.id},
                ${inviter.username},
                ${inviterDisplayName},
                null,
                null,
                0,
                ${DEFAULT_RANK_NAME},
                'active',
                true
            )
            on conflict (discord_id) do update
            set
                discord_username = excluded.discord_username,
                discord_display_name = excluded.discord_display_name,
                updated_at = now()
        `;

        // Save new member as recruit of inviter
        await sql`
            insert into players (
                discord_id,
                discord_username,
                discord_display_name,
                minecraft_ign,
                parent_discord_id,
                claims_available,
                rank_name,
                status,
                welcome_completed
            )
            values (
                ${member.user.id},
                ${member.user.username},
                ${memberDisplayName},
                null,
                ${inviter.id},
                0,
                ${DEFAULT_RANK_NAME},
                'active',
                false
            )
            on conflict (discord_id) do update
            set
                discord_username = excluded.discord_username,
                discord_display_name = excluded.discord_display_name,
                updated_at = now()
            returning welcome_completed
        `;
    });

    const rows = await sql`
        select welcome_completed
        from players
        where discord_id = ${member.user.id}
        limit 1
    `;

    return {
        inviterId: inviter.id,
        inviterDisplayName,
        welcomeCompleted: rows[0]?.welcome_completed
    };
}

async function saveMemberAsOrphan(member) {
    const memberDisplayName =
        member.displayName ||
        member.user.globalName ||
        member.user.username;

    const rows = await sql`
        insert into players (
            discord_id,
            discord_username,
            discord_display_name,
            minecraft_ign,
            parent_discord_id,
            claims_available,
            rank_name,
            status,
            welcome_completed
        )
        values (
            ${member.user.id},
            ${member.user.username},
            ${memberDisplayName},
            null,
            null,
            0,
            ${DEFAULT_RANK_NAME},
            'orphan',
            false
        )
        on conflict (discord_id) do update
        set
            discord_username = excluded.discord_username,
            discord_display_name = excluded.discord_display_name,
            updated_at = now()
        returning welcome_completed
    `;

    return {
        welcomeCompleted: rows[0]?.welcome_completed
    };
}

async function getConfiguredWelcomeChannel(guild) {
    try {
        const channel = guild.channels.cache.get(WELCOME_CHANNEL_ID) ||
            await guild.channels.fetch(WELCOME_CHANNEL_ID);

        if (!channel?.isTextBased?.()) {
            console.error(`Configured welcome channel ${WELCOME_CHANNEL_ID} is not a text channel.`);
            return null;
        }

        return channel;
    } catch (error) {
        console.error(`Could not fetch configured welcome channel ${WELCOME_CHANNEL_ID} for ${guild.name}:`);
        console.error(error);
        return null;
    }
}

async function sendWelcomeMessage(guild, content) {
    const welcomeChannel = await getConfiguredWelcomeChannel(guild);

    if (!welcomeChannel) {
        return false;
    }

    try {
        await welcomeChannel.send(content);
        return true;
    } catch (error) {
        console.error(`Could not send welcome message in ${welcomeChannel.name}:`);
        console.error(error);
        return false;
    }
}

async function processJoinBatch(guild) {
    const guildId = guild.id;
    const batch = client.joinBatches.get(guildId);

    if (!batch || batch.members.length === 0) return;

    const joinedMembers = [...batch.members];

    client.joinBatches.set(guildId, {
        members: [],
        timer: null
    });

    let inviteChanges = [];
    let inviteFetchFailed = false;

    try {
        const oldInvites = client.invites.get(guildId);
        const newInvites = await guild.invites.fetch();

        for (const invite of newInvites.values()) {
            const oldUses = oldInvites?.get(invite.code) || 0;
            const newUses = invite.uses || 0;
            const delta = newUses - oldUses;

            if (delta > 0) {
                inviteChanges.push({
                    invite,
                    delta
                });
            }
        }

        client.invites.set(
            guildId,
            new Collection(newInvites.map(invite => [invite.code, invite.uses || 0]))
        );
    } catch (error) {
        inviteFetchFailed = true;
        console.error(`Could not fetch invites while processing joins for ${guild.name}. New members will be saved as orphans.`);
        console.error(error);
    }

    try {
        console.log(
            `Processing join batch: ${joinedMembers.length} member(s), ${inviteChanges.length} invite change(s).`
        );

        // Safe case:
        // 1 member joined, 1 invite changed, invite increased by exactly 1.
        if (
            joinedMembers.length === 1 &&
            inviteChanges.length === 1 &&
            inviteChanges[0].delta === 1 &&
            inviteChanges[0].invite.inviter
        ) {
            const member = joinedMembers[0];
            const inviter = inviteChanges[0].invite.inviter;

            const {
                inviterId,
                inviterDisplayName,
                welcomeCompleted
            } = await saveMemberWithParent(guild, member, inviter);

            if (welcomeCompleted) {
                await syncMemberRoleFromDatabase(member);
            } else {
                await startOnboardingForMember(member, {
                    recruiterId: inviterId,
                    inviterDisplayName
                });
            }

            await sendWelcomeMessage(
                guild,
                `🐧🎉 Welcome ${member} to the **Penguin Mafia**!\n\n` +
                `You are member **#${guild.memberCount}** in the server.\n` +
                `You were recruited by **${inviter}**.\n\n` +
                `${member} is now a recruit of **${inviterDisplayName}**.`
            );

            await postFirstRecruitEvent(guild, sql, {
                recruiterId: inviter.id,
                recruitId: member.user.id
            }).catch(error => {
                console.error('First recruit promotion event failed after invite join:');
                console.error(error);
                return false;
            });

            await postBranchMilestoneEvents(guild, sql, inviter.id).catch(error => {
                console.error('Branch milestone event failed after invite join:');
                console.error(error);
                return [];
            });

            await updateLeaderboardsForGuild(guild, sql);

            console.log(`${member.user.tag} was safely assigned to ${inviter.tag}.`);
            return;
        }

        // Ambiguous case:
        // All joined members become orphaned.
        for (const member of joinedMembers) {
            const {
                welcomeCompleted
            } = await saveMemberAsOrphan(member);

            if (welcomeCompleted) {
                await syncMemberRoleFromDatabase(member);
            } else {
                await startOnboardingForMember(member);
            }

            await sendWelcomeMessage(
                guild,
                `🐧🎉 Welcome ${member} to the **Penguin Mafia**!\n\n` +
                `You are member **#${guild.memberCount}** in the server.\n\n` +
                `⚠️ I could not safely detect your recruiter, so you are an orphaned penguin for now.\n\n` +
                `Use \`/join recruiter:@YourRecruiter\` so the Mafia knows who recruited you.`
            );

            console.log(`${member.user.tag} saved as orphan. They can use /join recruiter:@Player.`);
        }

        if (inviteFetchFailed) {
            console.log('Invite detection failed. Members were saved as orphans.');
        } else if (inviteChanges.length === 0) {
            console.log('No invite changes detected. Members were saved as orphans.');
        } else {
            console.log('Ambiguous invite changes detected. Members were saved as orphans.');

            for (const change of inviteChanges) {
                const inviter = change.invite.inviter;

                console.log(
                    `Invite ${change.invite.code} increased by ${change.delta}. ` +
                    `Inviter: ${inviter ? inviter.tag : 'Unknown'}. ` +
                    `Orphans must use /join.`
                );
            }
        }

    } catch (error) {
        console.error('Error processing join batch:');
        console.error(error);
    }
}

async function findRecentAuditEntry(guild, type, targetId = null) {
    try {
        const auditLogs = await guild.fetchAuditLogs({
            type,
            limit: 6
        });
        const now = Date.now();

        return auditLogs.entries.find(logEntry => {
            const targetMatches = !targetId || logEntry.target?.id === targetId;
            const isRecent = now - logEntry.createdTimestamp < 15_000;

            return targetMatches && isRecent;
        }) || null;
    } catch (error) {
        return null;
    }
}

function isHumanExecutor(user) {
    return Boolean(user && !user.bot);
}

function isHumanAuditEntry(auditEntry) {
    return isHumanExecutor(auditEntry?.executor);
}

async function findRecentHumanAuditEntry(guild, type, targetId = null) {
    const auditEntry = await findRecentAuditEntry(guild, type, targetId);

    return isHumanAuditEntry(auditEntry) ? auditEntry : null;
}

async function findRecentHumanAuditExecutor(guild, type, targetId = null) {
    const auditEntry = await findRecentHumanAuditEntry(guild, type, targetId);

    return auditEntry?.executor || null;
}

function formatRoleList(roles) {
    if (!roles || roles.length === 0) {
        return 'None';
    }

    return roles
        .map(role => `${role.name} (${role.id})`)
        .join('\n');
}

function roleDiff(oldMember, newMember) {
    const oldRoles = oldMember.roles.cache;
    const newRoles = newMember.roles.cache;

    return {
        added: newRoles
            .filter(role => role.id !== newMember.guild.id && !oldRoles.has(role.id))
            .map(role => role),
        removed: oldRoles
            .filter(role => role.id !== newMember.guild.id && !newRoles.has(role.id))
            .map(role => role)
    };
}

function valuesFromCollectionOrArray(value) {
    if (!value) {
        return [];
    }

    if (Array.isArray(value)) {
        return value;
    }

    if (typeof value.values === 'function') {
        return [...value.values()];
    }

    return [];
}

function addRoleIds(roleSource, roleIds) {
    if (!roleSource) {
        return;
    }

    if (Array.isArray(roleSource)) {
        for (const role of roleSource) {
            addRoleIds(role, roleIds);
        }

        return;
    }

    if (typeof roleSource === 'string') {
        roleIds.add(roleSource);
        return;
    }

    if (typeof roleSource.keys === 'function') {
        for (const roleId of roleSource.keys()) {
            roleIds.add(roleId);
        }

        return;
    }

    if (roleSource.id) {
        roleIds.add(roleSource.id);
    }
}

function getOnboardingRoleIds(onboarding) {
    const roleIds = new Set();

    if (onboarding?.enabled === false) {
        return roleIds;
    }

    for (const prompt of valuesFromCollectionOrArray(onboarding?.prompts)) {
        for (const option of valuesFromCollectionOrArray(prompt?.options)) {
            addRoleIds(option?.roles, roleIds);
            addRoleIds(option?.roleIds, roleIds);
            addRoleIds(option?.role_ids, roleIds);
        }
    }

    return roleIds;
}

async function fetchCommunityOnboardingRoleIds(guild) {
    const cached = communityOnboardingRoleCache.get(guild.id);

    if (cached && Date.now() - cached.fetchedAt < COMMUNITY_ONBOARDING_ROLE_CACHE_MS) {
        return cached.roleIds;
    }

    try {
        if (typeof guild.fetchOnboarding !== 'function') {
            return new Set();
        }

        const onboarding = await guild.fetchOnboarding();
        const roleIds = getOnboardingRoleIds(onboarding);

        communityOnboardingRoleCache.set(guild.id, {
            fetchedAt: Date.now(),
            roleIds
        });

        return roleIds;
    } catch (error) {
        communityOnboardingRoleCache.set(guild.id, {
            fetchedAt: Date.now(),
            roleIds: new Set()
        });

        return new Set();
    }
}

function clearCommunityOnboardingRoleCache(guild) {
    if (guild?.id) {
        communityOnboardingRoleCache.delete(guild.id);
    }
}

async function filterCommunityOnboardingRoles(guild, diff) {
    const onboardingRoleIds = await fetchCommunityOnboardingRoleIds(guild);

    if (onboardingRoleIds.size === 0) {
        return diff;
    }

    return {
        added: diff.added.filter(role => !onboardingRoleIds.has(role.id)),
        removed: diff.removed.filter(role => !onboardingRoleIds.has(role.id))
    };
}

function channelTypeName(channel) {
    const entry = Object.entries(ChannelType).find(([, value]) => value === channel?.type);

    return entry ? entry[0] : String(channel?.type ?? 'Unknown');
}

function channelParentName(channel) {
    if (!channel?.parentId) {
        return 'None';
    }

    return channel.parent?.name
        ? `${channel.parent.name} (${channel.parentId})`
        : channel.parentId;
}

function channelOverwriteSnapshot(channel) {
    return channel?.permissionOverwrites?.cache
        ?.map(overwrite => `${overwrite.id}:${overwrite.type}:${overwrite.allow.bitfield}:${overwrite.deny.bitfield}`)
        .sort()
        .join('|') || '';
}

function isManagedOnboardingChannel(channel) {
    const topic = String(channel?.topic || '');
    const name = String(channel?.name || '');

    return topic.startsWith('Penguin Mafia onboarding:') ||
        topic.startsWith('Penguin Mafia trainer onboarding:') ||
        topic.startsWith('Penguin Mafia trial mod onboarding:') ||
        name === '🐧-penguin-processing' ||
        name.startsWith('🐧-penguin-processing-') ||
        name.startsWith('welcome-') ||
        name.startsWith('trainer-') ||
        name.startsWith('trial-mod-');
}

function pushChangedField(fields, name, oldValue, newValue) {
    if (oldValue === newValue) {
        return;
    }

    fields.push({
        name,
        value: `${oldValue ?? 'None'} → ${newValue ?? 'None'}`
    });
}

async function logMemberRoleChanges(oldMember, newMember) {
    const diff = roleDiff(oldMember, newMember);

    if (diff.added.length === 0 && diff.removed.length === 0) {
        return;
    }

    const filteredDiff = await filterCommunityOnboardingRoles(newMember.guild, diff);

    if (filteredDiff.added.length === 0 && filteredDiff.removed.length === 0) {
        return;
    }

    const auditEntry = await findRecentHumanAuditEntry(
        newMember.guild,
        AuditLogEvent.MemberRoleUpdate,
        newMember.user.id
    );

    if (!auditEntry) {
        return;
    }

    await postModLog(newMember.guild, 'Member Roles Updated', [
        {
            name: 'Player',
            value: formatUser(newMember)
        },
        {
            name: 'Executor',
            value: auditEntry?.executor ? formatUser(auditEntry.executor) : 'Unknown'
        },
        {
            name: 'Roles Added',
            value: formatRoleList(filteredDiff.added)
        },
        {
            name: 'Roles Removed',
            value: formatRoleList(filteredDiff.removed)
        },
        {
            name: 'Reason',
            value: auditEntry?.reason || 'No reason provided'
        }
    ]);
}

function channelUpdateFields(oldChannel, newChannel) {
    const fields = [];

    pushChangedField(fields, 'Name', oldChannel.name, newChannel.name);
    pushChangedField(fields, 'Type', channelTypeName(oldChannel), channelTypeName(newChannel));
    pushChangedField(fields, 'Category', channelParentName(oldChannel), channelParentName(newChannel));
    pushChangedField(fields, 'Topic', oldChannel.topic, newChannel.topic);
    pushChangedField(fields, 'NSFW', oldChannel.nsfw, newChannel.nsfw);
    pushChangedField(fields, 'Slowmode Seconds', oldChannel.rateLimitPerUser, newChannel.rateLimitPerUser);
    pushChangedField(fields, 'Bitrate', oldChannel.bitrate, newChannel.bitrate);
    pushChangedField(fields, 'User Limit', oldChannel.userLimit, newChannel.userLimit);

    if (channelOverwriteSnapshot(oldChannel) !== channelOverwriteSnapshot(newChannel)) {
        fields.push({
            name: 'Permission Overwrites',
            value: 'Changed'
        });
    }

    return fields;
}

function roleUpdateFields(oldRole, newRole) {
    const fields = [];

    pushChangedField(fields, 'Name', oldRole.name, newRole.name);
    pushChangedField(fields, 'Color', oldRole.hexColor, newRole.hexColor);
    pushChangedField(fields, 'Hoisted', oldRole.hoist, newRole.hoist);
    pushChangedField(fields, 'Mentionable', oldRole.mentionable, newRole.mentionable);

    if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) {
        fields.push({
            name: 'Permissions',
            value: 'Changed'
        });
    }

    return fields;
}

async function logChannelUpdate(oldChannel, newChannel) {
    if (!newChannel.guild) {
        return;
    }

    const changedFields = channelUpdateFields(oldChannel, newChannel);

    if (changedFields.length === 0) {
        return;
    }

    const auditEntry = await findRecentHumanAuditEntry(
        newChannel.guild,
        AuditLogEvent.ChannelUpdate,
        newChannel.id
    );

    if (!auditEntry) {
        return;
    }

    await postModLog(newChannel.guild, 'Channel Updated', [
        {
            name: 'Channel',
            value: formatChannel(newChannel)
        },
        {
            name: 'Executor',
            value: auditEntry?.executor ? formatUser(auditEntry.executor) : 'Unknown'
        },
        ...changedFields,
        {
            name: 'Reason',
            value: auditEntry?.reason || 'No reason provided'
        }
    ]);
}

async function logChannelCreate(channel) {
    if (!channel.guild) {
        return;
    }

    if (isManagedOnboardingChannel(channel)) {
        return;
    }

    const auditEntry = await findRecentHumanAuditEntry(
        channel.guild,
        AuditLogEvent.ChannelCreate,
        channel.id
    );

    if (!auditEntry) {
        return;
    }

    await postModLog(channel.guild, 'Channel Created', [
        {
            name: 'Channel',
            value: formatChannel(channel)
        },
        {
            name: 'Type',
            value: channelTypeName(channel)
        },
        {
            name: 'Executor',
            value: auditEntry?.executor ? formatUser(auditEntry.executor) : 'Unknown'
        },
        {
            name: 'Reason',
            value: auditEntry?.reason || 'No reason provided'
        }
    ]);
}

async function logChannelDelete(channel) {
    if (!channel.guild) {
        return;
    }

    const auditEntry = await findRecentHumanAuditEntry(
        channel.guild,
        AuditLogEvent.ChannelDelete,
        channel.id
    );

    if (!auditEntry) {
        return;
    }

    await postModLog(channel.guild, 'Channel Deleted', [
        {
            name: 'Channel',
            value: formatChannel(channel)
        },
        {
            name: 'Type',
            value: channelTypeName(channel)
        },
        {
            name: 'Executor',
            value: auditEntry?.executor ? formatUser(auditEntry.executor) : 'Unknown'
        },
        {
            name: 'Reason',
            value: auditEntry?.reason || 'No reason provided'
        }
    ]);
}

async function logTimeoutChanges(oldMember, newMember) {
    const oldTimeout = oldMember.communicationDisabledUntilTimestamp || null;
    const newTimeout = newMember.communicationDisabledUntilTimestamp || null;

    if (oldTimeout === newTimeout) {
        return;
    }

    const auditEntry = await findRecentHumanAuditEntry(
        newMember.guild,
        AuditLogEvent.MemberUpdate,
        newMember.user.id
    );

    if (!auditEntry) {
        return;
    }

    const title = newTimeout
        ? oldTimeout ? 'Timeout Updated' : 'Timeout Applied'
        : 'Timeout Removed';
    const fields = [
        {
            name: 'Player',
            value: formatUser(newMember)
        },
        {
            name: 'Executor',
            value: auditEntry?.executor ? formatUser(auditEntry.executor) : 'Unknown'
        },
        {
            name: 'Until',
            value: newTimeout ? `<t:${Math.floor(newTimeout / 1000)}:F>` : 'None'
        },
        {
            name: 'Reason',
            value: auditEntry?.reason || 'Waiting for moderator reason.'
        }
    ];

    const modLogMessage = await postModLog(newMember.guild, title, fields);

    if (!newTimeout || auditEntry.reason || !modLogMessage) {
        return;
    }

    await promptForTimeoutReason(newMember, auditEntry.executor, modLogMessage, title, fields);
}

async function promptForTimeoutReason(member, executor, modLogMessage, title, fields) {
    const channel = modLogMessage.channel || await findModLogChannel(member.guild);

    if (!channel?.isTextBased?.()) {
        return;
    }

    const prompt = await channel.send({
        content:
            `${executor}, please reply in this channel with the timeout reason for ${member}.\n` +
            `You have 5 minutes. The reason will be added to the mod log.`,
        allowedMentions: {
            users: [executor.id],
            parse: []
        }
    });

    try {
        const collected = await channel.awaitMessages({
            filter: message => message.author.id === executor.id && message.content.trim().length > 0,
            max: 1,
            time: 5 * 60 * 1000,
            errors: ['time']
        });
        const reasonMessage = collected.first();
        const reason = truncateValue(reasonMessage.content.trim(), 700);
        const updatedFields = fields.map(field => {
            if (field.name !== 'Reason') {
                return field;
            }

            return {
                ...field,
                value: reason
            };
        });

        await editModLog(modLogMessage, member.guild, title, [
            ...updatedFields,
            {
                name: 'Reason Added By',
                value: formatUser(reasonMessage.author)
            }
        ]);

        await prompt.edit({
            content: `✅ Timeout reason added for ${member}.`,
            allowedMentions: {
                parse: []
            }
        });
    } catch {
        await editModLog(modLogMessage, member.guild, title, [
            ...fields,
            {
                name: 'Reason Prompt',
                value: 'Expired after 5 minutes.'
            }
        ]).catch(error => {
            console.error('Could not mark timeout reason prompt as expired:');
            console.error(error);
        });

        await prompt.edit({
            content: `⏰ Timeout reason prompt expired for ${member}.`,
            allowedMentions: {
                parse: []
            }
        }).catch(error => {
            console.error('Could not edit expired timeout prompt:');
            console.error(error);
        });
    }
}

async function logVoiceMuteChange(oldState, newState) {
    if (!oldState.channelId || !newState.channelId) {
        return;
    }

    if (oldState.serverMute === newState.serverMute) {
        return;
    }

    const member = newState.member || oldState.member;

    if (!member || member.user.bot) {
        return;
    }

    const executor = await findRecentHumanAuditExecutor(
        newState.guild,
        AuditLogEvent.MemberUpdate,
        member.user.id
    );

    if (!executor) {
        return;
    }

    await postModLog(newState.guild, newState.serverMute ? 'Voice Mute Applied' : 'Voice Mute Removed', [
        {
            name: 'Player',
            value: formatUser(member)
        },
        {
            name: 'Executor',
            value: executor ? formatUser(executor) : 'Unknown'
        },
        {
            name: 'Channel',
            value: formatChannel(newState.channel || oldState.channel)
        }
    ]);
}

async function logVoiceDisconnectChange(oldState, newState) {
    if (!oldState.channelId || newState.channelId) {
        return;
    }

    const member = oldState.member || newState.member;

    if (!member || member.user.bot) {
        return;
    }

    const auditEntry = await findRecentHumanAuditEntry(
        oldState.guild,
        AuditLogEvent.MemberDisconnect
    );

    if (!auditEntry) {
        return;
    }

    await postModLog(oldState.guild, 'Voice Kick', [
        {
            name: 'Player',
            value: formatUser(member)
        },
        {
            name: 'Executor',
            value: auditEntry.executor ? formatUser(auditEntry.executor) : 'Unknown'
        },
        {
            name: 'Channel',
            value: formatChannel(oldState.channel)
        },
        {
            name: 'Reason',
            value: auditEntry.reason || 'No reason provided'
        }
    ]);
}

client.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    const logReadyStep = createStartupTimer('client-ready');
    const startupContexts = [];

    for (const [guildId, guild] of client.guilds.cache) {
        try {
            const startupContext = await setupGuildOnStartup(guild);
            startupContexts.push(startupContext);
            logReadyStep(`startup setup complete for ${guild.name}`);
        } catch (error) {
            console.error(`Startup setup failed for ${guild.name}`);
            console.error(error);
        }

        try {
            const invites = await guild.invites.fetch();

            client.invites.set(
                guildId,
                new Collection(invites.map(invite => [invite.code, invite.uses || 0]))
            );

            console.log(`Cached ${invites.size} invites for ${guild.name}`);
            logReadyStep(`invite cache complete for ${guild.name}`);
        } catch (error) {
            console.error(`Could not fetch invites for ${guild.name}`);
            console.error(error);
        }
    }

    autoStartMinecraftBot();
    logReadyStep('minecraft auto-start checked');

    await deployCommands();
    logReadyStep('slash commands deployed');

    console.log('Commands deployed!');

    await updateAllLeaderboards();
    logReadyStep('leaderboards refreshed');

    for (const [, guild] of client.guilds.cache) {
        try {
            const scheduleResult = await runFridayNoonScheduleForGuild(guild, sql);

            if (
                scheduleResult.weeklyReset ||
                scheduleResult.electionStarted ||
                scheduleResult.giveawayPingReminderSent
            ) {
                console.log(
                    `Friday noon schedule ran for ${guild.name}: ` +
                    `weekly reset=${scheduleResult.weeklyReset}, ` +
                    `election started=${scheduleResult.electionStarted}, ` +
                    `giveaway reminder=${scheduleResult.giveawayPingReminderSent}.`
                );
            }

            await ensureGettingPromotedInfoBoard(guild);
            await ensureRecruitCommandInfoBoard(guild);
            await ensureElectionCommandsBoard(guild);
            await ensureReactionRolesMessage(guild);
            await finishExpiredElectionsForGuild(guild, sql);
            await resetExpiredElectionResultBoardForGuild(guild, sql);
            await finishExpiredGiveawaysForGuild(guild, sql);
            await processPendingGiveawayPayoutsForGuild(guild, sql);
            await processPendingCommissionPayoutsForGuild(guild, sql, {
                guild,
                source: 'Startup commission payout recovery'
            });
            await cleanupEndedGiveawaysForGuild(guild, sql);
            await upsertActiveGiveawaysBoard(guild, sql);
            const refreshed = await updateElectionLeaderboard(guild, sql);

            if (!refreshed) {
                await ensureElectionStartingSoonBoard(guild, sql);
            }

            logReadyStep(`election channels refreshed for ${guild.name}`);
        } catch (error) {
            console.error(`Election refresh failed for ${guild.name}:`);
            console.error(error);
        }
    }

    const statusType = process.env.BOT_STATUS || 'Online';
    const activityType = process.env.ACTIVITY_TYPE || 'PLAYING';
    const activityName = process.env.ACTIVITY_NAME || 'Discord';

    const activityTypeMap = {
        PLAYING: ActivityType.Playing,
        WATCHING: ActivityType.Watching,
        LISTENING: ActivityType.Listening,
        STREAMING: ActivityType.Streaming,
        COMPETING: ActivityType.Competing
    };

    const statusTypeMap = {
        online: PresenceUpdateStatus.Online,
        idle: PresenceUpdateStatus.Idle,
        dnd: PresenceUpdateStatus.DoNotDisturb,
        invisible: PresenceUpdateStatus.Invisible
    };

    client.user.setPresence({
        status: statusTypeMap[statusType.toLowerCase()] || PresenceUpdateStatus.Online,
        activities: [{
            name: activityName,
            type: activityTypeMap[activityType.toUpperCase()] || ActivityType.Playing
        }]
    });
    logReadyStep('presence set');

    console.log(`Status set to ${statusType} and activity set to ${activityType} ${activityName}`);

    for (const startupContext of startupContexts) {
        try {
            await syncGuildMembersOnStartup(startupContext);
            logReadyStep(`member sync complete for ${startupContext.guild.name}`);
        } catch (error) {
            console.error(`Member sync failed for ${startupContext.guild.name}`);
            console.error(error);
        }
    }

    async function sendDueWelcomeReminders() {
        for (const [, guild] of client.guilds.cache) {
            try {
                const result = await remindIncompleteWelcomeMembers(guild);

                if (result.sent > 0) {
                    console.log(`Welcome reminders sent for ${guild.name}: ${result.sent}/${result.checked} due member(s).`);
                }
            } catch (error) {
                console.error(`Welcome reminder scan failed for ${guild.name}:`);
                console.error(error);
            }
        }
    }

    async function sendDueAccountLinkReminders() {
        for (const [, guild] of client.guilds.cache) {
            try {
                const result = await remindUnlinkedPlayers(guild, sql);

                if (result.sent > 0) {
                    console.log(`Account-link reminders sent for ${guild.name}: ${result.sent}/${result.checked} due member(s).`);
                }
            } catch (error) {
                console.error(`Account-link reminder scan failed for ${guild.name}:`);
                console.error(error);
            }
        }
    }

    await sendDueAccountLinkReminders();

    setInterval(() => {
        sendDueWelcomeReminders();
        sendDueAccountLinkReminders();
    }, 24 * 60 * 60 * 1000);

    setInterval(async () => {
        for (const [, guild] of client.guilds.cache) {
            try {
                await updateHourlyRecruitsLeaderboardForGuild(guild, sql);
            } catch (error) {
                console.error(`Hourly recruits leaderboard refresh failed for ${guild.name}:`);
                console.error(error);
            }
        }
    }, 60_000);

    let giveawayTimerCheckRunning = false;
    async function runGiveawayTimerCheck() {
        if (giveawayTimerCheckRunning) {
            return;
        }

        giveawayTimerCheckRunning = true;

        try {
            for (const [, guild] of client.guilds.cache) {
                try {
                    const finished = await finishExpiredGiveawaysForGuild(guild, sql);

                    if (finished.length > 0) {
                        console.log(`Ended ${finished.length} expired giveaway(s) for ${guild.name}.`);
                        await processPendingGiveawayPayoutsForGuild(guild, sql);
                    }
                } catch (error) {
                    console.error(`Giveaway timer check failed for ${guild.name}:`);
                    console.error(error);
                }
            }
        } finally {
            giveawayTimerCheckRunning = false;
        }
    }

    setInterval(() => {
        runGiveawayTimerCheck();
    }, 1_000);

    setInterval(async () => {
        for (const [, guild] of client.guilds.cache) {
            try {
                await processPendingGiveawayPayoutsForGuild(guild, sql);
                await processPendingCommissionPayoutsForGuild(guild, sql, {
                    guild,
                    source: 'Scheduled commission payout recovery'
                });
            } catch (error) {
                console.error(`Payout queue failed for ${guild.name}:`);
                console.error(error);
            }
        }
    }, 15_000);

    setInterval(async () => {
        for (const [, guild] of client.guilds.cache) {
            try {
                const scheduleResult = await runFridayNoonScheduleForGuild(guild, sql);

                if (
                    scheduleResult.weeklyReset ||
                    scheduleResult.electionStarted ||
                    scheduleResult.giveawayPingReminderSent
                ) {
                    console.log(
                        `Friday noon schedule ran for ${guild.name}: ` +
                        `weekly reset=${scheduleResult.weeklyReset}, ` +
                        `election started=${scheduleResult.electionStarted}, ` +
                        `giveaway reminder=${scheduleResult.giveawayPingReminderSent}.`
                    );
                }
            } catch (error) {
                console.error(`Friday noon schedule failed for ${guild.name}:`);
                console.error(error);
            }

            try {
                const ended = await finishExpiredElectionsForGuild(guild, sql);

                if (ended.length > 0) {
                    console.log(`Ended ${ended.length} expired election(s) for ${guild.name}.`);
                }
            } catch (error) {
                console.error(`Election timer check failed for ${guild.name}:`);
                console.error(error);
            }

            try {
                const reset = await resetExpiredElectionResultBoardForGuild(guild, sql);

                if (reset) {
                    console.log(`Election result board reset to starting soon for ${guild.name}.`);
                }
            } catch (error) {
                console.error(`Election result board reset failed for ${guild.name}:`);
                console.error(error);
            }

            try {
                const cleaned = await cleanupEndedGiveawaysForGuild(guild, sql);

                if (cleaned.length > 0) {
                    console.log(`Cleaned ${cleaned.length} ended giveaway(s) for ${guild.name}.`);
                }
            } catch (error) {
                console.error(`Giveaway cleanup check failed for ${guild.name}:`);
                console.error(error);
            }
        }
    }, 60_000);
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
    try {
        await handleReactionRole(reaction, user, true);
    } catch (error) {
        console.error(`Could not add reaction role for ${user.id}:`);
        console.error(error);
    }
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
    try {
        await handleReactionRole(reaction, user, false);
    } catch (error) {
        console.error(`Could not remove reaction role for ${user.id}:`);
        console.error(error);
    }
});

client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isButton()) {
        try {
            const accountLinkHandled = await handleAccountLinkButton(interaction, sql);
            if (accountLinkHandled) return;

            const giveawayHandled = await handleGiveawayButton(interaction, sql);
            if (giveawayHandled) return;

            const trainerHandled = await handleTrainerButton(interaction);
            if (trainerHandled) return;

            const trialModHandled = await handleTrialModButton(interaction);
            if (trialModHandled) return;

            const handled = await handleWelcomeButton(interaction);
            if (handled) return;
        } catch (error) {
            logCommandError(interaction, 'onboarding button', error);

            await safeInteractionErrorReply(
                interaction,
                `❌ Onboarding step failed.\n\nError:\n\`\`\`\n${error.message}\n\`\`\``
            );
            return;
        }
    }

    if (interaction.isModalSubmit()) {
        try {
            const accountLinkHandled = await handleAccountLinkModal(interaction, sql);
            if (accountLinkHandled) return;

            const giveawayHandled = await handleGiveawayLinkModal(interaction, sql);
            if (giveawayHandled) return;

            const handled = await handleWelcomeModal(interaction);
            if (handled) return;
        } catch (error) {
            logCommandError(interaction, 'account linking modal', error);

            await safeInteractionErrorReply(
                interaction,
                `❌ Minecraft IGN linking failed.\n\nError:\n\`\`\`\n${error.message}\n\`\`\``
            );
            return;
        }
    }

    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);

    if (!command) return;

    try {
        await command.execute(interaction);
    } catch (error) {
        logCommandError(interaction, `/${interaction.commandName}`, error);

        const errorMessage =
            error?.message ||
            'There was an error while executing this command.';

        await safeInteractionErrorReply(
            interaction,
            `❌ **Command failed.**\n\nError:\n\`\`\`\n${errorMessage}\n\`\`\``
        );
    }
});

client.on(Events.GuildMemberAdd, async member => {
    const guildId = member.guild.id;

    if (!client.joinBatches.has(guildId)) {
        client.joinBatches.set(guildId, {
            members: [],
            timer: null
        });
    }

    const batch = client.joinBatches.get(guildId);

    batch.members.push(member);

    if (batch.timer) {
        clearTimeout(batch.timer);
    }

    batch.timer = setTimeout(async () => {
        await processJoinBatch(member.guild);
    }, 3000);
});

client.on(Events.GuildRoleCreate, async role => {
    invalidateGuildRoleCache(role.guild);
    clearCommunityOnboardingRoleCache(role.guild);
    console.log(`[cache:${role.guild.name}] role cache invalidated after role create: ${role.name}`);

    try {
        const auditEntry = await findRecentHumanAuditEntry(
            role.guild,
            AuditLogEvent.RoleCreate,
            role.id
        );

        if (!auditEntry) {
            return;
        }

        await postModLog(role.guild, 'Role Created', [
            {
                name: 'Role',
                value: `${role.name} (${role.id})`
            },
            {
                name: 'Executor',
                value: auditEntry?.executor ? formatUser(auditEntry.executor) : 'Unknown'
            },
            {
                name: 'Reason',
                value: auditEntry?.reason || 'No reason provided'
            }
        ]);
    } catch (error) {
        console.error('Could not log role create:');
        console.error(error);
    }
});

client.on(Events.GuildRoleUpdate, async (oldRole, newRole) => {
    invalidateGuildRoleCache(newRole.guild);
    clearCommunityOnboardingRoleCache(newRole.guild);
    console.log(`[cache:${newRole.guild.name}] role cache invalidated after role update: ${oldRole.name} -> ${newRole.name}`);

    try {
        const changedFields = roleUpdateFields(oldRole, newRole);

        if (changedFields.length === 0) {
            return;
        }

        const auditEntry = await findRecentHumanAuditEntry(
            newRole.guild,
            AuditLogEvent.RoleUpdate,
            newRole.id
        );

        if (!auditEntry) {
            return;
        }

        await postModLog(newRole.guild, 'Role Updated', [
            {
                name: 'Role',
                value: `${newRole.name} (${newRole.id})`
            },
            {
                name: 'Executor',
                value: auditEntry?.executor ? formatUser(auditEntry.executor) : 'Unknown'
            },
            ...changedFields,
            {
                name: 'Reason',
                value: auditEntry?.reason || 'No reason provided'
            }
        ]);
    } catch (error) {
        console.error('Could not log role update:');
        console.error(error);
    }
});

client.on(Events.GuildRoleDelete, async role => {
    invalidateGuildRoleCache(role.guild);
    clearCommunityOnboardingRoleCache(role.guild);
    console.log(`[cache:${role.guild.name}] role cache invalidated after role delete: ${role.name}`);

    try {
        const auditEntry = await findRecentHumanAuditEntry(
            role.guild,
            AuditLogEvent.RoleDelete,
            role.id
        );

        if (!auditEntry) {
            return;
        }

        await postModLog(role.guild, 'Role Deleted', [
            {
                name: 'Role',
                value: `${role.name} (${role.id})`
            },
            {
                name: 'Executor',
                value: auditEntry?.executor ? formatUser(auditEntry.executor) : 'Unknown'
            },
            {
                name: 'Reason',
                value: auditEntry?.reason || 'No reason provided'
            }
        ]);
    } catch (error) {
        console.error('Could not log role delete:');
        console.error(error);
    }
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    if (newMember.user.bot) {
        return;
    }

    try {
        const { staffRoles } = await ensureStaffRoles(newMember.guild);
        const staffRoleChanged = [...staffRoles.values()].some(role => {
            return oldMember.roles.cache.has(role.id) !== newMember.roles.cache.has(role.id);
        });

        if (staffRoleChanged) {
            await syncMemberStaffRankFromRoles(sql, newMember, staffRoles);
        }
    } catch (error) {
        console.error(`Could not sync Staff rank for ${newMember.user.tag}:`);
        console.error(error);
    }

    try {
        await logTimeoutChanges(oldMember, newMember);
    } catch (error) {
        console.error(`Could not log member moderation change for ${newMember.user.tag}:`);
        console.error(error);
    }

    try {
        await logMemberRoleChanges(oldMember, newMember);
    } catch (error) {
        console.error(`Could not log member role change for ${newMember.user.tag}:`);
        console.error(error);
    }
});

client.on(Events.ChannelCreate, async channel => {
    try {
        await logChannelCreate(channel);
    } catch (error) {
        console.error('Could not log channel create:');
        console.error(error);
    }
});

client.on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
    try {
        await logChannelUpdate(oldChannel, newChannel);
    } catch (error) {
        console.error('Could not log channel update:');
        console.error(error);
    }
});

client.on(Events.ChannelDelete, async channel => {
    try {
        await logChannelDelete(channel);
    } catch (error) {
        console.error('Could not log channel delete:');
        console.error(error);
    }
});

client.on(Events.GuildMemberRemove, async member => {
    if (!member.user.bot) {
        try {
            await removePlayerFromActiveElection(member.guild, member.user.id, member.user.id, sql, {
                removeCastVotes: true
            });
            console.log(`Removed ${member.user.tag} from active election after leaving the server.`);
        } catch (error) {
            if (!String(error.message || '').includes('There is no active election')) {
                console.error(`Could not remove leaving member ${member.user.tag} from active election:`);
                console.error(error);
            }
        }

        try {
            const removedRows = await sql`
                with leaving_player as (
                    select
                        discord_id,
                        discord_display_name,
                        discord_username,
                        rank_name
                    from players
                    where discord_id = ${member.user.id}
                        and rank_name in ('Penguin Soldier', 'Penguin Captain')
                        and not exists (
                            select 1
                            from players child
                            where child.parent_discord_id = players.discord_id
                        )
                    limit 1
                )
                delete from players
                using leaving_player
                where players.discord_id = leaving_player.discord_id
                returning
                    players.discord_display_name,
                    players.discord_username,
                    players.rank_name
            `;

            if (removedRows.length > 0) {
                const removedPlayer = removedRows[0];
                const removedName =
                    removedPlayer.discord_display_name ||
                    removedPlayer.discord_username ||
                    member.user.tag;

                console.log(
                    `Removed ${removedName} from database after leaving: ` +
                    `${removedPlayer.rank_name}, no direct recruits.`
                );

                await updateLeaderboardsForGuild(member.guild, sql).catch(error => {
                    console.error('Leaderboard refresh failed after leave cleanup:');
                    console.error(error);
                });

                await updateElectionLeaderboard(member.guild, sql).catch(error => {
                    console.error('Election leaderboard refresh failed after leave cleanup:');
                    console.error(error);
                });
            }
        } catch (error) {
            console.error(`Could not clean up leaving member ${member.user.tag} from database:`);
            console.error(error);
        }
    }

    try {
        const auditLogs = await member.guild.fetchAuditLogs({
            type: AuditLogEvent.MemberKick,
            limit: 6
        });
        const now = Date.now();
        const entry = auditLogs.entries.find(logEntry => {
            const targetMatches = logEntry.target?.id === member.user.id;
            const isRecent = now - logEntry.createdTimestamp < 15_000;

            return targetMatches && isRecent;
        });

        if (!isHumanAuditEntry(entry)) {
            return;
        }

        await postModLog(member.guild, 'Kick Added', [
            {
                name: 'Player',
                value: formatUser(member)
            },
            {
                name: 'Executor',
                value: entry.executor ? formatUser(entry.executor) : 'Unknown'
            },
            {
                name: 'Reason',
                value: entry.reason || 'No reason provided'
            }
        ]);
    } catch (error) {
        console.error('Could not log member kick:');
        console.error(error);
    }
});

client.on(Events.GuildBanAdd, async ban => {
    try {
        await removePlayerFromActiveElection(ban.guild, ban.user.id, ban.user.id, sql, {
            removeCastVotes: true
        });
        console.log(`Removed ${ban.user.tag} from active election after ban.`);
    } catch (error) {
        if (!String(error.message || '').includes('There is no active election')) {
            console.error(`Could not remove banned user ${ban.user.tag} from active election:`);
            console.error(error);
        }
    }

    try {
        const executor = await findRecentHumanAuditExecutor(
            ban.guild,
            AuditLogEvent.MemberBanAdd,
            ban.user.id
        );

        if (!executor) {
            return;
        }

        await postModLog(ban.guild, 'Ban Added', [
            {
                name: 'Player',
                value: formatUser(ban.user)
            },
            {
                name: 'Executor',
                value: executor ? formatUser(executor) : 'Unknown'
            },
            {
                name: 'Reason',
                value: ban.reason || 'No reason provided'
            }
        ]);
    } catch (error) {
        console.error('Could not log ban add:');
        console.error(error);
    }
});

client.on(Events.GuildBanRemove, async ban => {
    try {
        const executor = await findRecentHumanAuditExecutor(
            ban.guild,
            AuditLogEvent.MemberBanRemove,
            ban.user.id
        );

        if (!executor) {
            return;
        }

        await postModLog(ban.guild, 'Ban Removed', [
            {
                name: 'Player',
                value: formatUser(ban.user)
            },
            {
                name: 'Executor',
                value: executor ? formatUser(executor) : 'Unknown'
            }
        ]);
    } catch (error) {
        console.error('Could not log ban remove:');
        console.error(error);
    }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    try {
        await logVoiceMuteChange(oldState, newState);
        await logVoiceDisconnectChange(oldState, newState);
    } catch (error) {
        console.error('Could not log voice state update:');
        console.error(error);
    }
});

client.on(Events.MessageDelete, async message => {
    try {
        if (!message.guild) {
            return;
        }

        const auditEntry = await findRecentAuditEntry(
            message.guild,
            AuditLogEvent.MessageDelete,
            message.author?.id || null
        );

        if (auditEntry?.executor?.bot) {
            return;
        }

        const executor = auditEntry?.executor || null;

        await postModLog(message.guild, 'Message Deleted', [
            {
                name: 'Author',
                value: message.author ? formatUser(message.author) : 'Unknown or not cached'
            },
            {
                name: 'Deleted By',
                value: executor ? formatUser(executor) : 'Unknown or self'
            },
            {
                name: 'Channel',
                value: formatChannel(message.channel)
            },
            {
                name: 'Message ID',
                value: message.id
            },
            {
                name: 'Content',
                value: message.content ? truncateValue(message.content, 700) : 'Unavailable or not cached'
            }
        ]);
    } catch (error) {
        console.error('Could not log message delete:');
        console.error(error);
    }
});

client.on(Events.MessageBulkDelete, async messages => {
    try {
        const firstMessage = messages.first();

        if (!firstMessage?.guild) {
            return;
        }

        const executor = await findRecentHumanAuditExecutor(
            firstMessage.guild,
            AuditLogEvent.MessageBulkDelete
        );

        if (!executor) {
            return;
        }

        await postModLog(firstMessage.guild, 'Messages Bulk Deleted', [
            {
                name: 'Deleted By',
                value: executor ? formatUser(executor) : 'Unknown'
            },
            {
                name: 'Channel',
                value: formatChannel(firstMessage.channel)
            },
            {
                name: 'Count',
                value: messages.size
            }
        ]);
    } catch (error) {
        console.error('Could not log bulk message delete:');
        console.error(error);
    }
});

client.on(Events.InviteCreate, async invite => {
    try {
        console.log('📨 New invite created!');
        console.log(`Server: ${invite.guild.name}`);
        console.log(`Invite Code: ${invite.code}`);
        console.log(`Invite URL: https://discord.gg/${invite.code}`);
        console.log(`Created By: ${invite.inviter ? invite.inviter.tag : 'Unknown'}`);
        console.log(`Max Uses: ${invite.maxUses || 'Unlimited'}`);
        console.log(`Expires At: ${invite.expiresAt || 'Never'}`);

        const invites = await invite.guild.invites.fetch();

        client.invites.set(
            invite.guild.id,
            new Collection(invites.map(inv => [inv.code, inv.uses || 0]))
        );

        console.log(`Invite cache updated for ${invite.guild.name}. Total invites: ${invites.size}`);
    } catch (error) {
        console.error('Error handling InviteCreate:');
        console.error(error);
    }
});

client.on(Events.InviteDelete, async invite => {
    try {
        console.log('🗑️ Invite deleted!');
        console.log(`Server: ${invite.guild.name}`);
        console.log(`Invite Code: ${invite.code}`);

        const invites = await invite.guild.invites.fetch();

        client.invites.set(
            invite.guild.id,
            new Collection(invites.map(inv => [inv.code, inv.uses || 0]))
        );

        console.log(`Invite cache updated after deletion for ${invite.guild.name}. Total invites: ${invites.size}`);
    } catch (error) {
        console.error('Error handling InviteDelete:');
        console.error(error);
    }
});

let shutdownStarted = false;

async function shutdown(signal) {
    if (shutdownStarted) {
        return;
    }

    shutdownStarted = true;
    console.log(`Received ${signal}. Shutting down Penguin Mafia bot cleanly...`);

    try {
        stopMinecraftBot({
            actorTag: 'Railway/process manager',
            source: signal
        });
    } catch (error) {
        console.error('Minecraft client shutdown failed:');
        console.error(error);
    }

    try {
        client.destroy();
    } catch (error) {
        console.error('Discord client shutdown failed:');
        console.error(error);
    }

    try {
        await sql.end({ timeout: 5 });
    } catch (error) {
        console.error('Database pool shutdown failed:');
        console.error(error);
    }

    process.exit(0);
}

process.on('SIGTERM', () => {
    shutdown('SIGTERM');
});

process.on('SIGINT', () => {
    shutdown('SIGINT');
});

client.login(process.env.BOT_TOKEN);
