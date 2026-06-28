const {
    MessageFlags,
    SlashCommandBuilder
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    TRUSTED_ADMIN_VOUCHES_REQUIRED,
    getTrustProfile,
    playerName,
    trustSummary
} = require('../utils/trust.js');

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

            const trustedStatus = Number(target.admin_vouches || 0) >= TRUSTED_ADMIN_VOUCHES_REQUIRED &&
                Number(target.admin_vetoes || 0) === 0
                ? 'Eligible / should have Trusted Penguin'
                : Number(target.admin_vetoes || 0) > 0
                    ? 'Blocked by active Admin veto'
                    : `Needs ${TRUSTED_ADMIN_VOUCHES_REQUIRED - Number(target.admin_vouches || 0)} more Admin vouch${TRUSTED_ADMIN_VOUCHES_REQUIRED - Number(target.admin_vouches || 0) === 1 ? '' : 'es'}`;

            await interaction.editReply(
                `**Vouches for ${playerName(target, targetUser.username)}** ${targetUser}\n\n` +
                `${trustSummary(target)}\n` +
                `Trusted Penguin status: **${trustedStatus}**\n\n` +
                `**Admin vouches**\n` +
                `${formatReceiptList(adminVouchRows, 'No Admin vouches yet.')}\n\n` +
                `**Regular vouches**\n` +
                `${formatReceiptList(regularVouchRows, 'No regular vouches yet.')}\n\n` +
                `**Admin vetoes**\n` +
                `${formatReceiptList(vetoRows, 'No Admin vetoes active.')}`
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
