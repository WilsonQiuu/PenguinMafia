const sql = require('../db.js');
const {
    getActiveElection,
    startElection
} = require('./elections.js');
const {
    resetWeeklyRecruitsAndSaveTopThree,
    updateTeamWeeklyRecruitsLeaderboardForGuild,
    updateWeeklyRecruitsLeaderboardForGuild
} = require('./leaderboards.js');
const {
    sendWeeklyElectionAndGiveawayReminderForGuild
} = require('./giveaways.js');
const {
    cleanupCompletedWelcomeChannels,
    cleanupWelcomeChannelsForMissingMembers,
    remindIncompleteWelcomeMembers
} = require('./onboarding.js');

const EASTERN_TIME_ZONE = 'America/Toronto';
const runningGuildSchedules = new Set();
const runningWelcomeMaintenance = new Set();
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

// Don elections open every OTHER Friday. The cadence is anchored to the first
// biweekly election Friday (2026-09-04) and recurs every 14 days: Sep 4,
// Sep 18, Oct 2, ... Weekly recruit resets still happen every Friday; only the
// election opening is gated behind this check.
const ELECTION_ANCHOR_DATE = '2026-09-04';
const DAY_MS = 86_400_000;

function isElectionFriday(now = new Date()) {
    const eastern = easternDateParts(now);

    if (eastern.weekday !== 'Fri') {
        return false;
    }

    const [anchorYear, anchorMonth, anchorDay] = ELECTION_ANCHOR_DATE
        .split('-')
        .map(Number);

    const anchor = Date.UTC(anchorYear, anchorMonth - 1, anchorDay, 12, 0, 0);
    const current = Date.UTC(
        Number(eastern.year),
        Number(eastern.month) - 1,
        Number(eastern.day),
        12,
        0,
        0
    );

    const dayDifference = Math.round((current - anchor) / DAY_MS);

    return dayDifference >= 0 && dayDifference % 14 === 0;
}

function saturdayWelcomeMaintenanceStateKey(guildId, dateKey) {
    return `saturday_noon_welcome:${guildId}:${dateKey}`;
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
            electionStarted: false,
            giveawayPingReminderSent: false
        };
    }

    try {
        return {
            weeklyReset: false,
            electionStarted: false,
            giveawayPingReminderSent: false,
            ...JSON.parse(rows[0].value)
        };
    } catch {
        return {
            weeklyReset: false,
            electionStarted: false,
            giveawayPingReminderSent: false
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

async function runSaturdayNoonWelcomeMaintenanceForGuild(guild, db = sql, now = new Date()) {
    const eastern = easternDateParts(now);

    if (eastern.weekday !== 'Sat' || eastern.hour < 12) {
        return {
            due: false,
            cleanupDone: false,
            welcomeRemindersSent: false,
            deletedWelcomeChannels: 0,
            checked: 0,
            sent: 0
        };
    }

    if (runningWelcomeMaintenance.has(guild.id)) {
        return {
            due: true,
            cleanupDone: false,
            welcomeRemindersSent: false,
            deletedWelcomeChannels: 0,
            checked: 0,
            sent: 0
        };
    }

    runningWelcomeMaintenance.add(guild.id);

    try {
        const stateKey = saturdayWelcomeMaintenanceStateKey(guild.id, eastern.dateKey);
        let state = await readScheduleState(db, stateKey);
        let cleanupDone = false;
        let welcomeRemindersSent = false;
        let deletedWelcomeChannels = 0;
        let reminderResult = {
            checked: 0,
            sent: 0
        };

        if (!state.cleanupDone) {
            const members = await guild.members.fetch();
            const deletedChannels = await cleanupWelcomeChannelsForMissingMembers(guild, members);
            const deletedCompletedChannels = await cleanupCompletedWelcomeChannels(guild);
            deletedWelcomeChannels = deletedChannels.length + deletedCompletedChannels.length;
            cleanupDone = true;
            state = {
                ...state,
                dateKey: eastern.dateKey,
                cleanupDone: true
            };
            await writeScheduleState(db, stateKey, state);
        }

        if (!state.welcomeRemindersSent) {
            reminderResult = await remindIncompleteWelcomeMembers(guild);
            welcomeRemindersSent = true;
            state = {
                ...state,
                dateKey: eastern.dateKey,
                welcomeRemindersSent: true
            };
            await writeScheduleState(db, stateKey, state);
        }

        return {
            due: true,
            cleanupDone,
            welcomeRemindersSent,
            deletedWelcomeChannels,
            checked: reminderResult.checked,
            sent: reminderResult.sent
        };
    } finally {
        runningWelcomeMaintenance.delete(guild.id);
    }
}

async function runFridayNoonScheduleForGuild(guild, db = sql, now = new Date()) {
    const eastern = easternDateParts(now);

    if (eastern.weekday !== 'Fri' || eastern.hour < 12) {
        return {
            due: false,
            weeklyReset: false,
            electionStarted: false,
            giveawayPingReminderSent: false
        };
    }

    if (runningGuildSchedules.has(guild.id)) {
        return {
            due: true,
            weeklyReset: false,
            electionStarted: false,
            giveawayPingReminderSent: false
        };
    }

    runningGuildSchedules.add(guild.id);

    try {
        const stateKey = fridayScheduleStateKey(guild.id, eastern.dateKey);
        let state = await readScheduleState(db, stateKey);
        let weeklyReset = false;
        let electionStarted = false;
        let giveawayPingReminderSent = false;
        let giveawayPingReminderResult = null;

        if (!state.weeklyReset) {
            state = {
                ...state,
                dateKey: eastern.dateKey,
                weeklyReset: true
            };

            await resetWeeklyRecruitsAndSaveTopThree(db, {
                completionStateKey: stateKey,
                completionStateValue: JSON.stringify(state),
                usePreviousWeeklyPeriod: true
            });
            await updateWeeklyRecruitsLeaderboardForGuild(guild, db);
            await updateTeamWeeklyRecruitsLeaderboardForGuild(guild, db);

            weeklyReset = true;
        }

        if (!state.electionStarted) {
            // Elections open every OTHER Friday (biweekly). Weekly recruit reset
            // still happens every Friday; only the election opening is gated on
            // the cadence so it does not start on the off Fridays.
            if (isElectionFriday(now)) {
                const activeElection = await getActiveElection(db);

                if (!activeElection) {
                    await startElection(
                        guild,
                        process.env.DON_DISCORD_ID || guild.client.user.id,
                        db
                    );
                    electionStarted = true;
                }
            }

            state = {
                ...state,
                electionStarted: true
            };
            await writeScheduleState(db, stateKey, state);
        }

        if (electionStarted && !state.giveawayPingReminderSent) {
            giveawayPingReminderResult = await sendWeeklyElectionAndGiveawayReminderForGuild(guild, db);
            giveawayPingReminderSent = true;
            state = {
                ...state,
                giveawayPingReminderSent: true
            };
            await writeScheduleState(db, stateKey, state);
        }

        return {
            due: true,
            weeklyReset,
            electionStarted,
            giveawayPingReminderSent,
            giveawayPingReminderResult
        };
    } finally {
        runningGuildSchedules.delete(guild.id);
    }
}

module.exports = {
    EASTERN_TIME_ZONE,
    easternDateParts,
    fridayScheduleStateKey,
    isElectionFriday,
    runFridayNoonScheduleForGuild,
    runSaturdayNoonWelcomeMaintenanceForGuild,
    saturdayWelcomeMaintenanceStateKey
};
