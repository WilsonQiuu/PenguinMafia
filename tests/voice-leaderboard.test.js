const assert = require('node:assert/strict');
const test = require('node:test');

const {
    voiceLeaderboardLine,
    voiceLeaderboardName
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

test('VC leaderboard line includes level, XP, and tracked call time', () => {
    const line = voiceLeaderboardLine(0, {
        level: 1,
        voice_xp: 7,
        voice_seconds: 4_200
    }, {
        nickname: 'Ice Boss'
    });

    assert.match(line, /Ice Boss/);
    assert.match(line, /Level \*\*1\*\*/);
    assert.match(line, /7 VC XP/);
    assert.match(line, /1 hour 10 minutes 0 seconds/);
});
