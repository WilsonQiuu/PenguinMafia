const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    getStaffProfile,
    syncInvokerStaffRank
} = require('../utils/staff.js');

function playerName(player, fallback = 'Unknown Player') {
    return player?.discord_display_name ||
        player?.discord_username ||
        fallback;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('verify')
        .setDescription('Refill Staff ban points. Don only.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addUserOption(option =>
            option
                .setName('staff')
                .setDescription('The Staff member to verify/refill')
                .setRequired(true)
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

        if (interaction.user.id !== donDiscordId) {
            await interaction.editReply(
                '❌ Only the Don can use `/verify`.'
            );
            return;
        }

        const staffUser = interaction.options.getUser('staff');

        if (staffUser.bot) {
            await interaction.editReply(
                '❌ Bots cannot be verified for ban points.'
            );
            return;
        }

        try {
            const staffMember = await interaction.guild.members.fetch(staffUser.id).catch(() => null);

            if (!staffMember) {
                await interaction.editReply(
                    `❌ ${staffUser} is not currently in this server.`
                );
                return;
            }

            await syncInvokerStaffRank(sql, staffMember);
            const staff = await getStaffProfile(sql, staffUser.id);

            if (!staff) {
                await interaction.editReply(
                    `❌ ${staffUser} is not in the database yet. Run \`/setup\` first.`
                );
                return;
            }

            if (!staff.staff_rank_name) {
                await interaction.editReply(
                    `❌ ${staffUser} does not have a Staff rank.`
                );
                return;
            }

            const rows = await sql`
                update players player
                set
                    ban_points_remaining = coalesce(staff.ban_point_limit, 0),
                    updated_at = now()
                from staff_ranks staff
                where player.discord_id = ${staffUser.id}
                    and player.staff_rank_name = staff.name
                returning
                    player.discord_username,
                    player.discord_display_name,
                    player.staff_rank_name,
                    player.ban_points_remaining
            `;

            if (rows.length === 0) {
                await interaction.editReply(
                    `❌ Could not refill ban points for ${staffUser}.`
                );
                return;
            }

            const verifiedStaff = rows[0];

            await interaction.editReply(
                `✅ **Staff verified.**\n\n` +
                `Staff: **${playerName(verifiedStaff, staffUser.username)}** ${staffUser}\n` +
                `Staff rank: \`${verifiedStaff.staff_rank_name}\`\n` +
                `Ban points refilled to: **${verifiedStaff.ban_points_remaining}**`
            );
        } catch (error) {
            logCommandError(interaction, '/verify', error);

            await interaction.editReply(
                `❌ **Verify command failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
