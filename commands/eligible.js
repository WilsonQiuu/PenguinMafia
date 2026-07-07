const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    RANK_NAMES,
    evaluateEligibility,
    playerName
} = require('../utils/ranks.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('eligible')
        .setDescription('Check whether a player is eligible for a rank.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player to check')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('rank')
                .setDescription('The rank to check eligibility for')
                .setRequired(true)
                .addChoices(
                    { name: 'Penguin Captain', value: 'Penguin Captain' },
                    { name: 'Penguin General', value: 'Penguin General' },
                    { name: 'Emperor Penguin', value: 'Emperor Penguin' }
                )
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const playerUser = interaction.options.getUser('player');
        const targetRank = interaction.options.getString('rank');

        try {
            const playerRows = await sql`
                select
                    discord_id,
                    discord_username,
                    discord_display_name,
                    rank_name,
                    captain_direct_recruits_count
                from players
                where discord_id = ${playerUser.id}
                limit 1
            `;

            if (playerRows.length === 0) {
                await interaction.editReply(
                    `${playerUser} is not in the database yet.`
                );
                return;
            }

            const player = playerRows[0];

            const children = await sql`
                select
                    discord_id,
                    discord_username,
                    discord_display_name,
                    rank_name
                from players
                where parent_discord_id = ${playerUser.id}
                order by discord_display_name asc
            `;

            const eligibility = evaluateEligibility(children, targetRank, {
                captainDirectRecruitsCount: Number(player.captain_direct_recruits_count || 0)
            });

            if (eligibility.requirements.length === 0) {
                await interaction.editReply(
                    `❌ Unknown rank: \`${targetRank}\`.`
                );
                return;
            }

            const childRankSummary = RANK_NAMES
                .map(rank => {
                    const count = children.filter(child => child.rank_name === rank).length;
                    return `- ${rank}: **${count}**`;
                })
                .join('\n');

            await interaction.editReply(
                `${eligibility.eligible ? '✅' : '❌'} **Eligibility Check**\n\n` +
                `Player: **${playerName(player, playerUser.username)}** ${playerUser}\n` +
                `Current role: \`${player.rank_name}\`\n` +
                `Target role: \`${targetRank}\`\n\n` +
                `**Requirements**\n` +
                `${eligibility.requirements.join('\n')}\n\n` +
                `**Current Direct Recruits**\n` +
                `Total direct recruits: **${eligibility.totalChildren}**\n` +
                `${childRankSummary}\n\n` +
                `${eligibility.eligible ? 'This player is eligible.' : 'This player is not eligible yet.'}`
            );
        } catch (error) {
            logCommandError(interaction, '/eligible', error);

            await interaction.editReply(
                `❌ **Eligibility check failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
