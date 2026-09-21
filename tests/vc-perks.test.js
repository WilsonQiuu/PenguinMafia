const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    ChannelType,
    Collection,
    PermissionFlagsBits
} = require('discord.js');

// Ensure deterministic defaults regardless of the environment running the tests.
for (const key of [
    'VC_PERK_ACTIVITIES_LEVEL',
    'VC_PERK_SCREEN_SHARE_LEVEL',
    'VC_PERK_SLOWMODE_LEVEL',
    'VC_PERK_STAGE_LEVEL',
    'VC_PERK_STAGE_CHANNEL_IDS'
]) {
    delete process.env[key];
}

const {
    ensureVcPerkRoles,
    handleStageRequestToSpeak,
    isPerkStageChannel,
    nextPerkAtLevel,
    perkLevels,
    perksAtLevel,
    perksForReply,
    perksUnlockedBetween,
    perkSummaryLines,
    syncLevelUpPerks,
    unlockedPerksDmContent
} = require('../utils/vcPerks.js');

test('VC perk setup uses valid discord.js permission flags', async () => {
    const createdOverwrites = [];
    const channel = {
        id: 'voice-1',
        type: ChannelType.GuildVoice,
        permissionOverwrites: {
            cache: new Collection(),
            async create(targetId, permissions) {
                createdOverwrites.push({ targetId, permissions });
            }
        }
    };
    const roles = new Collection([
        ['everyone', { id: 'everyone', name: '@everyone' }],
        ['activities', { id: 'activities', name: 'VC Perks · Activities (Lv 3)' }],
        ['screen', { id: 'screen', name: 'VC Perks · Screen Share (Lv 5)' }],
        ['stage', { id: 'stage', name: 'VC Perks · Event Stage (Lv 10)' }]
    ]);
    const guild = {
        roles: {
            cache: roles,
            everyone: roles.get('everyone'),
            async fetch() {
                return null;
            },
            async create() {
                throw new Error('configured perk roles should be reused');
            }
        },
        channels: {
            async fetch() {
                return new Collection([['voice-1', channel]]);
            }
        },
        client: { user: { id: 'bot-1' } }
    };

    const result = await ensureVcPerkRoles(guild);
    const everyoneOverwrite = createdOverwrites.find(overwrite => overwrite.targetId === 'everyone');

    assert.equal(result.channelsUpdated, 1);
    assert.ok(everyoneOverwrite.permissions.deny & PermissionFlagsBits.Stream);
    assert.ok(everyoneOverwrite.permissions.deny & PermissionFlagsBits.UseEmbeddedActivities);
    assert.ok(createdOverwrites.every(overwrite =>
        typeof overwrite.permissions.allow === 'bigint' &&
        typeof overwrite.permissions.deny === 'bigint'
    ));
    assert.ok(createdOverwrites.every(overwrite =>
        !(overwrite.permissions.allow & PermissionFlagsBits.Connect) &&
        !(overwrite.permissions.deny & PermissionFlagsBits.Connect) &&
        !(overwrite.permissions.allow & PermissionFlagsBits.ViewChannel) &&
        !(overwrite.permissions.deny & PermissionFlagsBits.ViewChannel)
    ));
});

test('the bot never changes who can join voice channels', () => {
    const vcPerks = fs.readFileSync(path.join(__dirname, '..', 'utils/vcPerks.js'), 'utf8');
    const bootstrap = fs.readFileSync(path.join(__dirname, '..', 'utils/bootstrap.js'), 'utf8');

    assert.doesNotMatch(vcPerks, /PermissionFlagsBits\.Connect/);
    assert.doesNotMatch(bootstrap, /PermissionFlagsBits\.Connect/);
});

test('uses the configured perk unlock levels (defaults 3/5/10, slow mode disabled)', () => {
    assert.deepEqual(perkLevels(), {
        activities: 3,
        screenShare: 5,
        slowMode: 0,
        stage: 10
    });
});

test('unlocks perks only at or above their level', () => {
    assert.deepEqual(perksAtLevel(2).map(perk => perk.key), []);
    assert.deepEqual(perksAtLevel(3).map(perk => perk.key), ['activities']);
    assert.deepEqual(perksAtLevel(5).map(perk => perk.key), ['activities', 'screenShare']);
    assert.deepEqual(perksAtLevel(8).map(perk => perk.key), ['activities', 'screenShare']);
    assert.deepEqual(perksAtLevel(10).map(perk => perk.key), ['activities', 'screenShare', 'stage']);
});

test('points at the next locked perk and reports all unlocked at the top', () => {
    assert.equal(nextPerkAtLevel(0)?.key, 'activities');
    assert.equal(nextPerkAtLevel(3)?.key, 'screenShare');
    assert.equal(nextPerkAtLevel(5)?.key, 'stage');
    assert.equal(nextPerkAtLevel(8)?.key, 'stage');
    assert.equal(nextPerkAtLevel(10), null);
});

