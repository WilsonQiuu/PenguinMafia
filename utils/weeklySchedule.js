const sql = require('../db.js');
const {
    getActiveElection,
    startElection
} = require('./elections.js');
const {
    resetWeeklyRecruitsAndSaveTopThree,
    updateWeeklyRecruitsLeaderboardForGuild
} = require('./leaderboards.js');

const EASTERN_TIME_ZONE = 'America/Toronto';
const runningGuildSchedules = new Set();
const easternFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: EASTERN_TIME_ZONE,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
});

function easternDateParts(date = new Date()) {
    const parts = Object.fromEntries(
        easternFormatter.formatToParts(date)
            .filter(part => part.type !== 'literal')
            .map(part => [part.type, part.value])
    );

    return {
        weekday: parts.weekday,
        year: parts.year,
        month: parts.month,
        day: parts.day,
        hour: Number(parts.hour),
        minute: Number(parts.minute),
        dateKey: `${parts.year}-${parts.month}-${parts.day}`
    };
}

function fridayScheduleStateKey(guildId, dateKey) {
    return `friday_noon_cycle:${guildId}:${dateKey}`;
}

async function readScheduleState(db, key) {
    const rows = await db`
        select value
        from bot_state
        where key = ${key}
        limit 1
    `;

    if (!rows[0]?.value) {
        return {
            weeklyReset: false,
            electionStarted: false
        };
    }

    try {
        return JSON.parse(rows[0].value);
    } catch {
        return {
            weeklyReset: false,
            electionStarted: false
        };
    }
}

async function writeScheduleState(db, key, state) {
    await db`
        insert into bot_state (
            key,
            value
        )
        values (
            ${key},
            ${JSON.stringify(state)}
        )
        on conflict (key) do update
        set
            value = excluded.value,
            updated_at = now()
    `;
}

async function runFridayNoonScheduleForGuild(guild, db = sql, now = new Date()) {
    const eastern = easternDateParts(now);

    if (eastern.weekday !== 'Fri' || eastern.hour < 12) {
        return {
            due: false,
            weeklyReset: false,
            electionStarted: false
        };
    }

    if (runningGuildSchedules.has(guild.id)) {
        return {
            due: true,
            weeklyReset: false,
            electionStarted: false
        };
    }

    runningGuildSchedules.add(guild.id);

    try {
        const stateKey = fridayScheduleStateKey(guild.id, eastern.dateKey);
        let state = await readScheduleState(db, stateKey);
        let weeklyReset = false;
        let electionStarted = false;

        if (!state.weeklyReset) {
            state = {
                ...state,
                dateKey: eastern.dateKey,
                weeklyReset: true
            };

            await resetWeeklyRecruitsAndSaveTopThree(db, {
                completionStateKey: stateKey,
                completionStateValue: JSON.stringify(state)
            });
            await updateWeeklyRecruitsLeaderboardForGuild(guild, db);
            weeklyReset = true;
        }

        if (!state.electionStarted) {
            const activeElection = await getActiveElection(db);

            if (!activeElection) {
                await startElection(
                    guild,
                    process.env.DON_DISCORD_ID || guild.client.user.id,
                    db
                );
                electionStarted = true;
            }

            state = {
                ...state,
                electionStarted: true
            };
            await writeScheduleState(db, stateKey, state);
        }

        return {
            due: true,
            weeklyReset,
            electionStarted
        };
    } finally {
        runningGuildSchedules.delete(guild.id);
    }
}

module.exports = {
    EASTERN_TIME_ZONE,
    easternDateParts,
    fridayScheduleStateKey,
    runFridayNoonScheduleForGuild
};
