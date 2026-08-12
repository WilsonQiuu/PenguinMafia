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
        categoryDeleted: true
    });
    assert.deepEqual(new Set(deleted), new Set(['welcome-1', 'trainer-1', 'trial-1', 'category-1']));
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
