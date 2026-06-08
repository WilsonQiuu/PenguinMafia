const sql = require('../db.js');

const ELECTION_LEADERBOARD_CHANNEL_ID = process.env.ELECTION_LEADERBOARD_CHANNEL_ID || '1513392373437169664';
const ELECTION_EVENTS_CHANNEL_ID = process.env.ELECTION_EVENTS_CHANNEL_ID || '1513393832845115453';
const ELECTION_COMMANDS_CHANNEL_ID = process.env.ELECTION_COMMANDS_CHANNEL_ID || '1513405907051221092';

const VOTE_WEIGHTS = new Map([
    ['Penguin Soldier', 1],
    ['Penguin Captain', 3],
    ['Penguin General', 5],
    ['Emperor Penguin', 10]
]);

function playerName(player, fallback = 'Unknown Penguin') {
    return player?.minecraft_ign ||
        player?.discord_display_name ||
        player?.discord_username ||
        fallback;
}

function playerMention(id) {
    return `<@${id}>`;
}

function rankVoteWeight(rankName) {
    return VOTE_WEIGHTS.get(rankName) || 0;
}

function rankVoteLine(rankName) {
    const icons = {
        'Penguin Soldier': '🧊',
        'Penguin Captain': '🎩',
        'Penguin General': '⭐',
        'Emperor Penguin': '👑'
    };

    return `${icons[rankName] || '🐧'} **${rankName}:** ${rankVoteWeight(rankName)} vote${rankVoteWeight(rankName) === 1 ? '' : 's'}`;
}

function medal(index) {
    return ['🥇', '🥈', '🥉'][index] || `**${index + 1}.**`;
}

function electionChannelLink(guild, channelId) {
    return `https://discord.com/channels/${guild.id}/${channelId}`;
}

async function getChannelById(guild, channelId, label) {
    const channel = guild.channels.cache.get(channelId) ||
        (await guild.channels.fetch(channelId).catch(() => null));

    if (!channel) {
        console.warn(`Election ${label} channel was not found by ID ${channelId}.`);
        return null;
    }

    return channel;
}

async function getActiveElection(db = sql) {
    const rows = await db`
        select *
        from elections
        where status = 'active'
        order by started_at desc
        limit 1
    `;

    return rows[0] || null;
}

async function getElectionScores(electionId, db = sql) {
    return db`
        select
            target.discord_id,
            target.discord_username,
            target.discord_display_name,
            target.minecraft_ign,
            coalesce(sum(case voter.rank_name
                when 'Penguin Soldier' then 1
                when 'Penguin Captain' then 3
                when 'Penguin General' then 5
                when 'Emperor Penguin' then 10
                else 0
            end), 0)::int as votes
        from election_votes vote
        join players voter
            on voter.discord_id = vote.voter_discord_id
        join players target
            on target.discord_id = vote.target_discord_id
        left join election_exclusions excluded
            on excluded.election_id = vote.election_id
            and excluded.player_discord_id = target.discord_id
        where vote.election_id = ${electionId}
            and excluded.player_discord_id is null
        group by
            target.discord_id,
            target.discord_username,
            target.discord_display_name,
            target.minecraft_ign
        having coalesce(sum(case voter.rank_name
            when 'Penguin Soldier' then 1
            when 'Penguin Captain' then 3
            when 'Penguin General' then 5
            when 'Emperor Penguin' then 10
            else 0
        end), 0) > 0
        order by votes desc, target.discord_display_name asc nulls last, target.discord_username asc nulls last
    `;
}

function renderPreStartAnnouncement() {
    return {
        content:
            `@everyone\n\n` +
            `# 🐧🗳️ PENGUIN MAFIA ELECTION STARTING SOON\n\n` +
            `The iceberg is rumbling. The colony is getting ready to vote for the next **DON**.\n\n` +
            `When the election opens, use \`/vote player:@Player\` to send **all** of your vote power to one penguin.\n\n` +
            `## 🧊 Vote Power\n` +
            `${rankVoteLine('Penguin Soldier')}\n` +
            `${rankVoteLine('Penguin Captain')}\n` +
            `${rankVoteLine('Penguin General')}\n` +
            `${rankVoteLine('Emperor Penguin')}\n\n` +
            `You can vote for anyone, including yourself.\n` +
            `You can change your vote any time before the election ends.\n` +
            `If your rank changes during the election, your vote power changes with it.\n\n` +
            `Warm up your flippers. Campaign season is here. 🐧✨`,
        allowedMentions: {
            parse: ['everyone']
        }
    };
}

