const sql = require('../db.js');

const ELECTION_LEADERBOARD_CHANNEL_ID = process.env.ELECTION_LEADERBOARD_CHANNEL_ID || '1513392373437169664';
const ELECTION_EVENTS_CHANNEL_ID = process.env.ELECTION_EVENTS_CHANNEL_ID || '1513393832845115453';
const ELECTION_COMMANDS_CHANNEL_ID = process.env.ELECTION_COMMANDS_CHANNEL_ID || '1513405907051221092';
const DON_ELECTION_ROLE_ID = process.env.DON_ELECTION_ROLE_ID || '1497774847630245908';
const ELECTION_LEADERBOARD_REFRESH_DELAY_MS = 1_500;
const electionLeaderboardRefreshes = new Map();
const ELECTION_DURATION_HOURS = 24;
const TRANSFER_VOTES_CUTOFF_REMAINING_HOURS = 12;
const HOUR_MS = 60 * 60 * 1000;

const VOTE_WEIGHT = 1;
const VOTE_WEIGHTS = new Map([
    ['Penguin Soldier', VOTE_WEIGHT],
    ['Penguin Captain', VOTE_WEIGHT],
    ['Penguin General', VOTE_WEIGHT],
    ['Emperor Penguin', VOTE_WEIGHT]
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

function rankVoteWeight() {
    return VOTE_WEIGHT;
}

function voteRuleLine() {
    return `🐧 **Every player:** ${VOTE_WEIGHT} vote`;
}

function medal(index) {
    return ['🥇', '🥈', '🥉'][index] || `**${index + 1}.**`;
}

function electionWinnerIds(scores) {
    if (!scores.length) {
        return [];
    }

    const topVotes = Number(scores[0].votes || 0);

    return scores
        .filter(player => Number(player.votes || 0) === topVotes)
        .map(player => player.discord_id);
}

async function syncDonElectionRole(guild, scores) {
    const winnerIds = electionWinnerIds(scores);

    if (winnerIds.length === 0) {
        return { added: 0, removed: 0, winnerIds };
    }

    const role = guild.roles.cache.get(DON_ELECTION_ROLE_ID) ||
        await guild.roles.fetch(DON_ELECTION_ROLE_ID).catch(() => null);

    if (!role) {
        throw new Error(`The Don election role ${DON_ELECTION_ROLE_ID} could not be found.`);
    }

    if (role.editable === false) {
        throw new Error(`The Don election role ${DON_ELECTION_ROLE_ID} is above the bot's highest role.`);
    }

    const members = await guild.members.fetch();
    const winnerIdSet = new Set(winnerIds);
    const winnerMembers = winnerIds.map(winnerId => members.get(winnerId));
    const missingWinnerId = winnerIds.find((winnerId, index) => !winnerMembers[index]);

    if (missingWinnerId) {
        throw new Error(`Election winner ${missingWinnerId} is no longer a member of the server.`);
    }

    let added = 0;
    let removed = 0;

    for (const winner of winnerMembers) {
        if (!winner.roles.cache.has(DON_ELECTION_ROLE_ID)) {
            await winner.roles.add(role, 'Won the Penguin Mafia Don election');
            added++;
        }
    }

    for (const [, member] of members) {
        if (
            !winnerIdSet.has(member.id) &&
            member.roles.cache.has(DON_ELECTION_ROLE_ID)
        ) {
            await member.roles.remove(role, 'A new Penguin Mafia Don won the election');
            removed++;
        }
    }

    return { added, removed, winnerIds };
}

function electionChannelLink(guild, channelId) {
    return `https://discord.com/channels/${guild.id}/${channelId}`;
}

function electionTransferClosesAt(election) {
    return new Date(new Date(election.ends_at).getTime() - TRANSFER_VOTES_CUTOFF_REMAINING_HOURS * HOUR_MS);
}

function transferVotesWindowStatus(election, now = new Date()) {
    const closesAt = electionTransferClosesAt(election);
    const closed = now.getTime() >= closesAt.getTime();

    return {
        closed,
        closesAt,
        remainingMs: Math.max(0, new Date(election.ends_at).getTime() - now.getTime())
    };
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
            count(vote.voter_discord_id)::int as votes
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
        having count(vote.voter_discord_id) > 0
        order by votes desc, target.discord_display_name asc nulls last, target.discord_username asc nulls last
    `;
}

function renderPreStartAnnouncement() {
    return {
        content:
            `@everyone\n\n` +
            `# 🐧🗳️ PENGUIN MAFIA ELECTION STARTING SOON\n\n` +
            `The iceberg is rumbling. The colony is getting ready to vote for the next **DON**.\n\n` +
            `## 📅 Weekly Schedule\n` +
            `Elections begin every **Friday at 12:00 PM Eastern Time** (**EDT** during daylight saving time).\n` +
            `The weekly recruit leaderboard resets at the same time.\n\n` +
            `The election runs for **24 hours**.\n` +
            `When the election opens, use \`/vote player:@Player\` to send your **1 vote** to one penguin.\n\n` +
            `## 🧊 Voting Rule\n` +
            `${voteRuleLine()}\n\n` +
            `You can vote for anyone, including yourself.\n` +
            `You can change your vote any time before the election ends.\n` +
            `Ranks do not change vote weight; every voter counts equally.\n\n` +
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
            `Elections automatically begin every **Friday at 12:00 PM Eastern Time** (**EDT** during daylight saving time) when weekly recruits reset.\n\n` +
            `## 🗳️ Player Commands\n` +
            `\`/vote player:@Player\`\n` +
            `Cast your 1 vote for one penguin. Voters stay anonymous.\n\n` +
            `\`/transfervotes player:@Player\`\n` +
            `Transfer the votes cast **for you** to another candidate. This only works before the final **12 hours** of the election.\n\n` +
            `\`/election\`\n` +
            `Check the current election, time left, and top penguins.\n\n` +
            `\`/electionremove\`\n` +
            `Leave the candidate ice so players cannot vote for you.\n\n` +
            `\`/electionjoin\`\n` +
            `Rejoin the candidate ice. Lost votes do **not** come back.\n\n` +
            `## 👑 Don Commands\n` +
            `\`/startelection\` - Start a new 24-hour election. If one is active, it cancels the old election and resets votes.\n` +
            `\`/endelection\` - End the election and show the winner.\n` +
            `\`/electioncancel\` - Cancel the election with no winner.\n` +
            `\`/electionclear\` - Clear a finished board back to the starting-soon message.\n` +
            `\`/electionvotes player:@Player\` - Check anonymous vote totals for a player.\n\n` +
            `## 🧊 Voting Rule\n` +
            `${voteRuleLine()}\n\n` +
            `Your vote goes to **one** player. You can vote for yourself. You can change your vote before the election ends. Voter names are not shown. 🐧✨`
    };
}

function renderActiveLeaderboard(election, scores) {
    const endsAt = Math.floor(new Date(election.ends_at).getTime() / 1000);
    const transferClosesAt = Math.floor(electionTransferClosesAt(election).getTime() / 1000);
    const transferWindow = transferVotesWindowStatus(election);
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
            (transferWindow.closed
                ? `Vote transfers are **closed** for the final 12 hours.\n`
                : `Use \`/transfervotes player:@Player\` to transfer votes cast **for you** to another candidate until <t:${transferClosesAt}:R>.\n`) +
            `Your vote goes to **one** player, and you can change it with \`/vote\` before the ice clock melts.\n\n` +
            `## 🧊 Voting Rule\n` +
            `${voteRuleLine()}\n\n` +
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

function scheduleElectionLeaderboardUpdate(guild, db = sql, options = {}, delayMs = ELECTION_LEADERBOARD_REFRESH_DELAY_MS) {
    const electionKey = options.election?.id || 'active';
    const key = `${guild.id}:${electionKey}`;
    let task = electionLeaderboardRefreshes.get(key);

    if (!task) {
        task = {
            guild,
            db,
            options: {
                ...options
            },
            timer: null,
            running: false,
            rerun: false
        };
        electionLeaderboardRefreshes.set(key, task);
    } else {
        task.guild = guild;
        task.db = db;
        task.options = {
            ...task.options,
            ...options
        };
    }

    if (task.timer) {
        clearTimeout(task.timer);
    }

    task.timer = setTimeout(() => {
        runScheduledElectionLeaderboardUpdate(key, delayMs);
    }, delayMs);
}

async function runScheduledElectionLeaderboardUpdate(key, delayMs) {
    const task = electionLeaderboardRefreshes.get(key);

    if (!task) {
        return;
    }

    task.timer = null;

    if (task.running) {
        task.rerun = true;
        return;
    }

    task.running = true;

    try {
        await updateElectionLeaderboard(task.guild, task.db, task.options);
    } catch (error) {
        console.error(`Scheduled election leaderboard refresh failed for ${task.guild?.name || key}:`);
        console.error(error);
    } finally {
        task.running = false;

        if (task.rerun) {
            task.rerun = false;
            task.timer = setTimeout(() => {
                runScheduledElectionLeaderboardUpdate(key, delayMs);
            }, delayMs);
        } else {
            electionLeaderboardRefreshes.delete(key);
        }
    }
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

async function findElectionStartingSoonMessage(guild) {
    const channel = await getChannelById(guild, ELECTION_LEADERBOARD_CHANNEL_ID, 'leaderboard');

    if (!channel) {
        return null;
    }

    const recentMessages = await channel.messages.fetch({ limit: 20 }).catch(() => null);

    return recentMessages?.find(message => {
        return message.author.id === guild.client.user.id &&
            message.content.includes('PENGUIN MAFIA ELECTION STARTING SOON');
    }) || null;
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

    return resetFinishedElectionBoard(guild, election, db);
}

async function resetFinishedElectionBoard(guild, election, db = sql) {
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
    }

    await db`
        update elections
        set
            leaderboard_message_id = ${message.id},
            board_reset_at = now()
        where id = ${election.id}
    `;

    return true;
}

async function ensureElectionStartingSoonBoard(guild, db = sql) {
    const active = await getActiveElection(db);

    if (active) {
        return false;
    }

    const recentFinishedRows = await db`
        select id
        from elections
        where status = 'ended'
            and ended_at > now() - interval '1 day'
            and board_reset_at is null
        order by ended_at desc
        limit 1
    `;

    if (recentFinishedRows.length > 0) {
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

async function resetExpiredElectionResultBoardForGuild(guild, db = sql) {
    const active = await getActiveElection(db);

    if (active) {
        return false;
    }

    const rows = await db`
        select *
        from elections
        where status = 'ended'
            and ended_at <= now() - interval '1 day'
            and board_reset_at is null
        order by ended_at desc
        limit 1
    `;
    const election = rows[0];

    if (!election) {
        return false;
    }

    return resetFinishedElectionBoard(guild, election, db);
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

function postVoteEventInBackground(guild, content, userIds = []) {
    postVoteEvent(guild, content, userIds).catch(error => {
        console.error('Could not post election vote event:');
        console.error(error);
    });
}

async function postElectionStartedEvent(guild, election) {
    const endsAt = Math.floor(new Date(election.ends_at).getTime() / 1000);
    const transferClosesAt = Math.floor(electionTransferClosesAt(election).getTime() / 1000);

    return postVoteEvent(
        guild,
        `🚨🐧 **DON ELECTION STARTED!** 🐧🚨\n\n` +
        `The ballot box is open for **24 hours**. Voting ends <t:${endsAt}:R>.\n\n` +
        `Vote in <#${ELECTION_LEADERBOARD_CHANNEL_ID}> with \`/vote player:@Player\`.\n` +
        `Received-vote transfers with \`/transfervotes\` close <t:${transferClosesAt}:R>, when the final 12 hours begin.\n` +
        `Need help? Check <#${ELECTION_COMMANDS_CHANNEL_ID}>.\n\n` +
        `Votes are anonymous. The ice sees totals, not names. 🧊🗳️`
    );
}

async function postElectionEndedEvent(guild, election, scores, status = 'ended') {
    if (status === 'cancelled') {
        return postVoteEvent(
            guild,
            `🧊🐧 **DON ELECTION CANCELLED** 🐧🧊\n\n` +
            `The ballot box is closed and no winner was chosen.\n\n` +
            `A new election can be started with \`/startelection\`.`
        );
    }

    if (scores.length === 0) {
        return postVoteEvent(
            guild,
            `🏁🐧 **DON ELECTION ENDED** 🐧🏁\n\n` +
            `No votes were cast, so no winner was chosen.\n\n` +
            `The crown stays on the ice for now. 👑🧊`
        );
    }

    const topVotes = scores[0].votes;
    const winners = scores.filter(player => player.votes === topVotes);
    const winnerLine = winners.length === 1
        ? `${playerMention(winners[0].discord_id)} wins with **${topVotes}** vote${topVotes === 1 ? '' : 's'}!`
        : `${winners.map(player => playerMention(player.discord_id)).join(' and ')} tie with **${topVotes}** vote${topVotes === 1 ? '' : 's'}!`;

    return postVoteEvent(
        guild,
        `🏁🐧 **DON ELECTION ENDED** 🐧🏁\n\n` +
        `${winnerLine}\n\n` +
        `Final results are posted in <#${ELECTION_LEADERBOARD_CHANNEL_ID}>. 👑`,
        winners.map(player => player.discord_id)
    );
}

async function startElection(guild, createdById, db = sql) {
    const existing = await getActiveElection(db);
    const startingSoonMessage = existing
        ? null
        : await findElectionStartingSoonMessage(guild);
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
                now() + interval '24 hours',
                ${existing?.leaderboard_message_id || startingSoonMessage?.id || null}
            )
            returning *
        `;

        return rows[0];
    });

    election.restarted = Boolean(existing);

    await updateElectionLeaderboard(guild, db, { election });
    await postElectionStartedEvent(guild, election);

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
    const targetMention = playerMention(targetUser.id);

    if (!oldVote) {
        postVoteEventInBackground(
            guild,
            `🗳️🐧 **Anonymous Vote Cast!**\n\n` +
            `A secret penguin voted for ${targetMention}.\n\n` +
            `The ballot is private. The ice has counted it. 🧊🗳️`,
            [targetUser.id]
        );
    } else if (oldVote.target_discord_id !== targetUser.id) {
        postVoteEventInBackground(
            guild,
            `🔁🐧 **Anonymous Vote Changed!**\n\n` +
            `A secret penguin moved their vote to ${targetMention}.\n\n` +
            `The old ballot is private. The new ballot is counted. 🧊`,
            [targetUser.id]
        );
    } else if (options.forceTransferMessage) {
        postVoteEventInBackground(
            guild,
            `🐧🗳️ **Anonymous Vote Re-Confirmed!**\n\n` +
            `A secret penguin kept their vote on ${targetMention}.`,
            [targetUser.id]
        );
    }

    scheduleElectionLeaderboardUpdate(guild, db, { election });

    return {
        election,
        oldVote,
        weight,
        rankName: row.voter_rank_name
    };
}

async function transferReceivedElectionVotes(guild, sourceUser, targetUser, db = sql) {
    const election = await getActiveElection(db);

    if (!election) {
        throw new Error('There is no active election right now. The ballot box is closed.');
    }

    if (new Date(election.ends_at).getTime() <= Date.now()) {
        await endElection(guild, null, db, 'ended');
        throw new Error('The election timer has ended. The ballot box just snapped shut.');
    }

    const transferWindow = transferVotesWindowStatus(election);

    if (transferWindow.closed) {
        throw new Error(
            `Vote transfers are closed for the final ${TRANSFER_VOTES_CUTOFF_REMAINING_HOURS} hours of the election. ` +
            `Players can still change their own vote with /vote until the election ends.`
        );
    }

    if (sourceUser.id === targetUser.id) {
        throw new Error('You cannot transfer your received votes to yourself.');
    }

    const rows = await db`
        select
            source.discord_id as source_discord_id,
            source.discord_username as source_username,
            source.discord_display_name as source_display_name,
            source.minecraft_ign as source_minecraft_ign,
            target.discord_id as target_discord_id,
            target.discord_username as target_username,
            target.discord_display_name as target_display_name,
            target.minecraft_ign as target_minecraft_ign,
            excluded.player_discord_id as target_excluded
        from players source
        cross join players target
        left join election_exclusions excluded
            on excluded.election_id = ${election.id}
            and excluded.player_discord_id = target.discord_id
        where source.discord_id = ${sourceUser.id}
            and target.discord_id = ${targetUser.id}
        limit 1
    `;
    const row = rows[0];

    if (!row) {
        throw new Error('Both players need to be registered Penguin Mafia players.');
    }

    if (row.target_excluded) {
        throw new Error('That penguin has left the election and cannot receive votes.');
    }

    const transferredVotes = await db`
        with moved_votes as (
            update election_votes
            set
                target_discord_id = ${targetUser.id},
                updated_at = now()
            where election_id = ${election.id}
                and target_discord_id = ${sourceUser.id}
            returning voter_discord_id
        )
        select
            voter.discord_id,
            voter.rank_name,
            1::int as votes
        from moved_votes moved
        join players voter
            on voter.discord_id = moved.voter_discord_id
    `;

    if (transferredVotes.length === 0) {
        throw new Error('You do not currently have any votes to transfer.');
    }

    const totalWeight = transferredVotes.reduce((sum, vote) => {
        return sum + Number(vote.votes || 0);
    }, 0);
    const voterCount = transferredVotes.length;

    postVoteEventInBackground(
        guild,
        `🔁🐧 **Received Votes Transferred!**\n\n` +
        `${playerMention(sourceUser.id)} transferred **${totalWeight}** vote${totalWeight === 1 ? '' : 's'} they received to ${playerMention(targetUser.id)}.\n\n` +
        `That came from **${voterCount}** voter${voterCount === 1 ? '' : 's'}. The voters themselves did not need to re-vote.`,
        [sourceUser.id, targetUser.id]
    );

    scheduleElectionLeaderboardUpdate(guild, db, { election });

    return {
        election,
        voterCount,
        totalWeight
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
    const scores = status === 'cancelled'
        ? []
        : await getElectionScores(election.id, db);

    if (status === 'ended' && scores.length > 0) {
        await syncDonElectionRole(guild, scores);
    }

    await updateElectionLeaderboard(guild, db, { election });
    await postElectionEndedEvent(guild, election, scores, status);
    return election;
}

async function finishExpiredElectionsForGuild(guild, db = sql) {
    const rows = await db`
        update elections
        set
            status = 'ended',
            ended_at = ends_at
        where status = 'active'
            and ends_at <= now()
        returning *
    `;

    for (const election of rows) {
        const scores = await getElectionScores(election.id, db);
        if (scores.length > 0) {
            await syncDonElectionRole(guild, scores);
        }
        await updateElectionLeaderboard(guild, db, { election });
        await postElectionEndedEvent(guild, election, scores, 'ended');
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
            count(*)::int as voter_count,
            count(*)::int as total
        from election_votes vote
        join players voter
            on voter.discord_id = vote.voter_discord_id
        left join election_exclusions excluded
            on excluded.election_id = vote.election_id
            and excluded.player_discord_id = vote.target_discord_id
        where vote.election_id = ${election.id}
            and vote.target_discord_id = ${playerId}
            and excluded.player_discord_id is null
    `;
    const totals = rows[0] || {
        voter_count: 0,
        total: 0
    };

    return {
        election,
        voterCount: Number(totals.voter_count || 0),
        total: Number(totals.total || 0)
    };
}

module.exports = {
    DON_ELECTION_ROLE_ID,
    ELECTION_COMMANDS_CHANNEL_ID,
    ELECTION_DURATION_HOURS,
    ELECTION_EVENTS_CHANNEL_ID,
    ELECTION_LEADERBOARD_CHANNEL_ID,
    TRANSFER_VOTES_CUTOFF_REMAINING_HOURS,
    VOTE_WEIGHTS,
    castElectionVote,
    clearLatestFinishedElectionBoard,
    endElection,
    electionWinnerIds,
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
    resetExpiredElectionResultBoardForGuild,
    scheduleElectionLeaderboardUpdate,
    startElection,
    syncDonElectionRole,
    transferVotesWindowStatus,
    transferReceivedElectionVotes,
    updateElectionLeaderboard
};
