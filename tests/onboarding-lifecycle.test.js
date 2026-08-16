const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    ChannelType,
    Collection
} = require('discord.js');

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'penguin-welcome-lifecycle-'));
const stateFile = path.join(testDirectory, 'dm-cleanup.json');
process.env.WELCOME_DM_CLEANUP_STATE_FILE = stateFile;

const onboarding = require('../utils/onboarding.js');
const {
    acknowledgeWelcomeCompletion,
    clearPendingWelcomeDmCleanup,
    loadPendingWelcomeDmCleanups,
    recordPendingWelcomeDmCleanup,
    scheduleWelcomeChannelDelete
} = onboarding._test;

test.beforeEach(() => {
    for (const channelId of Object.keys(loadPendingWelcomeDmCleanups())) {
        clearPendingWelcomeDmCleanup(channelId);
    }
});

test.after(() => {
    fs.rmSync(testDirectory, {
        force: true,
        recursive: true
    });
});

test('welcome completion acknowledges a message interaction immediately', async () => {
    const calls = [];
    const interaction = {
        deferred: false,
        replied: false,
        message: {
            id: 'message-1'
        },
        async deferUpdate() {
            calls.push('deferUpdate');
            this.deferred = true;
        }
    };

    await acknowledgeWelcomeCompletion(interaction);
    assert.deepEqual(calls, ['deferUpdate']);
});

test('welcome completion uses a deferred reply when no source message exists', async () => {
    const calls = [];
    const interaction = {
        deferred: false,
        replied: false,
        message: null,
        async deferReply() {
            calls.push('deferReply');
            this.deferred = true;
        }
    };

    await acknowledgeWelcomeCompletion(interaction);
    assert.deepEqual(calls, ['deferReply']);
});

test('guild cleanup still deletes the room when the countdown message cannot be sent', async () => {
    let deleteCalls = 0;
    const interaction = {
        channel: {
            id: 'channel-1',
            deletable: true,
            async delete() {
                deleteCalls++;
            }
        },
        async followUp() {
            throw Object.assign(new Error('temporary follow-up failure'), {
                code: 500
            });
        }
    };
    const originalConsoleError = console.error;
    console.error = () => {};

    try {
        const deleted = await scheduleWelcomeChannelDelete(interaction, 0);
        assert.equal(deleted, true);
        assert.equal(deleteCalls, 1);
    } finally {
        console.error = originalConsoleError;
    }
});

test('DM cleanup state is written atomically and deduplicates message ids', () => {
    recordPendingWelcomeDmCleanup('dm-1', ['message-1', 'message-1', 'message-2']);

    assert.deepEqual(loadPendingWelcomeDmCleanups(), {
        'dm-1': ['message-1', 'message-2']
    });
    assert.equal(fs.existsSync(`${stateFile}.tmp`), false);
});

test('failed DM deletions remain queued and are removed after a successful retry', async () => {
    recordPendingWelcomeDmCleanup('dm-2', ['message-3', 'message-4']);
    const originalConsoleError = console.error;
    console.error = () => {};

    try {
        const firstResult = await onboarding.resumePendingWelcomeDmCleanups({
            channels: {
                async fetch() {
                    return {
                        messages: {
                            async delete(messageId) {
                                if (messageId === 'message-4') {
                                    throw Object.assign(new Error('temporary API failure'), {
                                        code: 500
                                    });
                                }
                            }
                        }
                    };
                }
            }
        });

        assert.equal(firstResult.messagesDeleted, 1);
        assert.deepEqual(loadPendingWelcomeDmCleanups(), {
            'dm-2': ['message-4']
        });

        await onboarding.resumePendingWelcomeDmCleanups({
            channels: {
                async fetch() {
                    return {
                        messages: {
                            async delete() {}
                        }
                    };
                }
            }
        });

        assert.deepEqual(loadPendingWelcomeDmCleanups(), {});
    } finally {
        console.error = originalConsoleError;
    }
});

test('live onboarding starts in DMs and never creates a guild channel', async () => {
    const sent = [];
    const dm = {
        messages: {
            async fetch() {
                return new Collection();
            }
        },
        async send(payload) {
            sent.push(payload);
            return {
                id: 'intro-1'
            };
        }
    };
    const member = {
        id: '123456789012345',
        user: {
            id: '123456789012345',
            username: 'NewPenguin'
        },
        guild: {
            channels: {
                async create() {
                    throw new Error('guild onboarding channel must not be created');
                }
            }
        },
        async createDM() {
            return dm;
        }
    };

    const result = await onboarding.startOnboardingForMember(member);

    assert.equal(result, dm);
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /Welcome to the Penguin Mafia/);
});

