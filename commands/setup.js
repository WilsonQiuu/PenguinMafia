const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    DEFAULT_RANK_NAME,
    RANKS,
    STAFF_RANKS,
    ensureDatabaseSchema,
    ensureInfoChannels,
    ensureRankRoles,
    ensureStaffRoles,
    ensureTrainerRole,
    removeMemberRankRoles,
    syncMemberRankRole,
    syncMemberStaffRankFromRoles
} = require('../utils/bootstrap.js');
const {
    startOnboardingForMember
} = require('../utils/onboarding.js');
const {
    isDon: hasDonAccess
} = require('../utils/staff.js');

const ENV_CHANNEL_KEYS = [
    'PROMOTION_EVENTS_CHANNEL_ID',
    'RANK_INFO_CHANNEL_ID',
    'WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_ID',
    'DONATIONS_LEADERBOARD_CHANNEL_ID',
    'MOD_LOG_CHANNEL_ID'
];

const ROLE_ENV_KEYS = {
    'Penguin Soldier': 'PENGUIN_SOLDIER_ROLE_ID',
    'Penguin Captain': 'PENGUIN_CAPTAIN_ROLE_ID',
    'Penguin General': 'PENGUIN_GENERAL_ROLE_ID',
    'Emperor Penguin': 'EMPEROR_PENGUIN_ROLE_ID',
    'Trial Mod': 'TRIAL_MOD_ROLE_ID',
    Moderator: 'MODERATOR_ROLE_ID',
    'Sr Moderator': 'SR_MODERATOR_ROLE_ID',
    Admin: 'ADMIN_ROLE_ID',
    'Penguin Trainer': 'PENGUIN_TRAINER_ROLE_ID'
};

const ENV_ID_KEYS = [
    ...ENV_CHANNEL_KEYS,
    ...Object.values(ROLE_ENV_KEYS)
];

function updateEnvIds(idsByKey) {
    const envPath = path.join(process.cwd(), '.env');
    const envExists = fs.existsSync(envPath);
    const originalText = envExists ? fs.readFileSync(envPath, 'utf8') : '';
    const lineEnding = originalText.includes('\r\n') ? '\r\n' : '\n';
    const lines = originalText ? originalText.split(/\r?\n/) : [];
    const seenKeys = new Set();
    const updatedKeys = [];

    const updatedLines = lines.map(line => {
        const match = line.match(/^([A-Z0-9_]+)=/);

        if (!match || !ENV_ID_KEYS.includes(match[1])) {
            return line;
        }

        const key = match[1];
        seenKeys.add(key);

        if (!idsByKey[key] || line === `${key}=${idsByKey[key]}`) {
            return line;
        }

        updatedKeys.push(key);
        return `${key}=${idsByKey[key]}`;
    });

    for (const key of ENV_ID_KEYS) {
        if (!seenKeys.has(key) && idsByKey[key]) {
            updatedLines.push(`${key}=${idsByKey[key]}`);
            updatedKeys.push(key);
        }
    }

    const nextText = updatedLines.join(lineEnding);

    if (nextText !== originalText) {
        fs.writeFileSync(envPath, nextText);
    }

    for (const [key, value] of Object.entries(idsByKey)) {
        process.env[key] = value;
    }

    return {
        envPath,
        updatedKeys
    };
}

