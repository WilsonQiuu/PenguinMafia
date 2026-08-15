const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function source(relativePath) {
    return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('recruit leaderboards contain no cash-prize messaging', () => {
    const leaderboards = source('utils/leaderboards.js');

    assert.doesNotMatch(leaderboards, /Weekly Prizes/i);
    assert.doesNotMatch(leaderboards, /1st:\s*\*\*30m/i);
    assert.doesNotMatch(leaderboards, /prize pool/i);
    assert.doesNotMatch(leaderboards, /rewards are automatically paid/i);
});

test('scheduled bot paths do not create or pay recruiting rewards', () => {
    const index = source('index.js');
    const weeklySchedule = source('utils/weeklySchedule.js');

    assert.doesNotMatch(index, /ensureDailyRecruitRewardsForGuild/);
    assert.doesNotMatch(index, /processPendingDailyRecruitRewardPayoutsForGuild/);
    assert.doesNotMatch(index, /ensureMonthlyTeamRewardForGuild/);
    assert.doesNotMatch(index, /processPendingMonthlyTeamRewardPayoutsForGuild/);
    assert.doesNotMatch(weeklySchedule, /WEEKLY_PRIZES/);
    assert.doesNotMatch(weeklySchedule, /Weekly top .* prize/);
});