function renderElectionCommandsMessage() {
    return {
        content:
            `# 🐧🗳️ PENGUIN MAFIA VOTING COMMANDS\n\n` +
            `The election ice can get slippery, so here is the official flipper guide.\n\n` +
            `## 🗳️ Player Commands\n` +
            `\`/vote player:@Player\`\n` +
            `Cast all of your vote power for one penguin.\n\n` +
            `\`/transfervotes player:@Player\`\n` +
            `Move all of your vote power to another candidate.\n\n` +
            `\`/election\`\n` +
            `Check the current election, time left, and top penguins.\n\n` +
            `\`/electionremove\`\n` +
            `Leave the candidate ice so players cannot vote for you.\n\n` +
            `\`/electionjoin\`\n` +
            `Rejoin the candidate ice. Lost votes do **not** come back.\n\n` +
            `## 👑 Don Commands\n` +
            `\`/startelection\` - Start a new 1-week election. If one is active, it cancels the old election and resets votes.\n` +
            `\`/endelection\` - End the election and show the winner.\n` +
            `\`/electioncancel\` - Cancel the election with no winner.\n` +
            `\`/electionclear\` - Clear a finished board back to the starting-soon message.\n` +
            `\`/electionvotes player:@Player\` - Check who voted for a player and how many votes they give.\n\n` +
            `## 🧊 Vote Power\n` +
            `${rankVoteLine('Penguin Soldier')}\n` +
            `${rankVoteLine('Penguin Captain')}\n` +
            `${rankVoteLine('Penguin General')}\n` +
            `${rankVoteLine('Emperor Penguin')}\n\n` +
            `All of your votes go to **one** player. You can vote for yourself. You can change your vote before the election ends. 🐧✨`
    };
}

function renderActiveLeaderboard(election, scores) {
    const endsAt = Math.floor(new Date(election.ends_at).getTime() / 1000);
    const leaderboardLines = scores.length > 0
        ? scores.slice(0, 15).map((player, index) => {
            return `${medal(index)} ${playerMention(player.discord_id)} - **${player.votes}** vote${player.votes === 1 ? '' : 's'}`;
        }).join('\n')
        : `No votes yet. The ice is quiet... for now. Be the first penguin to make a splash. 🐧`;

    return {
        content:
            `@everyone\n\n` +
            `# 🗳️🐧 PENGUIN MAFIA DON ELECTION\n\n` +
            `We are voting for the next **DON**.\n\n` +
            `Voting ends <t:${endsAt}:R>.\n\n` +
            `Use \`/vote player:@Player\` to vote.\n` +
            `Use \`/transfervotes player:@Player\` to move your vote power to a new candidate.\n` +
            `All of your votes go to **one** player, and you can change your vote any time before the ice clock melts.\n\n` +
            `## 🧊 Vote Power\n` +
            `${rankVoteLine('Penguin Soldier')}\n` +
            `${rankVoteLine('Penguin Captain')}\n` +
            `${rankVoteLine('Penguin General')}\n` +
            `${rankVoteLine('Emperor Penguin')}\n\n` +
            `## 🏆 Live Leaderboard\n` +
            `${leaderboardLines}`,
        allowedMentions: {
            parse: ['everyone']
        }
    };
}

function renderEndedLeaderboard(scores, cancelled = false) {
    if (cancelled) {
        return {
            content:
                `# 🧊 ELECTION CANCELLED\n\n` +
                `The election has been cancelled. The ballot box is closed, the ice has been swept, and no winner was chosen.\n\n` +
                `A new election can be started later with \`/startelection\`.`
        };
    }

    if (scores.length === 0) {
        return {
            content:
                `# 🏁 ELECTION HAS ENDED\n\n` +
                `# 👑 NO WINNER\n\n` +
                `No votes were cast. The crown sits quietly on the ice.`
        };
    }

    const topVotes = scores[0].votes;
    const winners = scores.filter(player => player.votes === topVotes);
    const winnerLine = winners.length === 1
        ? `# 👑 WINNER: ${playerMention(winners[0].discord_id)}`
        : `# 👑 WINNERS: ${winners.map(player => playerMention(player.discord_id)).join(' and ')}`;
    const winnerSummary = winners.length === 1
        ? `${playerMention(winners[0].discord_id)} finished in 1st place with **${topVotes}** votes.`
        : `${winners.map(player => playerMention(player.discord_id)).join(' and ')} tied for 1st place with **${topVotes}** votes.`;
    const runnerUps = scores
        .map((player, index) => ({
            ...player,
            place: index + 1
        }))
        .filter(player => player.votes < topVotes)
        .slice(0, 10)
        .map(player => {
            const place = medal(player.place - 1);
            return `${place} ${playerMention(player.discord_id)} - **${player.votes}** vote${player.votes === 1 ? '' : 's'}`;
        });

    return {
        content:
            `# 🏁 ELECTION HAS ENDED\n\n` +
            `${winnerLine}\n\n` +
            `${winnerSummary}\n\n` +
            `The election is now closed. A new election can be started later with \`/startelection\`.\n\n` +
            `## 🐧 Runner Ups\n` +
            `${runnerUps.length > 0 ? runnerUps.join('\n') : 'No runner ups. This penguin waddled alone.'}`
    };
}

