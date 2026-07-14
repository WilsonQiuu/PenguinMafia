const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    isDon
} = require('../utils/staff.js');

function playerName(player, fallback = 'Unknown Player') {
    return player?.minecraft_ign ||
        player?.discord_display_name ||
        player?.discord_username ||
        fallback;
}

function recruiterLine(label, recruiterId, recruiter, fallback = 'None recorded') {
    if (!recruiterId) {
        return `${label}: \`${fallback}\``;
    }

    return `${label}: <@${recruiterId}> \`${playerName(recruiter, recruiterId)}\``;
}

function timestampLine(label, value) {
    if (!value) {
        return `${label}: \`None recorded\``;
    }

    const timestamp = Math.floor(new Date(value).getTime() / 1000);
    return `${label}: <t:${timestamp}:f> (<t:${timestamp}:R>)`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('originalrecruiter')
        .setDescription('Check a player\'s original recruiter before any transfers. Don only.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player to audit')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        if (!isDon(interaction.user.id)) {
            await interaction.editReply('❌ Only the Don can use `/originalrecruiter`.');
            return;
        }

        const playerUser = interaction.options.getUser('player');

        try {
            const rows = await sql`
                select
                    player.discord_id,
                    player.discord_username,
                    player.discord_display_name,
                    player.minecraft_ign,
                    player.parent_discord_id,
                    player.joined_via_inviter_discord_id,
                    player.joined_invite_code,
                    player.transferred_at,
                    current_parent.discord_username as current_parent_username,
                    current_parent.discord_display_name as current_parent_display_name,
                    current_parent.minecraft_ign as current_parent_minecraft_ign,
                    original_history.recruiter_discord_id as original_recruiter_discord_id,
                    original_history.recruited_at as original_recruited_at,
                    original_parent.discord_username as original_parent_username,
                    original_parent.discord_display_name as original_parent_display_name,
                    original_parent.minecraft_ign as original_parent_minecraft_ign,
                    invite_parent.discord_username as invite_parent_username,
                    invite_parent.discord_display_name as invite_parent_display_name,
                    invite_parent.minecraft_ign as invite_parent_minecraft_ign
                from players player
                left join players current_parent
                    on current_parent.discord_id = player.parent_discord_id
                left join recruit_history original_history
                    on original_history.recruit_discord_id = player.discord_id
                left join players original_parent
                    on original_parent.discord_id = original_history.recruiter_discord_id
                left join players invite_parent
                    on invite_parent.discord_id = player.joined_via_inviter_discord_id
                where player.discord_id = ${playerUser.id}
                limit 1
            `;

            const player = rows[0];

            if (!player) {
                await interaction.editReply(`${playerUser} is not in the database yet.`);
                return;
            }

            const currentRecruiter = {
                discord_username: player.current_parent_username,
                discord_display_name: player.current_parent_display_name,
                minecraft_ign: player.current_parent_minecraft_ign
            };
            const originalRecruiter = {
                discord_username: player.original_parent_username,
                discord_display_name: player.original_parent_display_name,
                minecraft_ign: player.original_parent_minecraft_ign
            };
            const inviteRecruiter = {
                discord_username: player.invite_parent_username,
                discord_display_name: player.invite_parent_display_name,
                minecraft_ign: player.invite_parent_minecraft_ign
            };

            const originalId = player.original_recruiter_discord_id;
            const currentId = player.parent_discord_id;
            const transferStatus = originalId
                ? (currentId === originalId ? 'No' : 'Yes')
                : 'Unknown';

            await interaction.editReply(
                `🧾 **Recruiter Audit: ${playerName(player, playerUser.username)}**\n\n` +
                `Player: ${playerUser} \`${player.discord_id}\`\n` +
                `${recruiterLine('Current recruiter', currentId, currentRecruiter, 'None / Orphan')}\n` +
                `${recruiterLine('Original recruiter', originalId, originalRecruiter)}\n` +
                `${timestampLine('Original recruited at', player.original_recruited_at)}\n` +
                `${recruiterLine('Invite-detected recruiter', player.joined_via_inviter_discord_id, inviteRecruiter)}\n` +
                `Joined invite code: \`${player.joined_invite_code || 'None recorded'}\`\n` +
                `${timestampLine('First recruiter update recorded at', player.transferred_at)}\n` +
                `Transferred from original: **${transferStatus}**`
            );
        } catch (error) {
            logCommandError(interaction, '/originalrecruiter', error);

            await interaction.editReply(
                `❌ **Original recruiter lookup failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