test('formats a perk summary for the info board in level order', () => {
    const lines = perkSummaryLines();

    assert.ok(lines[0].includes('VC LEVEL PERKS'));
    const headerIndex = lines.findIndex(line => line.includes('VC LEVEL PERKS'));
    const level3Index = lines.findIndex(line => line.startsWith('- **Level 3**'));
    const level10Index = lines.findIndex(line => line.startsWith('- **Level 10**'));
    assert.ok(headerIndex >= 0 && headerIndex < level3Index && level3Index < level10Index);
    assert.ok(lines.some(line => line.includes('Level 3') && /activities/i.test(line)));
    assert.ok(lines.some(line => line.includes('Level 10') && /event stage/i.test(line)));
});

test('formats the /vchours perk reply with unlocked and next perks', () => {
    const reply = perksForReply(5);

    assert.match(reply, /Unlocked: \*\*Activities, Screen Share\*\*/);
    assert.match(reply, /Next perk: \*\*Event Stage Access\*\* at \*\*Level 10\*\*/);
    assert.match(perksForReply(10), /All perks unlocked!/);
});

test('grants perks after every VC level-up announcement path in index.js', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

    assert.match(source, /await syncLevelUpPerks\(guild, result\.levelUps, sql\)/);
    assert.equal((source.match(/await postVoiceLevelUps\(guild, result\.levelUps\)/g) || []).length, 2);
    assert.equal((source.match(/await syncLevelUpPerks\(guild, result\.levelUps, sql\)/g) || []).length, 2);
});

test('identifies perk stage channels by type or explicit channel IDs', () => {
    const channels = new Collection();
    channels.set('stage-1', { id: 'stage-1', type: ChannelType.GuildStageVoice });
    channels.set('stage-2', { id: 'stage-2', type: ChannelType.GuildStageVoice });
    channels.set('vc-1', { id: 'vc-1', type: ChannelType.GuildVoice });
    const guild = { channels: { cache: channels } };

    assert.equal(isPerkStageChannel(guild, 'stage-1'), true);
    assert.equal(isPerkStageChannel(guild, 'vc-1'), false);
    assert.equal(isPerkStageChannel(guild, null), false);

    process.env.VC_PERK_STAGE_CHANNEL_IDS = 'stage-1';

    try {
        assert.equal(isPerkStageChannel(guild, 'stage-1'), true);
        assert.equal(isPerkStageChannel(guild, 'stage-2'), false);
        assert.equal(isPerkStageChannel(guild, 'vc-1'), false);
    } finally {
        delete process.env.VC_PERK_STAGE_CHANNEL_IDS;
    }
});

function fakeDbWithVoiceSeconds(voiceSeconds) {
    return Object.assign(async () => [{ voice_seconds: String(voiceSeconds) }], {});
}

function fakeGuildWithStage() {
    const channels = new Collection();
    channels.set('stage-1', { id: 'stage-1', type: ChannelType.GuildStageVoice });
    channels.set('vc-1', { id: 'vc-1', type: ChannelType.GuildVoice });

    return {
        channels: { cache: channels },
        members: { cache: new Collection() },
        roles: { cache: new Collection() }
    };
}

function fakeMember(id, roleNames) {
    const roles = new Collection();

    for (const name of roleNames) {
        roles.set(name, { id: name, name });
    }

    return {
        id,
        user: { id, bot: false, tag: `Penguin${id}` },
        roles: { cache: roles },
        send: async () => {}
    };
}

test('declines a below-level request to speak, cancels it, and DMs the member', async () => {
    const memberId = '900000000000000001';
    const member = fakeMember(memberId, ['Penguin Soldier']);
    let dmContent = null;
    member.send = async content => {
        dmContent = content;
    };

    const newState = {
        id: memberId,
        channelId: 'stage-1',
        requestToSpeakTimestamp: new Date(),
        member,
        setRequestToSpeak: async value => {
            newState.requestToSpeakTimestamp = value ? new Date() : null;
        }
    };

    const result = await handleStageRequestToSpeak(
        fakeGuildWithStage(),
        newState,
        fakeDbWithVoiceSeconds(0)
    );

    assert.equal(result.reason, 'declined');
    assert.equal(result.level, 0);
    assert.equal(newState.requestToSpeakTimestamp, null);
    assert.match(dmContent.content, /requires \*\*VC Level 10\*\*/);
    assert.match(dmContent.content, /current VC level is \*\*0\*\*/);
});

