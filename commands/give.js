const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    postFirstRecruitEvent
} = require('../utils/events.js');
const {
    canRecruiterTakeRecruit
} = require('../utils/ranks.js');

const DEFAULT_RANK_NAME = 'Penguin Soldier';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('give')
        .setDescription('Move a recruit and their tree under a new recruiter.')
        .addUserOption(option =>
            option
                .setName('recruiter')
                .setDescription('The new recruiter user')
                .setRequired(true)
        )
        .addUserOption(option =>
            option
                .setName('recruit')
                .setDescription('The recruit player user')
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

        const parentUser = interaction.options.getUser('recruiter');
        const childUser = interaction.options.getUser('recruit');
        const isDon = interaction.user.id === donDiscordId;

        const parentMember = interaction.options.getMember('recruiter');
        const childMember = interaction.options.getMember('recruit');

        if (parentUser.bot || childUser.bot) {
            await interaction.editReply(
                '❌ You cannot use bots as recruiters or recruits.'
            );
            return;
        }

        if (parentUser.id === childUser.id) {
            await interaction.editReply(
                '❌ A player cannot be their own recruiter.'
            );
            return;
        }

        const parentDisplayName =
            parentMember?.displayName ||
            parentUser.globalName ||
            parentUser.username;

        const childDisplayName =
            childMember?.displayName ||
            childUser.globalName ||
            childUser.username;

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
                        'active'
                    )
                    on conflict (discord_id) do update
                    set
                        discord_username = excluded.discord_username,
                        discord_display_name = excluded.discord_display_name,
                        updated_at = now()
                `;

                if (!isDon) {
                    const actorRows = await sql`
                        select discord_id
                        from players
                        where discord_id = ${interaction.user.id}
                        limit 1
                    `;

                    if (actorRows.length === 0) {
                        throw new Error('You are not in the database yet.');
                    }

                    const childRows = await sql`
                        select discord_id
                        from players
                        where discord_id = ${childUser.id}
                            and parent_discord_id = ${interaction.user.id}
                        limit 1
                    `;

                    if (childRows.length === 0) {
                        throw new Error('You can only move your direct recruits.');
                    }
                }

                const parentInChildTree = await sql`
                    with recursive descendants as (
                        select discord_id
                        from players
                        where parent_discord_id = ${childUser.id}

                        union all

                        select p.discord_id
                        from players p
                        join descendants
                            on p.parent_discord_id = descendants.discord_id
                    )
                    select discord_id
                    from descendants
                    where discord_id = ${parentUser.id}
                    limit 1
                `;

                if (parentInChildTree.length > 0) {
                    throw new Error('The new recruiter cannot be inside the recruit player’s tree.');
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
                        `Rank hierarchy blocked this move. ` +
                        `The new recruiter is \`${ranks.recruiter_rank_name}\`, ` +
                        `but the recruit is \`${ranks.recruit_rank_name}\`. ` +
                        `A recruiter must be the same rank or higher than their direct recruit.`
                    );
                }

                // Assign recruit to recruiter
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
                `✅ **Tree moved successfully!**\n\n` +
                `New recruiter: ${parentUser} \`${parentUser.id}\`\n` +
                `Moved player: ${childUser} \`${childUser.id}\`\n\n` +
                `${childUser} and their entire recruit tree are now under ${parentUser}.`
            );

            await postFirstRecruitEvent(interaction.guild, sql, {
                recruiterId: parentUser.id,
                recruitId: childUser.id
            }).catch(error => {
                console.error('First recruit promotion event failed after /give:');
                console.error(error);
                return false;
            });
        } catch (error) {
            logCommandError(interaction, '/give', error);

            await interaction.editReply(
                `❌ **Give command failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
