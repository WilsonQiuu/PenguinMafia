const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const dbPath = path.join(__dirname, '..', 'db.js');
require.cache[require.resolve(dbPath)] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: async () => []
};

const {
    isElectionFriday
} = require('../utils/weeklySchedule.js');

// All inputs are noon Eastern (EDT, UTC-4 => 16:00Z) so the Eastern calendar
// date matches the UTC calendar date regardless of the machine's timezone.
const noonEDT = iso => new Date(iso);

test('no Don election opens on the Friday before the anchor (2026-08-28)', () => {
    assert.equal(isElectionFriday(noonEDT('2026-08-28T16:00:00Z')), false);
});

test('Don election opens on the first biweekly Friday (2026-09-04)', () => {
    assert.equal(isElectionFriday(noonEDT('2026-09-04T16:00:00Z')), true);
});

test('the following Friday is skipped (2026-09-11)', () => {
    assert.equal(isElectionFriday(noonEDT('2026-09-11T16:00:00Z')), false);
});

test('elections recur every two weeks (2026-09-18, 2026-10-02)', () => {
    assert.equal(isElectionFriday(noonEDT('2026-09-18T16:00:00Z')), true);
    assert.equal(isElectionFriday(noonEDT('2026-10-02T16:00:00Z')), true);
});

test('only Fridays are election Fridays', () => {
    assert.equal(isElectionFriday(noonEDT('2026-09-03T16:00:00Z')), false); // Thu
});

test('dates before the anchor are never election Fridays', () => {
    assert.equal(isElectionFriday(noonEDT('2025-09-05T16:00:00Z')), false);
});