async function updateElectionLeaderboard(guild, db = sql, options = {}) {
    const election = options.election || await getActiveElection(db);

    if (!election) {
        return false;
    }

    const channel = await getChannelById(guild, ELECTION_LEADERBOARD_CHANNEL_ID, 'leaderboard');

    if (!channel) {
        return false;
    }

    const scores = await getElectionScores(election.id, db);
    const payload = election.status === 'active'
        ? renderActiveLeaderboard(election, scores)
        : renderEndedLeaderboard(scores, election.status === 'cancelled');
    let message = null;

    if (election.leaderboard_message_id) {
        message = await channel.messages.fetch(election.leaderboard_message_id).catch(() => null);
    }

    if (message) {
        await message.edit(payload);
    } else {
        message = await channel.send(payload);
        await db`
            update elections
            set leaderboard_message_id = ${message.id}
            where id = ${election.id}
        `;
    }

    return true;
}

async function postElectionStartingSoon(guild, electionId, db = sql) {
    const channel = await getChannelById(guild, ELECTION_LEADERBOARD_CHANNEL_ID, 'leaderboard');

    if (!channel) {
        return false;
    }

    const message = await channel.send(renderPreStartAnnouncement());
    await db`
        update elections
        set pre_start_message_id = ${message.id}
        where id = ${electionId}
    `;

    return true;
}

async function clearLatestFinishedElectionBoard(guild, db = sql) {
    const active = await getActiveElection(db);

    if (active) {
        throw new Error('There is an active election right now. End or cancel it before clearing the board.');
    }

    const rows = await db`
        select *
        from elections
        where status in ('ended', 'cancelled')
        order by ended_at desc nulls last, started_at desc
        limit 1
    `;
    const election = rows[0];

    if (!election) {
        throw new Error('There is no finished election board to clear.');
    }

    const channel = await getChannelById(guild, ELECTION_LEADERBOARD_CHANNEL_ID, 'leaderboard');

    if (!channel) {
        return false;
    }

    let message = null;

    if (election.leaderboard_message_id) {
        message = await channel.messages.fetch(election.leaderboard_message_id).catch(() => null);
    }

    if (message) {
        await message.edit(renderPreStartAnnouncement());
    } else {
        message = await channel.send(renderPreStartAnnouncement());
        await db`
            update elections
            set leaderboard_message_id = ${message.id}
            where id = ${election.id}
        `;
    }

    return true;
}

async function ensureElectionStartingSoonBoard(guild, db = sql) {
    const active = await getActiveElection(db);

    if (active) {
        return false;
    }

    const channel = await getChannelById(guild, ELECTION_LEADERBOARD_CHANNEL_ID, 'leaderboard');

    if (!channel) {
        return false;
    }

    const recentMessages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const existingMessage = recentMessages?.find(message => {
        return message.author.id === guild.client.user.id &&
            message.content.includes('PENGUIN MAFIA ELECTION STARTING SOON');
    });
    const payload = renderPreStartAnnouncement();

    if (existingMessage) {
        await existingMessage.edit(payload);
    } else {
        await channel.send(payload);
    }

    return true;
}

async function ensureElectionCommandsBoard(guild) {
    const channel = await getChannelById(guild, ELECTION_COMMANDS_CHANNEL_ID, 'commands');

    if (!channel) {
        return false;
    }

    const recentMessages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const existingMessage = recentMessages?.find(message => {
        return message.author.id === guild.client.user.id &&
            message.content.includes('PENGUIN MAFIA VOTING COMMANDS');
    });
    const payload = renderElectionCommandsMessage();

    if (existingMessage) {
        await existingMessage.edit(payload);
    } else {
        await channel.send(payload);
    }

    return true;
}

