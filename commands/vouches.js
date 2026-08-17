const {
    MessageFlags,
    SlashCommandBuilder
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    ICEBERG_ADMIN_VOUCHES_REQUIRED,
    ICEBERG_TOTAL_VOUCHES_REQUIRED,
    getTrustProfile,
    isIcebergEligible,
    playerName,
    trustSummary
} = require('../utils/trust.js');
const {
    getStaffProfile,
    isDon,
    syncInvokerStaffRank
} = require('../utils/staff.js');

function receiptName(row) {
    return row.discord_display_name ||
        row.discord_username ||
        row.actor_discord_id;
}

function formatReceiptList(rows, emptyText) {
    if (rows.length === 0) {
        return emptyText;
    }

    return rows.map((row, index) => {
        const timestamp = row.created_at
            ? ` — <t:${Math.floor(new Date(row.created_at).getTime() / 1000)}:R>`
            : '';

        return `${index + 1}. <@${row.actor_discord_id}> — **${receiptName(row)}**${timestamp}`;
    }).join('\n');
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('vouches')
        .setDescription('Check a player’s Admin vouches and vetoes.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player to check')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const targetUser = interaction.options.getUser('player');

        try {
            const target = await getTrustProfile(sql, targetUser.id);

            if (!target) {
                await interaction.editReply(
                    `❌ ${targetUser} is not in the database yet.`
                );
                return;
            }

            // Veto sources are staff-only. Anyone else sees the count but
            // never who vetoed.
            await syncInvokerStaffRank(sql, interaction.member);
            const invokerStaff = await getStaffProfile(sql, interaction.user.id);
            const isAdminViewer =
                isDon(interaction.user.id) ||
                invokerStaff?.staff_rank_name === 'Admin';

            const [regularVouchRows, adminVouchRows, vetoRows] = await Promise.all([
                sql`
                    select
                        receipt.voucher_discord_id as actor_discord_id,
                        receipt.created_at,
                        actor.discord_username,
                        actor.discord_display_name
                    from player_vouches receipt
                    left join players actor
                        on actor.discord_id = receipt.voucher_discord_id
                    where receipt.target_discord_id = ${targetUser.id}
                    order by receipt.created_at asc
                `,
                sql`
                    select
                        receipt.admin_discord_id as actor_discord_id,
                        receipt.created_at,
                        actor.discord_username,
                        actor.discord_display_name
                    from player_admin_vouches receipt
                    left join players actor
                        on actor.discord_id = receipt.admin_discord_id
                    where receipt.target_discord_id = ${targetUser.id}
                    order by receipt.created_at asc
                `,
                sql`
                    select
                        receipt.admin_discord_id as actor_discord_id,
                        receipt.created_at,
                        actor.discord_username,
                        actor.discord_display_name
                    from player_admin_vetoes receipt
                    left join players actor
                        on actor.discord_id = receipt.admin_discord_id
                    where receipt.target_discord_id = ${targetUser.id}
                    order by receipt.created_at asc
                `
            ]);

            const adminVouches = Number(target.admin_vouches || 0);
            const totalVouches = Number(target.vouches || 0);
            const adminVetoes = Number(target.admin_vetoes || 0);

            let icebergStatus;

            if (target.staff_rank_name === 'Admin') {
                icebergStatus = 'Staff Admin — always Iceberg Penguin';
            } else if (adminVetoes > 0) {
                icebergStatus = 'Blocked by active Admin veto';
            } else if (isIcebergEligible(target)) {
                icebergStatus = 'Eligible / should have Iceberg Penguin';
            } else {
                const needsAdmin = Math.max(ICEBERG_ADMIN_VOUCHES_REQUIRED - adminVouches, 0);
                const needsTotal = Math.max(ICEBERG_TOTAL_VOUCHES_REQUIRED - totalVouches, 0);
                const parts = [];

                if (needsAdmin > 0) {
                    parts.push(`${needsAdmin} more Admin vouch${needsAdmin === 1 ? '' : 'es'}`);
                }

                if (needsTotal > 0) {
                    parts.push(`${needsTotal} more total vouch${needsTotal === 1 ? '' : 'es'}`);
                }

                icebergStatus = `Needs ${parts.join(' and ')}`;
            }

            const vetoSection = isAdminViewer
                ? formatReceiptList(vetoRows, 'No Admin vetoes active.')
                : vetoRows.length === 0
                    ? 'No Admin vetoes active.'
                    : `🔒 **${vetoRows.length}** active Admin veto${vetoRows.length === 1 ? '' : 'es'} — sources are only visible to staff.`;

            await interaction.editReply(
                `**Vouches for ${playerName(target, targetUser.username)}** ${targetUser}\n\n` +
                `${trustSummary(target)}\n` +
                `Iceberg Penguin status: **${icebergStatus}**\n\n` +
                `**Admin vouches**\n` +
                `${formatReceiptList(adminVouchRows, 'No Admin vouches yet.')}\n\n` +
                `**Regular vouches**\n` +
                `${formatReceiptList(regularVouchRows, 'No regular vouches yet.')}\n\n` +
                `**Admin vetoes**\n` +
                `${vetoSection}`
            );
        } catch (error) {
            logCommandError(interaction, '/vouches', error);

            await interaction.editReply(
                `❌ **Vouches lookup failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