test('leaves requests alone in non-stage channels, for staff, and for eligible levels', async () => {
    const guild = fakeGuildWithStage();

    // Non-stage channel: not handled, request kept.
    const voiceMember = fakeMember('900000000000000002', ['Penguin Soldier']);
    const voiceState = {
        id: voiceMember.id,
        channelId: 'vc-1',
        requestToSpeakTimestamp: new Date(),
        member: voiceMember,
        setRequestToSpeak: async () => {
            throw new Error('should not cancel');
        }
    };
    const voiceResult = await handleStageRequestToSpeak(guild, voiceState, fakeDbWithVoiceSeconds(0));
    assert.equal(voiceResult.reason, 'not_stage');
    assert.ok(voiceState.requestToSpeakTimestamp);

    // Staff are exempt regardless of level.
    const staffMember = fakeMember('900000000000000003', ['Moderator']);
    const staffState = {
        id: staffMember.id,
        channelId: 'stage-1',
        requestToSpeakTimestamp: new Date(),
        member: staffMember,
        setRequestToSpeak: async () => {
            throw new Error('should not cancel');
        }
    };
    const staffResult = await handleStageRequestToSpeak(guild, staffState, fakeDbWithVoiceSeconds(0));
    assert.equal(staffResult.reason, 'exempt');
    assert.ok(staffState.requestToSpeakTimestamp);

    // Level 10 member: eligible, request kept.
    const eligibleMember = fakeMember('900000000000000004', ['Penguin Soldier']);
    const eligibleState = {
        id: eligibleMember.id,
        channelId: 'stage-1',
        requestToSpeakTimestamp: new Date(),
        member: eligibleMember,
        setRequestToSpeak: async () => {
            throw new Error('should not cancel');
        }
    };
    const eligibleResult = await handleStageRequestToSpeak(
        guild,
        eligibleState,
        fakeDbWithVoiceSeconds(160 * 600)
    );
    assert.equal(eligibleResult.reason, 'eligible');
    assert.ok(eligibleState.requestToSpeakTimestamp);
});

test('wires request-to-speak declines into the voice state update path', () => {
    const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const perkSource = fs.readFileSync(path.join(__dirname, '..', 'utils/vcPerks.js'), 'utf8');

    assert.match(indexSource, /await handleStageRequestToSpeak\(guild, newState, sql\)/);
    assert.match(perkSource, /setRequestToSpeak\(false\)/);
});

test('reports only the perks crossed by a level-up', () => {
    assert.deepEqual(perksUnlockedBetween(0, 2).map(perk => perk.key), []);
    assert.deepEqual(perksUnlockedBetween(2, 3).map(perk => perk.key), ['activities']);
    assert.deepEqual(perksUnlockedBetween(2, 5).map(perk => perk.key), ['activities', 'screenShare']);
    assert.deepEqual(perksUnlockedBetween(4, 10).map(perk => perk.key), ['screenShare', 'stage']);
    assert.deepEqual(perksUnlockedBetween(10, 15).map(perk => perk.key), []);
});

test('builds a perk unlock DM naming the unlocked perks', () => {
    const content = unlockedPerksDmContent(
        { newLevel: 5 },
        perksUnlockedBetween(2, 5)
    );

    assert.match(content, /NEW PERK UNLOCKED/);
    assert.match(content, /reached \*\*VC Level 5\*\*/);
    assert.match(content, /\*\*Activities\*\*/);
    assert.match(content, /\*\*Screen Share\*\*/);
});

test('DMs the member about perks unlocked on level-up', async () => {
    const memberId = '900000000000000005';
    const member = fakeMember(memberId, ['Penguin Soldier']);
    let dmPayload = null;
    member.send = async payload => {
        dmPayload = payload;
    };

    const guild = fakeGuildWithStage();
    guild.members.cache.set(memberId, member);

    const result = await syncLevelUpPerks(
        guild,
        [{ discordId: memberId, oldLevel: 2, newLevel: 5 }],
        fakeDbWithVoiceSeconds(0)
    );

    assert.equal(result.notified, 1);
    assert.ok(dmPayload);
    assert.match(dmPayload.content, /NEW PERK UNLOCKED/);
    assert.match(dmPayload.content, /\*\*Activities\*\*/);
    assert.match(dmPayload.content, /\*\*Screen Share\*\*/);
    assert.equal(dmPayload.components.length, 1);
    assert.equal(dmPayload.components[0].components[0].data.custom_id, `dismiss:${memberId}`);
});

test('does not DM when a level-up crosses no perk threshold', async () => {
    const memberId = '900000000000000006';
    const member = fakeMember(memberId, ['Penguin Soldier']);
    let dmSent = false;
    member.send = async () => {
        dmSent = true;
    };

    const guild = fakeGuildWithStage();
    guild.members.cache.set(memberId, member);

    const result = await syncLevelUpPerks(
        guild,
        [{ discordId: memberId, oldLevel: 5, newLevel: 6 }],
        fakeDbWithVoiceSeconds(0)
    );

    assert.equal(result.notified, 0);
    assert.equal(dmSent, false);
});
