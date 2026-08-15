const assert = require('node:assert/strict');
const test = require('node:test');

const {
    voiceLeaderboardLine,
    voiceLeaderboardName,
    voiceLeaderboardTable
} = require('../utils/leaderboards.js');

test('VC leaderboard prefers the current server nickname', () => {
    const member = {
        nickname: 'Ice Boss',
        displayName: 'Global Name',
        user: { username: 'account_name' }
    };
    const row = {
        discord_display_name: 'Stored Name',
        discord_username: 'stored_account'
    };

    assert.equal(voiceLeaderboardName(member, row), 'Ice Boss');
});

test('VC leaderboard line aligns level, XP, and total whole minutes', () => {
    const line = voiceLeaderboardLine(0, {
        level: 1,
        voice_xp: 7,
        voice_seconds: 4_200
    }, {
        nickname: 'Ice Boss'
    });

    assert.equal(line, '01. Ice Boss           │  1 │   7 │     70');
    assert.doesNotMatch(line, /hour|second/);
});

test('VC leaderboard renders aligned rows in a monospace table', () => {
    const table = voiceLeaderboardTable([
        '01. Kage               │  4 │  51 │    511',
        '04. NICO               │  2 │  26 │    262'
    ]);

    assert.equal(
        table,
        '```text\n' +
        'POS PLAYER             │ LV │  XP │ VC MIN\n' +
        '01. Kage               │  4 │  51 │    511\n' +
        '04. NICO               │  2 │  26 │    262\n' +
        '```'
    );
});

test('VC leaderboard safely truncates long or multiline nicknames', () => {
    const line = voiceLeaderboardLine(9, {
        level: 12,
        voice_xp: 999,
        voice_seconds: 60
    }, {
        nickname: 'A very long `player`\nname'
    });

    assert.equal(line, '10. A very long  play… │ 12 │ 999 │      1');
    assert.doesNotMatch(line, /`|\n/);
});
