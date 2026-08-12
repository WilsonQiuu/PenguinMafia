const assert = require('node:assert/strict');
const test = require('node:test');
const {
    Collection
} = require('discord.js');

const {
    startTrialModOnboardingForMember
} = require('../utils/trialModOnboarding.js');
const {
    startTrainerOnboardingForMember
} = require('../utils/trainerOnboarding.js');

function memberFixture(userId) {
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
                id: `message-${userId}`
            };
        }
    };
    const member = {
        id: userId,
        user: {
            id: userId,
            username: `penguin-${userId}`
        },
        toString() {
            return `<@${userId}>`;
        },
        guild: {
            channels: {
                async create() {
                    throw new Error('staff onboarding must not create a guild channel');
                }
            }
        },
        async createDM() {
            return dm;
        }
    };

    return {
        dm,
        member,
        sent
    };
}

test('Trial Mod onboarding starts in DMs', async () => {
    const fixture = memberFixture('123456789012345');

    const result = await startTrialModOnboardingForMember(fixture.member);

    assert.equal(result, fixture.dm);
    assert.equal(fixture.sent.length, 1);
    assert.match(fixture.sent[0].content, /TRIAL MOD TRAINING/);
});

test('Trainer onboarding starts in DMs', async () => {
    const fixture = memberFixture('123456789012346');

    const result = await startTrainerOnboardingForMember(fixture.member);

    assert.equal(result, fixture.dm);
    assert.equal(fixture.sent.length, 1);
    assert.match(fixture.sent[0].content, /PENGUIN TRAINER/);
});