async function postVoteEvent(guild, content, userIds = []) {
    const channel = await getChannelById(guild, ELECTION_EVENTS_CHANNEL_ID, 'events');

    if (!channel) {
        return false;
    }

    await channel.send({
        content,
        allowedMentions: {
            users: [...new Set(userIds.filter(Boolean))]
        }
    });

    return true;
}

async function startElection(guild, createdById, db = sql) {
    const existing = await getActiveElection(db);
    const election = await db.begin(async transaction => {
        if (existing) {
            await transaction`
                update elections
                set
                    status = 'cancelled',
                    ended_at = now(),
                    ended_by_discord_id = ${createdById}
                where id = ${existing.id}
            `;
        }

        const rows = await transaction`
            insert into elections (
                created_by_discord_id,
                ends_at,
                leaderboard_message_id
            )
            values (
                ${createdById},
                now() + interval '7 days',
                ${existing?.leaderboard_message_id || null}
            )
            returning *
        `;

        return rows[0];
    });

    await postElectionStartingSoon(guild, election.id, db);
    await updateElectionLeaderboard(guild, db, { election });

    election.restarted = Boolean(existing);
    return election;
}

async function castElectionVote(guild, voterUser, targetUser, db = sql, options = {}) {
    const election = await getActiveElection(db);

    if (!election) {
        throw new Error('There is no active election right now. The ballot box is closed.');
    }

    if (new Date(election.ends_at).getTime() <= Date.now()) {
        await endElection(guild, null, db, 'ended');
        throw new Error('The election timer has ended. The ballot box just snapped shut.');
    }

    const rows = await db`
        select
            voter.discord_id as voter_discord_id,
            voter.discord_username as voter_username,
            voter.discord_display_name as voter_display_name,
            voter.minecraft_ign as voter_minecraft_ign,
            voter.rank_name as voter_rank_name,
            voter.welcome_completed as voter_welcome_completed,
            target.discord_id as target_discord_id,
            target.discord_username as target_username,
            target.discord_display_name as target_display_name,
            target.minecraft_ign as target_minecraft_ign,
            excluded.player_discord_id as target_excluded
        from players voter
        cross join players target
        left join election_exclusions excluded
            on excluded.election_id = ${election.id}
            and excluded.player_discord_id = target.discord_id
        where voter.discord_id = ${voterUser.id}
            and target.discord_id = ${targetUser.id}
        limit 1
    `;
    const row = rows[0];

    if (!row) {
        throw new Error('Both the voter and target need to be registered Penguin Mafia players.');
    }

    if (!row.voter_welcome_completed) {
        throw new Error('You need to finish welcome onboarding before voting.');
    }

    if (row.target_excluded) {
        throw new Error('That penguin has left the election and cannot receive votes.');
    }

    const oldVoteRows = await db`
        select
            vote.target_discord_id,
            target.discord_username,
            target.discord_display_name,
            target.minecraft_ign
        from election_votes vote
        left join players target
            on target.discord_id = vote.target_discord_id
        where vote.election_id = ${election.id}
            and vote.voter_discord_id = ${voterUser.id}
        limit 1
    `;
    const oldVote = oldVoteRows[0] || null;

    await db`
        insert into election_votes (
            election_id,
            voter_discord_id,
            target_discord_id
        )
        values (
            ${election.id},
            ${voterUser.id},
            ${targetUser.id}
        )
        on conflict (election_id, voter_discord_id) do update
        set
            target_discord_id = excluded.target_discord_id,
            updated_at = now()
    `;

    const weight = rankVoteWeight(row.voter_rank_name);
    const voterMention = playerMention(voterUser.id);
    const targetMention = playerMention(targetUser.id);

    if (!oldVote) {
        await postVoteEvent(
            guild,
            `🗳️🐧 **Vote Cast!**\n\n` +
            `${voterMention} launched **${weight}** vote${weight === 1 ? '' : 's'} across the ice for ${targetMention}.\n\n` +
            `Why so much power? ${voterMention} is **${row.voter_rank_name}**. Flippers officially counted.`,
            [voterUser.id, targetUser.id]
        );
    } else if (oldVote.target_discord_id !== targetUser.id) {
        await postVoteEvent(
            guild,
            `🔁🐧 **Vote Transfer!**\n\n` +
            `${voterMention} slid **${weight}** vote${weight === 1 ? '' : 's'} from ${playerMention(oldVote.target_discord_id)} to ${targetMention}.\n\n` +
            `Reason: ${voterMention} is **${row.voter_rank_name}**, and the ice allows vote changes until time runs out.`,
            [voterUser.id, oldVote.target_discord_id, targetUser.id]
        );
    } else if (options.forceTransferMessage) {
        await postVoteEvent(
            guild,
            `🐧🗳️ **Vote Re-Confirmed!**\n\n` +
            `${voterMention} kept **${weight}** vote${weight === 1 ? '' : 's'} on ${targetMention}. The colony has been reminded.`,
            [voterUser.id, targetUser.id]
        );
    }

    await updateElectionLeaderboard(guild, db, { election });

    return {
        election,
        oldVote,
        weight,
        rankName: row.voter_rank_name
    };
}

