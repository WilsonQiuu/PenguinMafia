const assert = require('node:assert/strict');
const test = require('node:test');

const {
    creditVoiceTimeForGuild,
    eligibleVoiceMemberIds,
    formatVoiceTime,
    levelForXp,
    voiceLevelInfoPayload,
    voiceProgress,
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

test('formats tracked ten-minute segments as readable call time', () => {
    assert.equal(formatVoiceTime(0), '0 minutes');
    assert.equal(formatVoiceTime(10), '10 minutes');
    assert.equal(formatVoiceTime(60), '1 hour 0 minutes');
    assert.equal(formatVoiceTime(150), '2 hours 30 minutes');
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

    assert.match(content, /Every \*\*10 minutes\*\*/);
    assert.match(content, /L² \+ 6L/);
    assert.match(content, /\/vchours/);
    assert.ok(content.length <= 2_000);
});

test('a ten-minute database tick credits each eligible member once and reports a level-up', async () => {
    let insertedValues = null;
    const transaction = (first, ...rest) => {
        if (!first?.raw) {
            insertedValues = first;
            return { columns: rest };
        }

        const query = first.join(' ').replace(/\s+/g, ' ').trim();

        if (query.includes('insert into vc_level_ticks')) {
            return Promise.resolve([{ tick_bucket: new Date() }]);
        }

        if (query.includes('insert into vc_levels')) {
            return Promise.resolve([{
                discord_id: 'human',
                voice_minutes: '70',
                voice_xp: '7'
            }]);
        }

        throw new Error(`Unexpected test query: ${query}`);
    };
    const db = {
        begin(callback) {
            return callback(transaction);
        }
    };
    const guild = {
        id: 'guild',
        afkChannelId: 'afk',
        members: { cache: new Map() },
        voiceStates: {
            cache: new Map([
                ['human', {
                    id: 'human',
                    channelId: 'voice',
                    member: { id: 'human', user: { bot: false } }
                }]
            ])
        }
    };

    const result = await creditVoiceTimeForGuild(guild, db, new Date('2026-08-14T12:09:59Z'));

    assert.deepEqual(insertedValues, [{
        guild_id: 'guild',
        discord_id: 'human',
        voice_minutes: 10,
        voice_xp: 1
    }]);
    assert.equal(result.credited, 1);
    assert.deepEqual(result.credits, [{
        discordId: 'human',
        voiceMinutes: 70,
        voiceXp: 7,
        level: 1
    }]);
    assert.deepEqual(result.levelUps, [{
        discordId: 'human',
        oldLevel: 0,
        newLevel: 1,
        voiceMinutes: 70,
        voiceXp: 7
    }]);
});