function idsFromRoles(rankRoles, staffRoles, trainerRole) {
    const ids = {};

    for (const rank of RANKS) {
        const key = ROLE_ENV_KEYS[rank.name];
        const role = rankRoles.get(rank.name);

        if (key && role) {
            ids[key] = role.id;
        }
    }

    for (const staffRank of STAFF_RANKS) {
        const key = ROLE_ENV_KEYS[staffRank.name];
        const role = staffRoles.get(staffRank.name);

        if (key && role) {
            ids[key] = role.id;
        }
    }

    if (trainerRole) {
        ids[ROLE_ENV_KEYS['Penguin Trainer']] = trainerRole.id;
    }

    return ids;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Set up or migrate the Penguin Mafia database without deleting player data.'),

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
                '❌ Only the owner can use `/setup`.'
            );
            return;
        }

        try {
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
                trainerRole,
                roleCreated: trainerRoleCreated,
                roleUpdated: trainerRoleUpdated
            } = await ensureTrainerRole(interaction.guild, roleCacheOptions);

            const {
                donationsLeaderboardChannel,
                modLogChannel,
                promotionEventsChannel,
                rankInfoChannel,
                weeklyRecruitsChannel
            } = await ensureInfoChannels(interaction.guild, rankRoles, staffRoles, sql);
            const envUpdate = updateEnvIds({
                ...idsFromRoles(rankRoles, staffRoles, trainerRole),
                PROMOTION_EVENTS_CHANNEL_ID: promotionEventsChannel.id,
                RANK_INFO_CHANNEL_ID: rankInfoChannel.id,
                WEEKLY_RECRUITS_LEADERBOARD_CHANNEL_ID: weeklyRecruitsChannel.id,
                DONATIONS_LEADERBOARD_CHANNEL_ID: donationsLeaderboardChannel.id,
                MOD_LOG_CHANNEL_ID: modLogChannel.id
            });

            const members = await interaction.guild.members.fetch();

            let addedCount = 0;
            let updatedCount = 0;
            let skippedBots = 0;
            let rankRolesAssigned = 0;
            let staffRanksSynced = 0;
            let onboardingStarted = 0;

            for (const [, member] of members) {
                if (member.user.bot) {
                    skippedBots++;
                    continue;
                }

                const isDon = hasDonAccess(member.user.id);

                const status = isDon ? 'active' : 'orphan';

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
                        ${member.displayName},
                        null,
                        null,
                        0,
                        ${DEFAULT_RANK_NAME},
                        ${status},
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

                if (rows[0].inserted) {
                    addedCount++;
                } else {
                    updatedCount++;
                }

                const staffRankName = await syncMemberStaffRankFromRoles(sql, member, staffRoles);

                if (staffRankName) {
                    staffRanksSynced++;
                }

                if (!rows[0].welcome_completed) {
                    await removeMemberRankRoles(member, rankRoles);
                    await startOnboardingForMember(member);
                    onboardingStarted++;
                    continue;
                }

                const assignedRole = await syncMemberRankRole(member, rankRoles, rows[0].rank_name);

                if (assignedRole) {
                    rankRolesAssigned++;
                }
            }

            await interaction.editReply(
                `✅ **Database setup/migration complete!**\n\n` +
                `Tables checked/migrated: **players, ranks, staff_ranks**\n` +
                `Ranks created/updated: **${RANKS.length}**\n` +
                `Staff ranks created/updated: **${STAFF_RANKS.length}**\n` +
                `Discord rank roles created: **${rolesCreated}**\n` +
                `Discord rank roles updated: **${rolesUpdated}**\n` +
                `Discord staff roles created: **${staffRolesCreated}**\n` +
                `Discord staff roles updated: **${staffRolesUpdated}**\n` +
                `Discord trainer role created: **${trainerRoleCreated ? 1 : 0}**\n` +
                `Discord trainer role updated: **${trainerRoleUpdated ? 1 : 0}**\n` +
                `Managed channels ready: ${promotionEventsChannel}, ${rankInfoChannel}, ${weeklyRecruitsChannel}, ${donationsLeaderboardChannel}, ${modLogChannel}\n` +
                `.env IDs updated: **${envUpdate.updatedKeys.length > 0 ? envUpdate.updatedKeys.join(', ') : 'already current'}**\n` +
                `${envUpdate.updatedKeys.length > 0 ? 'Restart the bot so all modules load the new IDs.\n' : ''}` +
                `New players added: **${addedCount}**\n` +
                `Existing players preserved/updated: **${updatedCount}**\n` +
                `Rank roles assigned: **${rankRolesAssigned}**\n` +
                `Staff ranks synced from Discord roles: **${staffRanksSynced}**\n` +
                `Private welcomes started: **${onboardingStarted}**\n` +
                `Bots skipped: **${skippedBots}**\n\n` +
                `Existing recruit trees, donations, Minecraft IGN, Penguin ranks, and Staff ranks were preserved.`
            );
        } catch (error) {
            logCommandError(interaction, '/setup', error);

            await interaction.editReply(
                `❌ **Setup failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
