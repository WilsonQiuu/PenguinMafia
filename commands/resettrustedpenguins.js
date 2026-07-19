const {
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder
} = require('discord.js');

const sql = require('../db.js');
const {
    STAFF_ROLE_IDS
} = require('../utils/bootstrap.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    formatUser,
    postModLog
} = require('../utils/modlogs.js');
const {
    isDon
} = require('../utils/staff.js');
const {
    TRUSTED_PENGUIN_ROLE_ID,
    confirmAction
} = require('../utils/trust.js');

async function fetchTrustedRole(guild) {
    return guild.roles.cache.get(TRUSTED_PENGUIN_ROLE_ID) ||
        await guild.roles.fetch(TRUSTED_PENGUIN_ROLE_ID).catch(() => null);
}

function isAlwaysTrustedAdmin(member) {
    const adminRoleId = STAFF_ROLE_IDS.get('Admin');

    return member.id === process.env.DON_DISCORD_ID ||
        Boolean(adminRoleId && member.roles.cache.has(adminRoleId));
}

async function syncTrustedRolesAfterReset(guild, trustedRole) {
    const members = await guild.members.fetch();
    const result = {
        checked: 0,
        removed: 0,
        addedAdmins: 0,
        keptAdmins: 0,
        failed: 0
    };

    for (const [, member] of members) {
        result.checked++;

        try {
            const shouldAlwaysHaveRole = isAlwaysTrustedAdmin(member);
            const hasRole = member.roles.cache.has(trustedRole.id);

            if (shouldAlwaysHaveRole) {
                if (hasRole) {
                    result.keptAdmins++;
                    continue;
                }

                await member.roles.add(trustedRole, 'Penguin Mafia trusted reset: Admins are always Trusted Penguins');
                result.addedAdmins++;
                continue;
            }

            if (hasRole) {
                await member.roles.remove(trustedRole, 'Penguin Mafia trusted reset cleared vouches');
                result.removed++;
            }
        } catch (error) {
            result.failed++;
            console.error(`Could not sync Trusted Penguin role for ${member.user?.tag || member.id}:`);
            console.error(error);
        }
    }

    return result;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('resettrustedpenguins')
        .setDescription('Reset all vouches and Trusted Penguin roles. Vetos stay. Don only.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        if (!process.env.DON_DISCORD_ID) {
            await interaction.editReply('❌ DON_DISCORD_ID is missing from your `.env` file.');
            return;
        }

        if (!isDon(interaction.user.id)) {
            await interaction.editReply('❌ Only the Don can use `/resettrustedpenguins`.');
            return;
        }

        try {
            const trustedRole = await fetchTrustedRole(interaction.guild);

            if (!trustedRole) {
                await interaction.editReply(`❌ Trusted Penguin role ID \`${TRUSTED_PENGUIN_ROLE_ID}\` was not found.`);
                return;
            }

            const confirmation = await confirmAction(interaction, {
                customIdPrefix: 'resettrustedpenguins',
                confirmLabel: 'Reset Trusted Penguins',
                danger: true,
                content:
                    `⚠️ **Reset Trusted Penguins?**\n\n` +
                    `This will:\n` +
                    `• Delete **all regular vouches**\n` +
                    `• Delete **all Admin vouches**\n` +
                    `• Set every player's vouch counters to **0**\n` +
                    `• Remove <@&${TRUSTED_PENGUIN_ROLE_ID}> from everyone except Staff Admins and the Don\n` +
                    `• Add/keep <@&${TRUSTED_PENGUIN_ROLE_ID}> for Staff Admins and the Don\n\n` +
                    `This will **not** delete or reset any vetoes.`,
                confirmedContent: '⏳ Resetting vouches and syncing Trusted Penguin roles...',
                cancelContent: '❌ Trusted Penguin reset cancelled.',
                expiredContent: '⏰ Trusted Penguin reset confirmation expired.'
            });

            if (!confirmation.confirmed) {
                return;
            }

            const resetRows = await sql`
                with regular_deleted as (
                    delete from player_vouches
                    returning target_discord_id
                ),
                admin_deleted as (
                    delete from player_admin_vouches
                    returning target_discord_id
                ),
                reset_players as (
                    update players
                    set
                        vouches = 0,
                        admin_vouches = 0,
                        updated_at = now()
                    where vouches <> 0
                        or admin_vouches <> 0
                    returning discord_id
                )
                select
                    (select count(*)::int from regular_deleted) as regular_vouches_deleted,
                    (select count(*)::int from admin_deleted) as admin_vouches_deleted,
                    (select count(*)::int from reset_players) as players_reset
            `;
            const reset = resetRows[0] || {
                regular_vouches_deleted: 0,
                admin_vouches_deleted: 0,
                players_reset: 0
            };
            const roleSync = await syncTrustedRolesAfterReset(interaction.guild, trustedRole);

            await postModLog(interaction.guild, 'Trusted Penguins Reset', [
                {
                    name: 'Command',
                    value: '/resettrustedpenguins'
                },
                {
                    name: 'Actor',
                    value: formatUser(interaction.user)
                },
                {
                    name: 'Regular Vouches Deleted',
                    value: String(reset.regular_vouches_deleted)
                },
                {
                    name: 'Admin Vouches Deleted',
                    value: String(reset.admin_vouches_deleted)
                },
                {
                    name: 'Players Reset',
                    value: String(reset.players_reset)
                },
                {
                    name: 'Trusted Role Removed',
                    value: String(roleSync.removed)
                },
                {
                    name: 'Admins Added/Kept',
                    value: `${roleSync.addedAdmins} added, ${roleSync.keptAdmins} already had it`
                },
                {
                    name: 'Vetoes',
                    value: 'Not reset'
                },
                {
                    name: 'Role Sync Failures',
                    value: String(roleSync.failed)
                }
            ]).catch(error => {
                console.error('Could not log trusted reset:');
                console.error(error);
            });

            await interaction.editReply(
                `✅ **Trusted Penguins reset.**\n\n` +
                `Regular vouches deleted: **${reset.regular_vouches_deleted}**\n` +
                `Admin vouches deleted: **${reset.admin_vouches_deleted}**\n` +
                `Players with vouch counters reset: **${reset.players_reset}**\n` +
                `Trusted Penguin roles removed from non-admins: **${roleSync.removed}**\n` +
                `Admins/Don given Trusted Penguin: **${roleSync.addedAdmins}**\n` +
                `Admins/Don already trusted: **${roleSync.keptAdmins}**\n` +
                `Role sync failures: **${roleSync.failed}**\n\n` +
                `Vetos were **not** reset.`
            );
        } catch (error) {
            logCommandError(interaction, '/resettrustedpenguins', error);
            await interaction.editReply(
                `❌ **Trusted Penguin reset failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
