const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('Captain speedruns are archived whenever a Captain timestamp is recorded', () => {
    const bootstrap = fs.readFileSync(path.join(root, 'utils/bootstrap.js'), 'utf8');

    assert.match(bootstrap, /create table if not exists captain_speed_runs/);
    assert.match(bootstrap, /record_captain_speed_run_after_update/);
    assert.match(bootstrap, /on conflict \(discord_id, reached_captain_at\) do nothing/);
});

test('Captain leaderboard shows current-month and all-time personal-best sections', () => {
    const leaderboards = fs.readFileSync(path.join(root, 'utils/leaderboards.js'), 'utf8');

    assert.match(leaderboards, /run\.counts_for_monthly = true/);
    assert.match(leaderboards, /monthly_personal_best/);
    assert.match(leaderboards, /select distinct on \(player\.discord_id\)/);
    assert.match(leaderboards, /Fastest of All Time/);
    assert.match(leaderboards, /Monthly resets do not remove these records/);
});

test('manual monthly reset preserves archived all-time Captain runs', () => {
    const clearCommand = fs.readFileSync(path.join(root, 'commands/clearcaptainlb.js'), 'utf8');

    assert.match(clearCommand, /set counts_for_monthly = false/);
    assert.doesNotMatch(clearCommand, /delete from captain_speed_runs/);
    assert.match(clearCommand, /All-time records were preserved/);
});
