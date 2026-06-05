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
    invalidateGuildRoleCache,
    removeMemberRankRoles,
    syncMemberRankRole,
    syncMemberStaffRankFromRoles
} = require('./utils/bootstrap.js');
const {
    updateLeaderboardsForGuild
} = require('./utils/leaderboards.js');
const {
    postFirstRecruitEvent
} = require('./utils/events.js');
const {
    handleWelcomeButton,
    handleWelcomeModal,
    startOnboardingForMember
} = require('./utils/onboarding.js');
const {
    handleTrialModButton
} = require('./utils/trialModOnboarding.js');
const {
    formatChannel,
    formatUser,
    postModLog,
    truncateValue
} = require('./utils/modlogs.js');

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
    AuditLogEvent
} = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
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

    await ensureInfoChannels(guild, rankRoles, staffRoles);
    logStartupStep('managed channels ready');

    console.log(
        `Startup setup complete for ${guild.name}: ` +
        `roles created=${rolesCreated}, roles updated=${rolesUpdated}, ` +
        `staff roles created=${staffRolesCreated}, staff roles updated=${staffRolesUpdated}. ` +
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
                channelCache: await getStartupChannelCache()
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

    console.log(
        `Startup sync complete for ${guild.name}: ` +
        `roles created=${rolesCreated}, roles updated=${rolesUpdated}, ` +
        `staff roles created=${staffRolesCreated}, staff roles updated=${staffRolesUpdated}, ` +
        `players added=${addedCount}, players updated=${updatedCount}, ` +
        `rank roles assigned=${rankRolesAssigned}, staff ranks synced=${staffRanksSynced}, onboarding started=${onboardingStarted}, ` +
        `bots skipped=${skippedBots}, member sync failures=${failedMemberSyncs}.`
    );
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
        `;

        if (!channelCache) {
            channelCache = await guild.channels.fetch();
        }

        await startOnboardingForMember(member, {
            channelCache
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
                inviterDisplayName,
                welcomeCompleted
            } = await saveMemberWithParent(guild, member, inviter);

            if (welcomeCompleted) {
                await syncMemberRoleFromDatabase(member);
            } else {
                await startOnboardingForMember(member, {
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

async function findRecentAuditExecutor(guild, type, targetId = null) {
    try {
        const auditLogs = await guild.fetchAuditLogs({
            type,
            limit: 6
        });
        const now = Date.now();

        const entry = auditLogs.entries.find(logEntry => {
            const targetMatches = !targetId || logEntry.target?.id === targetId;
            const isRecent = now - logEntry.createdTimestamp < 15_000;

            return targetMatches && isRecent;
        });

        return entry?.executor || null;
    } catch (error) {
        return null;
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

async function logTimeoutChanges(oldMember, newMember) {
    const oldTimeout = oldMember.communicationDisabledUntilTimestamp || null;
    const newTimeout = newMember.communicationDisabledUntilTimestamp || null;

    if (oldTimeout === newTimeout) {
        return;
    }

    const auditEntry = await findRecentAuditEntry(
        newMember.guild,
        AuditLogEvent.MemberUpdate,
        newMember.user.id
    );
    const title = newTimeout
        ? oldTimeout ? 'Timeout Updated' : 'Timeout Applied'
        : 'Timeout Removed';

    await postModLog(newMember.guild, title, [
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
            value: auditEntry?.reason || 'No reason provided'
        }
    ]);
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

    const executor = await findRecentAuditExecutor(
        newState.guild,
        AuditLogEvent.MemberUpdate,
        member.user.id
    );

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

    await deployCommands();
    logReadyStep('slash commands deployed');

    console.log('Commands deployed!');

    await updateAllLeaderboards();
    logReadyStep('leaderboards refreshed');

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
});

client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isButton()) {
        try {
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
            const handled = await handleWelcomeModal(interaction);
            if (handled) return;
        } catch (error) {
            logCommandError(interaction, 'welcome modal', error);

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

client.on(Events.GuildRoleCreate, role => {
    invalidateGuildRoleCache(role.guild);
    console.log(`[cache:${role.guild.name}] role cache invalidated after role create: ${role.name}`);
});

client.on(Events.GuildRoleUpdate, (oldRole, newRole) => {
    invalidateGuildRoleCache(newRole.guild);
    console.log(`[cache:${newRole.guild.name}] role cache invalidated after role update: ${oldRole.name} -> ${newRole.name}`);
});

client.on(Events.GuildRoleDelete, role => {
    invalidateGuildRoleCache(role.guild);
    console.log(`[cache:${role.guild.name}] role cache invalidated after role delete: ${role.name}`);
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
});

client.on(Events.GuildMemberRemove, async member => {
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

        if (!entry) {
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
        const executor = await findRecentAuditExecutor(
            ban.guild,
            AuditLogEvent.MemberBanAdd,
            ban.user.id
        );

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
        const executor = await findRecentAuditExecutor(
            ban.guild,
            AuditLogEvent.MemberBanRemove,
            ban.user.id
        );

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

        const executor = await findRecentAuditExecutor(
            message.guild,
            AuditLogEvent.MessageDelete,
            message.author?.id || null
        );

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

        const executor = await findRecentAuditExecutor(
            firstMessage.guild,
            AuditLogEvent.MessageBulkDelete
        );

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

client.login(process.env.BOT_TOKEN);
