const {
    MessageFlags,
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
    ICEBERG_PENGUIN_ROLE_ID,
    confirmAction
} = require('../utils/trust.js');

async function fetchIcebergRole(guild) {
    return guild.roles.cache.get(ICEBERG_PENGUIN_ROLE_ID) ||
        await guild.roles.fetch(ICEBERG_PENGUIN_ROLE_ID).catch(() => null);
}

function isAlwaysIcebergAdmin(member) {
    const adminRoleId = STAFF_ROLE_IDS.get('Admin');

    return isDon(member.id) ||
        Boolean(adminRoleId && member.roles.cache.has(adminRoleId));
}

async function syncIcebergRolesAfterReset(guild, icebergRole) {
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
            const shouldAlwaysHaveRole = isAlwaysIcebergAdmin(member);
            const hasRole = member.roles.cache.has(icebergRole.id);

            if (shouldAlwaysHaveRole) {
                if (hasRole) {
                    result.keptAdmins++;
                    continue;
                }

                await member.roles.add(icebergRole, 'Penguin Mafia iceberg reset: Admins are always Iceberg Penguins');
                result.addedAdmins++;
                continue;
            }

            if (hasRole) {
                await member.roles.remove(icebergRole, 'Penguin Mafia iceberg reset cleared vouches');
                result.removed++;
            }
        } catch (error) {
            result.failed++;
            console.error(`Could not sync Iceberg Penguin role for ${member.user?.tag || member.id}:`);
            console.error(error);
        }
    }

    return result;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reseticebergpenguins')
        .setDescription('Reset all vouches and Iceberg Penguin roles. Vetos stay. Owner only.'),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        if (!process.env.DON_DISCORD_ID) {
            await interaction.editReply('❌ DON_DISCORD_ID is missing from your `.env` file.');
            return;
        }

        if (!isDon(interaction.user.id)) {
            await interaction.editReply('❌ Only the owner can use `/reseticebergpenguins`.');
            return;
        }

        try {
            const icebergRole = await fetchIcebergRole(interaction.guild);

            if (!icebergRole) {
                await interaction.editReply(`❌ Iceberg Penguin role ID \`${ICEBERG_PENGUIN_ROLE_ID}\` was not found.`);
                return;
            }

            const confirmation = await confirmAction(interaction, {
                customIdPrefix: 'reseticebergpenguins',
                confirmLabel: 'Reset Iceberg Penguins',
                danger: true,
                content:
                    `⚠️ **Reset Iceberg Penguins?**\n\n` +
                    `This will:\n` +
                    `• Delete **all regular vouches**\n` +
                    `• Delete **all Admin vouches**\n` +
                    `• Set every player's vouch counters to **0**\n` +
                    `• Remove <@&${ICEBERG_PENGUIN_ROLE_ID}> from everyone except Staff Admins and the Don\n` +
                    `• Add/keep <@&${ICEBERG_PENGUIN_ROLE_ID}> for Staff Admins and the Don\n\n` +
                    `This will **not** delete or reset any vetoes.`,
                confirmedContent: '⏳ Resetting vouches and syncing Iceberg Penguin roles...',
                cancelContent: '❌ Iceberg Penguin reset cancelled.',
                expiredContent: '⏰ Iceberg Penguin reset confirmation expired.'
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
            const roleSync = await syncIcebergRolesAfterReset(interaction.guild, icebergRole);

            await postModLog(interaction.guild, 'Iceberg Penguins Reset', [
                {
                    name: 'Command',
                    value: '/reseticebergpenguins'
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
                    name: 'Iceberg Role Removed',
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
                console.error('Could not log iceberg reset:');
                console.error(error);
            });

            await interaction.editReply(
                `✅ **Iceberg Penguins reset.**\n\n` +
                `Regular vouches deleted: **${reset.regular_vouches_deleted}**\n` +
                `Admin vouches deleted: **${reset.admin_vouches_deleted}**\n` +
                `Players with vouch counters reset: **${reset.players_reset}**\n` +
                `Iceberg Penguin roles removed from non-admins: **${roleSync.removed}**\n` +
                `Admins/Don given Iceberg Penguin: **${roleSync.addedAdmins}**\n` +
                `Admins/Don already Iceberg Penguins: **${roleSync.keptAdmins}**\n` +
                `Role sync failures: **${roleSync.failed}**\n\n` +
                `Vetos were **not** reset.`
            );
        } catch (error) {
            logCommandError(interaction, '/reseticebergpenguins', error);
            await interaction.editReply(
                `❌ **Iceberg Penguin reset failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
