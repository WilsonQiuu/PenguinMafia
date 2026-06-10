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
    getRankIndex
} = require('../utils/ranks.js');
const {
    isDon
} = require('../utils/staff.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('demotetrainer')
        .setDescription('Remove the Penguin Trainer side-role from a player.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player to remove Penguin Trainer from')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const playerUser = interaction.options.getUser('player');

        if (playerUser.bot) {
            await interaction.editReply('❌ Bots cannot hold Penguin Trainer.');
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
                await interaction.editReply('❌ You need Penguin General or higher to use `/demotetrainer`.');
                return;
            }

            const member = await interaction.guild.members.fetch(playerUser.id).catch(() => null);

            if (!member) {
                await interaction.editReply(`❌ ${playerUser} is not currently in this server.`);
                return;
            }

            const { trainerRole } = await ensureTrainerRole(interaction.guild);

            if (!member.roles.cache.has(trainerRole.id)) {
                await interaction.editReply(`❌ ${playerUser} does not have the ${TRAINER_ROLE_NAME} role.`);
                return;
            }

            await member.roles.remove(trainerRole, 'Penguin Mafia Trainer demotion');

            await interaction.editReply(
                `✅ **Trainer role removed.**\n\n` +
                `${playerUser} no longer has **${TRAINER_ROLE_NAME}**. Their normal Penguin rank was not changed.`
            );
        } catch (error) {
            logCommandError(interaction, '/demotetrainer', error);
            await interaction.editReply(
                `❌ **Trainer demotion failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
