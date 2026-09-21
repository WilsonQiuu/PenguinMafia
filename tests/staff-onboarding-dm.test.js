const assert = require('node:assert/strict');
const test = require('node:test');
const {
    Collection
} = require('discord.js');

const {
    handleTrialModButton,
    startTrialModOnboardingForMember
} = require('../utils/trialModOnboarding.js');
const {
    handleTrainerButton,
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

function buttonInteraction(customId, userId = '123456789012345') {
    const updates = [];
    const replies = [];

    return {
        interaction: {
            customId,
            user: { id: userId },
            channel: { isDMBased: () => true },
            async update(payload) {
                updates.push(payload);
            },
            async reply(payload) {
                replies.push(payload);
            }
        },
        replies,
        updates
    };
}

test('Trial Mod onboarding covers every DM button transition', async () => {
    const userId = '123456789012345';
    const transitions = [
        ['expectations', /ACCEPTANCE NOTES/, 'mentor'],
        ['mentor', /BEING WATCHED/, 'groups'],
        ['groups', /TRIAL GROUPS/, 'warnings'],
        ['warnings', /ONE WARNING MAX/, 'moderation'],
        ['moderation', /MODERATION GUIDELINES/, 'finish'],
        ['finish', /TRAINING COMPLETE/, 'done']
    ];

    for (const [action, contentPattern, nextAction] of transitions) {
        const fixture = buttonInteraction(`trialmod:${action}:${userId}`, userId);
        assert.equal(await handleTrialModButton(fixture.interaction), true);
        assert.equal(fixture.updates.length, 1);
        assert.match(fixture.updates[0].content, contentPattern);
        assert.equal(
            fixture.updates[0].components[0].components[0].data.custom_id,
            `trialmod:${nextAction}:${userId}`
        );
    }
});

test('Trainer onboarding covers every training button transition', async () => {
    const userId = '123456789012345';
    const transitions = [
        ['graphs', /Show The Graph/, 'team'],
        ['team', /Captain Goal/, 'rankpath'],
        ['rankpath', /Train A Captain/, 'powers'],
        ['powers', /General Goal/, 'finish'],
        ['finish', /Emperor Goal/, 'complete'],
        ['complete', /TRAINER TRAINING COMPLETE/, 'done']
    ];

    for (const [action, contentPattern, nextAction] of transitions) {
        const fixture = buttonInteraction(`trainer:${action}:${userId}`, userId);
        assert.equal(await handleTrainerButton(fixture.interaction), true);
        assert.equal(fixture.updates.length, 1);
        assert.match(fixture.updates[0].content, contentPattern);
        assert.equal(
            fixture.updates[0].components[0].components[0].data.custom_id,
            `trainer:${nextAction}:${userId}`
        );
    }
});

test('staff onboarding buttons reject a different Discord user', async () => {
    for (const [prefix, handler] of [
        ['trialmod', handleTrialModButton],
        ['trainer', handleTrainerButton]
    ]) {
        const fixture = buttonInteraction(`${prefix}:finish:123456789012345`, '999999999999999');
        assert.equal(await handler(fixture.interaction), true);
        assert.equal(fixture.updates.length, 0);
        assert.equal(fixture.replies.length, 1);
        assert.match(fixture.replies[0].content, /belongs to another/);
    }
});

test('staff onboarding completion schedules deletion of the DM message', async () => {
    for (const [prefix, handler] of [
        ['trialmod', handleTrialModButton],
        ['trainer', handleTrainerButton]
    ]) {
        const fixture = buttonInteraction(`${prefix}:done:123456789012345`);
        const cleanupCalls = [];
        const handled = await handler(fixture.interaction, {
            async scheduleDmDelete(interaction, seconds) {
                cleanupCalls.push({ interaction, seconds });
            }
        });

        assert.equal(handled, true);
        assert.equal(fixture.updates[0].components.length, 0);
        assert.deepEqual(cleanupCalls, [{ interaction: fixture.interaction, seconds: 10 }]);
    }
});

test('Trainer offer acceptance grants the role once and starts training', async () => {
    const fixture = buttonInteraction('trainer:accept:123456789012345');
    const roleAdds = [];
    const promotionEvents = [];
    const member = {
        guild: { id: 'guild-1' },
        roles: {
            cache: new Collection(),
            async add(role, reason) {
                roleAdds.push({ role, reason });
            }
        }
    };

    const handled = await handleTrainerButton(fixture.interaction, {
        async resolveMember() {
            return member;
        },
        async ensureRole() {
            return { trainerRole: { id: 'trainer-role' } };
        },
        async postPromotionEvent(guild, details) {
            promotionEvents.push({ guild, details });
        }
    });

    assert.equal(handled, true);
    assert.equal(roleAdds.length, 1);
    assert.equal(promotionEvents.length, 1);
    assert.match(fixture.updates[0].content, /TRAINER GUIDE/);
});

test('staff onboarding does not resend an active offer', async () => {
    for (const [prefix, starter] of [
        ['trialmod', startTrialModOnboardingForMember],
        ['trainer', startTrainerOnboardingForMember]
    ]) {
        const fixture = memberFixture('123456789012345');
        fixture.dm.messages.fetch = async () => new Collection([['existing', {
            author: { id: 'bot-1' },
            client: { user: { id: 'bot-1' } },
            components: [{ components: [{ customId: `${prefix}:accept:123456789012345` }] }]
        }]]);

        await starter(fixture.member);
        assert.equal(fixture.sent.length, 0, `${prefix} should not send a duplicate offer`);
    }
});

test('staff onboarding ignores unrelated and unknown button actions', async () => {
    for (const handler of [handleTrialModButton, handleTrainerButton]) {
        assert.equal(await handler(buttonInteraction('giveaway:join:123456789012345').interaction), false);
        assert.equal(await handler(buttonInteraction('trainer:missing:123456789012345').interaction), false);
    }
});
