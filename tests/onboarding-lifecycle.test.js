const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

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
