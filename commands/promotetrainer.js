const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    TRAINER_ROLE_NAME,
    ensureTrainerRole
} = require('../utils/bootstrap.js');
const {
    getRankIndex,
    playerName
} = require('../utils/ranks.js');
const {
    isDon
} = require('../utils/staff.js');
const {
    startTrainerOnboardingForMember
} = require('../utils/trainerOnboarding.js');

async function hasCaptainInTeam(playerId) {
    const rows = await sql`
        select count(*)::int as count
        from players
        where parent_discord_id = ${playerId}
            and rank_name = 'Penguin Captain'
    `;

    return Number(rows[0]?.count || 0) >= 1;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('promotetrainer')
        .setDescription('Offer the Penguin Trainer side-role to an eligible player.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player to offer Penguin Trainer')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const playerUser = interaction.options.getUser('player');

        if (playerUser.bot) {
            await interaction.editReply('❌ Bots cannot become Penguin Trainers.');
            return;
        }

        try {
            const actorRows = await sql`
                select rank_name
                from players
                where discord_id = ${interaction.user.id}
                limit 1
            `;
            const actorRank = actorRows[0]?.rank_name;
            const actorRankIndex = getRankIndex(actorRank);
            const generalRankIndex = getRankIndex('Penguin General');

            if (!isDon(interaction.user.id) && (actorRankIndex === undefined || actorRankIndex < generalRankIndex)) {
                await interaction.editReply('❌ You need Penguin General or higher to use `/promotetrainer`.');
                return;
            }

            const member = await interaction.guild.members.fetch(playerUser.id).catch(() => null);

            if (!member) {
                await interaction.editReply(`❌ ${playerUser} is not currently in this server.`);
                return;
            }

            const playerRows = await sql`
                select
                    discord_id,
                    discord_username,
                    discord_display_name,
                    rank_name
                from players
                where discord_id = ${playerUser.id}
                limit 1
            `;
            const player = playerRows[0];

            if (!player) {
                await interaction.editReply(`❌ ${playerUser} is not in the database yet.`);
                return;
            }

            if (!isDon(interaction.user.id) && !(await hasCaptainInTeam(playerUser.id))) {
                await interaction.editReply(
                    `❌ ${playerUser} is not eligible for ${TRAINER_ROLE_NAME} yet.\n\n` +
                    `They need at least **1 Penguin Captain** directly in their team.`
                );
                return;
            }

            const { trainerRole } = await ensureTrainerRole(interaction.guild);

            if (member.roles.cache.has(trainerRole.id)) {
                await interaction.editReply(`❌ ${playerUser} already has the ${TRAINER_ROLE_NAME} role.`);
                return;
            }

            const channel = await startTrainerOnboardingForMember(member);

            await interaction.editReply(
                `✅ **Trainer offer started.**\n\n` +
                `Player: **${playerName(player, playerUser.username)}** ${playerUser}\n` +
                `Current Penguin rank: **${player.rank_name}**\n` +
                `Onboarding room: ${channel}\n\n` +
                `The ${TRAINER_ROLE_NAME} role will be added only if they accept.`
            );
        } catch (error) {
            logCommandError(interaction, '/promotetrainer', error);
            await interaction.editReply(
                `❌ **Trainer promotion failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
