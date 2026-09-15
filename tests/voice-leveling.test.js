const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    eligibleVoiceMemberIds,
    formatVoiceMinutes,
    formatVoiceTime,
    levelForXp,
    postVoiceLevelUps,
    voiceLevelInfoPayload,
    voiceProgress,
    voiceStateIsEligible,
    xpForLevel
} = require('../utils/voiceLeveling.js');

test('uses the cumulative Minecraft XP formulas at every boundary', () => {
    assert.equal(xpForLevel(0), 0);
    assert.equal(xpForLevel(10), 160);
    assert.equal(xpForLevel(16), 352);
    assert.equal(xpForLevel(17), 394);
    assert.equal(xpForLevel(31), 1507);
    assert.equal(xpForLevel(32), 1628);
});

test('derives levels and progress from credited VC XP', () => {
    assert.equal(levelForXp(159), 9);
    assert.equal(levelForXp(160), 10);
    assert.equal(levelForXp(161), 10);
    assert.deepEqual(voiceProgress(160), {
        level: 10,
        currentLevelXp: 160,
        nextLevelXp: 187,
        earnedThisLevel: 0,
        neededThisLevel: 27,
        xpToNextLevel: 27
    });
});

test('formats exact tracked seconds as readable call time', () => {
    assert.equal(formatVoiceTime(0), '0 seconds');
    assert.equal(formatVoiceTime(10), '10 seconds');
    assert.equal(formatVoiceTime(60), '1 minute 0 seconds');
    assert.equal(formatVoiceTime(3_750), '1 hour 2 minutes 30 seconds');
});

test('formats level-up call time as total whole minutes only', () => {
    assert.equal(formatVoiceMinutes(16_217), '270 minutes');
    assert.equal(formatVoiceMinutes(60), '1 minute');
    assert.equal(formatVoiceMinutes(59), '0 minutes');
});

test('credits connected humans while excluding bots, disconnected users, and AFK', () => {
    const human = {
        id: 'human',
        user: { bot: false }
    };
    const guild = {
        afkChannelId: 'afk',
        members: {
            cache: new Map()
        },
        voiceStates: {
            cache: new Map([
                ['human', { id: 'human', channelId: 'voice', member: human }],
                ['duplicate-impossible', { id: 'human', channelId: 'voice', member: human }],
                ['bot', { id: 'bot', channelId: 'voice', member: { id: 'bot', user: { bot: true } } }],
                ['afk', { id: 'afk-user', channelId: 'afk', member: { id: 'afk-user', user: { bot: false } } }],
                ['gone', { id: 'gone', channelId: null, member: { id: 'gone', user: { bot: false } } }]
            ])
        }
    };

    assert.deepEqual(eligibleVoiceMemberIds(guild), ['human']);
});

test('promotion-channel info explains the scan, formula, and hours command', () => {
    const content = voiceLevelInfoPayload().content;

    assert.match(content, /tracked \*\*to the second\*\*/);
    assert.match(content, /Every \*\*600 tracked seconds\*\*/);
    assert.match(content, /L² \+ 6L/);
    assert.match(content, /\/vchours/);
    assert.ok(content.length <= 2_000);
});

test('VC level-up notifications use the dedicated level-up channel', async () => {
    const promotionChannel = {
        type: 0,
        name: '🎉-promotion-events',
        send: test.mock.fn()
    };
    const levelUpChannel = {
        type: 0,
        name: 'vc-level-ups',
        send: test.mock.fn()
    };
    const guild = {
        channels: {
            fetch: async () => new Map([
                ['1512488373145702430', promotionChannel],
                ['1549446780809379840', levelUpChannel]
            ])
        }
    };

    const sent = await postVoiceLevelUps(guild, [{
        discordId: 'player-1',
        newLevel: 7,
        voiceSeconds: 12_000
    }]);

    assert.equal(sent, 1);
    assert.equal(promotionChannel.send.mock.callCount(), 0);
    assert.equal(levelUpChannel.send.mock.callCount(), 1);
    assert.match(levelUpChannel.send.mock.calls[0].arguments[0].content, /VC Level 7/);
});

test('voice eligibility stops when a member disconnects or enters AFK', () => {
    const guild = {
        afkChannelId: 'afk',
        members: { cache: new Map() }
    };
    const member = { id: 'human', user: { bot: false } };

    assert.equal(voiceStateIsEligible(guild, { channelId: 'voice', member }), true);
    assert.equal(voiceStateIsEligible(guild, { channelId: 'afk', member }), false);
    assert.equal(voiceStateIsEligible(guild, { channelId: null, member }), false);
});

test('VC tracking uses session timestamps instead of ten-minute XP writes', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'utils/voiceLeveling.js'), 'utf8');

    assert.match(source, /vc_active_sessions/);
    assert.match(source, /extract\(epoch from/);
    assert.doesNotMatch(source, /insert into vc_level_ticks/);
});
