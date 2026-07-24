const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    DEFAULT_RANK_NAME
} = require('../utils/bootstrap.js');
const {
    isDon
} = require('../utils/staff.js');

function playerName(player) {
    return player.discord_display_name ||
        player.discord_username ||
        player.discord_id;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('claimall')
        .setDescription('Make every orphaned Penguin recruit belong to the owner. Owner only.'),

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

        if (!isDon(interaction.user.id)) {
            await interaction.editReply(
                '❌ Only the owner can use `/claimall`.'
            );
            return;
        }

        const donDisplayName =
            interaction.member?.displayName ||
            interaction.user.globalName ||
            interaction.user.username;

        try {
            const claimedPlayers = await sql.begin(async transaction => {
                await transaction`
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
                        ${donDiscordId},
                        ${interaction.user.username},
                        ${donDisplayName},
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
                        parent_discord_id = null,
                        status = 'active',
                        updated_at = now()
                `;

                await transaction`
                    insert into recruit_history (
                        recruit_discord_id,
                        recruiter_discord_id,
                        recruited_at,
                        counts_for_hourly
                    )
                    select
                        discord_id,
                        ${donDiscordId},
                        created_at,
                        false
                    from players
                    where parent_discord_id is null
                        and discord_id <> ${donDiscordId}
                    on conflict (recruit_discord_id) do nothing
                `;

                const updatedRows = await transaction`
                    update players
                    set
                        parent_discord_id = ${donDiscordId},
                        status = 'active',
                        updated_at = now()
                    where parent_discord_id is null
                        and discord_id <> ${donDiscordId}
                    returning
                        discord_id,
                        discord_username,
                        discord_display_name
                `;

                if (updatedRows.length > 0) {
                    await transaction`
                        update players
                        set
                            weekly_direct_recruits_count = greatest(weekly_direct_recruits_count - ${updatedRows.length}, 0),
                            updated_at = now()
                        where discord_id = ${donDiscordId}
                    `;
                }

                return updatedRows;
            });

            if (claimedPlayers.length === 0) {
                await interaction.editReply(
                    '✅ There are no orphaned Penguins to claim right now.'
                );
                return;
            }

            const preview = claimedPlayers
                .slice(0, 10)
                .map(player => `- ${playerName(player)}`)
                .join('\n');
            const remainingCount = claimedPlayers.length - 10;
            const remainingText = remainingCount > 0
                ? `\n...and **${remainingCount}** more.`
                : '';

            await interaction.editReply(
                `✅ **Claim all complete.**\n\n` +
                `Recruiter: <@${donDiscordId}>\n` +
                `Orphaned Penguins claimed: **${claimedPlayers.length}**\n\n` +
                `${preview}${remainingText}\n\n` +
                `Weekly recruit counts were left unchanged.`
            );
        } catch (error) {
            logCommandError(interaction, '/claimall', error);

            await interaction.editReply(
                `❌ **Claim all failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