test('legacy welcome, trainer, and trial-mod rooms are deleted with an empty processing category', async () => {
    const deleted = [];
    const category = {
        id: 'category-1',
        name: '🐧-penguin-processing',
        type: ChannelType.GuildCategory,
        deletable: true,
        async delete() {
            deleted.push(this.id);
        }
    };
    const channels = new Collection([
        ['category-1', category],
        ['welcome-1', {
            id: 'welcome-1',
            name: 'welcome',
            type: ChannelType.GuildText,
            parentId: 'category-1',
            topic: 'Penguin Mafia onboarding:123456789012345',
            deletable: true,
            async delete() {
                deleted.push(this.id);
            }
        }],
        ['trainer-1', {
            id: 'trainer-1',
            name: 'trainer',
            type: ChannelType.GuildText,
            parentId: 'category-1',
            topic: 'Penguin Mafia trainer onboarding:123456789012346',
            deletable: true,
            async delete() {
                deleted.push(this.id);
            }
        }],
        ['trial-1', {
            id: 'trial-1',
            name: 'trial',
            type: ChannelType.GuildText,
            parentId: 'category-1',
            topic: 'Penguin Mafia trial mod onboarding:123456789012347',
            deletable: true,
            async delete() {
                deleted.push(this.id);
            }
        }]
    ]);

    const result = await onboarding.cleanupLegacyOnboardingChannels({
        channels: {
            async fetch() {
                return channels;
            }
        }
    });

    assert.deepEqual(result, {
        channelsDeleted: 3,
        categoriesDeleted: 1
    });
    assert.deepEqual(new Set(deleted), new Set(['welcome-1', 'trainer-1', 'trial-1', 'category-1']));
});

test('weekly DM refresh deletes the active tutorial message and sends a fresh first step', async () => {
    const calls = [];
    const botUser = {
        id: 'bot-1'
    };
    const priorMessage = {
        id: 'prior-welcome',
        author: botUser,
        client: {
            user: botUser
        },
        content: '<@123456789012345>',
        components: [{
            components: [{
                customId: 'welcome:rank_up:123456789012345:live'
            }]
        }],
        async delete() {
            calls.push('delete-prior');
        }
    };
    const dm = {
        messages: {
            async fetch() {
                return new Collection([
                    ['prior-welcome', priorMessage]
                ]);
            }
        },
        async send(payload) {
            calls.push('send-fresh');
            assert.match(payload.content, /weekly reminder/i);
        }
    };
    const member = {
        id: '123456789012345',
        user: {
            id: '123456789012345',
            username: 'NewPenguin'
        },
        async createDM() {
            return dm;
        }
    };

    const result = await onboarding.startOnboardingForMember(member, {
        refresh: true,
        isWeeklyRefresh: true
    });

    assert.equal(result, dm);
    assert.deepEqual(calls, ['delete-prior', 'send-fresh']);
});

test('chat gate deletes a message and resumes the existing DM onboarding', async () => {
    const calls = [];
    const botUser = {
        id: 'bot-1'
    };
    const dm = {
        messages: {
            async fetch() {
                return new Collection([
                    ['intro-1', {
                        author: botUser,
                        client: {
                            user: botUser
                        },
                        content: '',
                        components: [{
                            components: [{
                                customId: 'welcome:build_team:123456789012345:live'
                            }]
                        }]
                    }]
                ]);
            }
        },
        async send() {
            calls.push('intro');
        }
    };
    const member = {
        id: '123456789012345',
        user: {
            tag: 'new-penguin'
        },
        roles: {
            cache: new Collection()
        },
        async send() {
            calls.push('notice');
        },
        async createDM() {
            calls.push('resume');
            return dm;
        }
    };
    const handled = await onboarding.enforceWelcomeMessageGate({
        id: 'server-message-1',
        guild: {},
        member,
        author: {
            bot: false
        },
        webhookId: null,
        async delete() {
            calls.push('delete');
        }
    });

    assert.equal(handled, true);
    assert.deepEqual(calls, ['delete', 'notice', 'resume']);
});