async function removePlayerFromActiveElection(guild, playerId, removedById, db = sql, options = {}) {
    const election = await getActiveElection(db);

    if (!election) {
        throw new Error('There is no active election right now.');
    }

    await db.begin(async transaction => {
        await transaction`
            insert into election_exclusions (
                election_id,
                player_discord_id,
                removed_by_discord_id
            )
            values (
                ${election.id},
                ${playerId},
                ${removedById}
            )
            on conflict (election_id, player_discord_id) do nothing
        `;

        if (options.removeCastVotes) {
            await transaction`
                delete from election_votes
                where election_id = ${election.id}
                    and (
                        target_discord_id = ${playerId}
                        or voter_discord_id = ${playerId}
                    )
            `;
        } else {
            await transaction`
                delete from election_votes
                where election_id = ${election.id}
                    and target_discord_id = ${playerId}
            `;
        }
    });

    await updateElectionLeaderboard(guild, db, { election });
    return election;
}

async function rejoinActiveElection(guild, playerId, db = sql) {
    const election = await getActiveElection(db);

    if (!election) {
        throw new Error('There is no active election right now.');
    }

    const rows = await db`
        delete from election_exclusions
        where election_id = ${election.id}
            and player_discord_id = ${playerId}
        returning player_discord_id
    `;

    if (rows.length === 0) {
        throw new Error('You are already in the election. The ice has your name on it.');
    }

    await updateElectionLeaderboard(guild, db, { election });
    return election;
}

async function endElection(guild, endedById, db = sql, status = 'ended') {
    const active = await getActiveElection(db);

    if (!active) {
        throw new Error('There is no active election right now.');
    }

    const rows = await db`
        update elections
        set
            status = ${status},
            ended_at = now(),
            ended_by_discord_id = ${endedById}
        where id = ${active.id}
        returning *
    `;
    const election = rows[0];

    await updateElectionLeaderboard(guild, db, { election });
    return election;
}

async function finishExpiredElectionsForGuild(guild, db = sql) {
    const rows = await db`
        update elections
        set
            status = 'ended',
            ended_at = now()
        where status = 'active'
            and ends_at <= now()
        returning *
    `;

    for (const election of rows) {
        await updateElectionLeaderboard(guild, db, { election });
    }

    return rows;
}

async function getVotesForPlayer(playerId, db = sql) {
    const election = await getActiveElection(db);

    if (!election) {
        throw new Error('There is no active election right now.');
    }

    const rows = await db`
        select
            voter.discord_id,
            voter.discord_username,
            voter.discord_display_name,
            voter.minecraft_ign,
            voter.rank_name,
            case voter.rank_name
                when 'Penguin Soldier' then 1
                when 'Penguin Captain' then 3
                when 'Penguin General' then 5
                when 'Emperor Penguin' then 10
                else 0
            end as votes
        from election_votes vote
        join players voter
            on voter.discord_id = vote.voter_discord_id
        left join election_exclusions excluded
            on excluded.election_id = vote.election_id
            and excluded.player_discord_id = vote.target_discord_id
        where vote.election_id = ${election.id}
            and vote.target_discord_id = ${playerId}
            and excluded.player_discord_id is null
        order by votes desc, voter.discord_display_name asc nulls last, voter.discord_username asc nulls last
    `;

    return {
        election,
        voters: rows,
        total: rows.reduce((sum, row) => sum + Number(row.votes || 0), 0)
    };
}

module.exports = {
    ELECTION_COMMANDS_CHANNEL_ID,
    ELECTION_EVENTS_CHANNEL_ID,
    ELECTION_LEADERBOARD_CHANNEL_ID,
    VOTE_WEIGHTS,
    castElectionVote,
    clearLatestFinishedElectionBoard,
    endElection,
    ensureElectionCommandsBoard,
    ensureElectionStartingSoonBoard,
    finishExpiredElectionsForGuild,
    getActiveElection,
    getElectionScores,
    getVotesForPlayer,
    playerName,
    rankVoteWeight,
    rejoinActiveElection,
    removePlayerFromActiveElection,
    startElection,
    updateElectionLeaderboard
};
