const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    scheduleLeaderboardsRefreshForGuild
} = require('../utils/leaderboards.js');
const {
    postBranchMilestoneEvents,
    postFirstRecruitEvent
} = require('../utils/events.js');
const {
    canRecruiterTakeRecruit
} = require('../utils/ranks.js');

const DEFAULT_RANK_NAME = 'Penguin Soldier';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('join')
        .setDescription('Join under a recruiter if you are orphaned.')
        .addUserOption(option =>
            option
                .setName('recruiter')
                .setDescription('The recruiter you want to join under')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const childUser = interaction.user;
        const parentUser = interaction.options.getUser('recruiter');
        const parentMember = interaction.options.getMember('recruiter');

        if (parentUser.bot) {
            await interaction.editReply('❌ You cannot join under a bot.');
            return;
        }

        if (childUser.id === parentUser.id) {
            await interaction.editReply('❌ You cannot become your own recruiter.');
            return;
        }

        const childDisplayName =
            interaction.member?.displayName ||
            childUser.globalName ||
            childUser.username;

        const parentDisplayName =
            parentMember?.displayName ||
            parentUser.globalName ||
            parentUser.username;

        try {
            await sql.begin(async sql => {
                // Make sure recruiter exists in database
                await sql`
                    insert into players (
                        discord_id,
                        discord_username,
                        discord_display_name,
                        minecraft_ign,
                        parent_discord_id,
                        claims_available,
                        rank_name,
                        status
                    )
                    values (
                        ${parentUser.id},
                        ${parentUser.username},
                        ${parentDisplayName},
                        null,
                        null,
                        0,
                        ${DEFAULT_RANK_NAME},
                        'active'
                    )
                    on conflict (discord_id) do update
                    set
                        discord_username = excluded.discord_username,
                        discord_display_name = excluded.discord_display_name,
                        updated_at = now()
                `;

                // Make sure recruit exists in database
                await sql`
                    insert into players (
                        discord_id,
                        discord_username,
                        discord_display_name,
                        minecraft_ign,
                        parent_discord_id,
                        claims_available,
                        rank_name,
                        status
                    )
                    values (
                        ${childUser.id},
                        ${childUser.username},
                        ${childDisplayName},
                        null,
                        null,
                        0,
                        ${DEFAULT_RANK_NAME},
                        'orphan'
                    )
                    on conflict (discord_id) do update
                    set
                        discord_username = excluded.discord_username,
                        discord_display_name = excluded.discord_display_name,
                        updated_at = now()
                `;

                const childRows = await sql`
                    select parent_discord_id, status
                    from players
                    where discord_id = ${childUser.id}
                    for update
                `;

                const childData = childRows[0];

                if (!childData) {
                    throw new Error('You were not found in the database.');
                }

                if (childData.parent_discord_id !== null) {
                    throw new Error('You already have a recruiter. Ask the Don to use /give if this needs to change.');
                }

                const rankRows = await sql`
                    select
                        recruiter.rank_name as recruiter_rank_name,
                        recruit.rank_name as recruit_rank_name
                    from players recruiter
                    cross join players recruit
                    where recruiter.discord_id = ${parentUser.id}
                        and recruit.discord_id = ${childUser.id}
                    limit 1
                `;

                const ranks = rankRows[0];

                if (!ranks) {
                    throw new Error('Could not verify recruiter/recruit ranks.');
                }

                if (!canRecruiterTakeRecruit(ranks.recruiter_rank_name, ranks.recruit_rank_name)) {
                    throw new Error(
                        `You cannot join under ${parentUser} because they are \`${ranks.recruiter_rank_name}\` ` +
                        `and you are \`${ranks.recruit_rank_name}\`. ` +
                        `Your recruiter must be the same rank or higher than you.`
                    );
                }

                await sql`
                    update players
                    set
                        parent_discord_id = ${parentUser.id},
                        status = 'active',
                        updated_at = now()
                    where discord_id = ${childUser.id}
                `;
            });

            await interaction.editReply(
                `✅ **Join successful!**\n\n` +
                `${childUser} is now a recruit of ${parentUser}.`
            );

            scheduleLeaderboardsRefreshForGuild(interaction.guild, sql);

            await postFirstRecruitEvent(interaction.guild, sql, {
                recruiterId: parentUser.id,
                recruitId: childUser.id
            }).catch(error => {
                console.error('First recruit promotion event failed after /join:');
                console.error(error);
                return false;
            });

            await postBranchMilestoneEvents(interaction.guild, sql, parentUser.id).catch(error => {
                console.error('Branch milestone event failed after /join:');
                console.error(error);
                return [];
            });
        } catch (error) {
            logCommandError(interaction, '/join', error);

            await interaction.editReply(
                `❌ **Join failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