for (const rankName of ['Penguin Soldier', 'Penguin Captain', 'Penguin General', 'Emperor Penguin']) {
    test(`chat gate allows ${rankName}`, async () => {
        const calls = [];
        const handled = await onboarding.enforceWelcomeMessageGate({
            guild: {},
            member: {
                roles: {
                    cache: new Collection([['rank', { name: rankName }]])
                }
            },
            author: { bot: false },
            webhookId: null,
            async delete() {
                calls.push('delete');
            }
        });

        assert.equal(handled, false);
        assert.deepEqual(calls, []);
    });
}

test('welcome flow matcher recognizes test-scoped buttons too', () => {
    const botUser = { id: 'bot-1' };
    const makeMessage = customId => ({
        author: botUser,
        client: { user: botUser },
        content: '',
        components: [{ components: [{ customId }] }]
    });

    assert.equal(onboarding._test.isWelcomeFlowMessage(makeMessage('welcome:build_team:123:live'), '123'), true);
    assert.equal(onboarding._test.isWelcomeFlowMessage(makeMessage('welcome:build_team:123:test'), '123'), true);
    assert.equal(onboarding._test.isWelcomeFlowMessage(makeMessage('welcome:build_team:456:test'), '123'), false);
    assert.equal(onboarding._test.isWelcomeFlowMessage(makeMessage('dismiss:123'), '123'), false);
});

test('test-mode completion cleans up every welcome message in the DM', async () => {
    const botUser = { id: 'bot-1' };
    const deleted = [];
    const channel = {
        id: 'dm-1',
        isDMBased: () => true,
        messages: {
            async fetch() {
                return new Collection([
                    ['final-1', {
                        id: 'final-1',
                        author: botUser,
                        client: { user: botUser },
                        content: "# ✅ You're In!",
                        components: []
                    }],
                    ['step-1', {
                        id: 'step-1',
                        author: botUser,
                        client: { user: botUser },
                        content: '',
                        components: [{ components: [{ customId: 'welcome:build_team:123456789012345:test' }] }]
                    }],
                    ['other-1', {
                        id: 'other-1',
                        author: { id: 'someone-else' },
                        content: 'hello',
                        components: []
                    }]
                ]);
            },
            async delete(messageId) {
                deleted.push(messageId);
            }
        }
    };
    const interaction = {
        channel,
        client: { user: botUser },
        message: { id: 'final-1' },
        async fetchReply() {
            return { id: 'final-1' };
        },
        async followUp() {
            return {
                id: 'countdown-1',
                edit: async () => {}
            };
        }
    };

    const result = await onboarding.scheduleTestWelcomeDmCleanup(interaction, '123456789012345', 1);

    assert.equal(result, true);
    assert.ok(deleted.includes('final-1'), 'final message deleted');
    assert.ok(deleted.includes('step-1'), 'step message deleted');
    assert.ok(deleted.includes('countdown-1'), 'countdown message deleted');
    assert.ok(!deleted.includes('other-1'), 'unrelated message untouched');
    assert.deepEqual(loadPendingWelcomeDmCleanups(), {}, 'cleanup state cleared after success');
});

test('/welcome runs a Don-only test flow in DMs', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'commands/welcome.js'), 'utf8');

    assert.match(source, /startTestOnboardingInDm/);
    assert.match(source, /isDon\(interaction\.user\.id\)/);
    assert.doesNotMatch(source, /startOnboardingForMember/);
});

test('every welcome flow message carries a dismiss X', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'utils/onboarding.js'), 'utf8');

    for (const functionName of [
        'introMessage',
        'buildTeamMessage',
        'rankUpMessage',
        'linkMinecraftMessage',
        'finalMessage'
    ]) {
        const start = source.indexOf(`function ${functionName}`);
        const nextFunction = source.indexOf('\nfunction ', start + 1);
        const body = source.slice(start, nextFunction === -1 ? source.length : nextFunction);

        assert.match(body, /dismissRow\(/, `${functionName} should include a dismiss X`);
    }
});

test('test-mode DM completion routes to the full DM cleanup', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'utils/onboarding.js'), 'utf8');

    assert.match(source, /isTest\s+\?\s+scheduleTestWelcomeDmCleanup\(interaction, targetUserId\)/);
});
