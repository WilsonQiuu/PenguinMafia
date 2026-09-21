const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    GatewayIntentBits,
    Partials
} = require('discord.js');
const {
    discordClientOptions
} = require('../utils/discordClientOptions.js');

function source(relativePath) {
    return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('welcome tutorial messages no longer carry the dismiss X button', () => {
    const onboarding = source('utils/onboarding.js');

    // The five tutorial builders must not attach dismissRow anymore.
    assert.doesNotMatch(onboarding, /dismissRow\(member\.id\)/);
    assert.doesNotMatch(onboarding, /dismissRow\(userId\)/);

    // dismissRow should now only appear as an import plus the onboarding
    // gate notice (which has no auto-delete, so it keeps its X).
    const dismissCalls = (onboarding.match(/dismissRow\(/g) || []).length;
    assert.equal(dismissCalls, 1);
    assert.match(onboarding, /dismissRow\(message\.member\.id\)/);
});

test('welcome tutorial auto-deletes on completion in both live and test flows', () => {
    const onboarding = source('utils/onboarding.js');

    assert.match(onboarding, /scheduleWelcomeMessageDelete/);
    assert.match(onboarding, /scheduleTestWelcomeDmCleanup/);
    assert.match(onboarding, /isWelcomeFlowMessage/);
});

test('live DM cleanup sweeps every welcome-flow message, not just the final one', () => {
    const onboarding = source('utils/onboarding.js');

    assert.match(onboarding, /isWelcomeFlowMessage\(message, interaction\.user\.id\)/);
    assert.match(onboarding, /isWelcomeFlowMessage\(message, targetUserId\)/);
});

test('pending deletions are persisted so restarts cannot leave zombies', () => {
    const onboarding = source('utils/onboarding.js');

    assert.match(onboarding, /WELCOME_DM_CLEANUP_STATE_FILE/);
    assert.match(onboarding, /savePendingWelcomeDmCleanups/);
    assert.match(onboarding, /recordPendingWelcomeDmCleanup/);
    assert.match(onboarding, /clearPendingWelcomeDmCleanup/);
});

test('startup resumes and deletes any messages left pending by a crash', () => {
    const onboarding = source('utils/onboarding.js');
    const index = source('index.js');

    assert.match(onboarding, /async function resumePendingWelcomeDmCleanups\(client\)/);
    assert.match(onboarding, /error\?\.code !== 10008/);
    assert.match(index, /resumePendingWelcomeDmCleanups\(client\)/);
});

test('Discord client subscribes to DM events for welcome buttons and modals', () => {
    assert.ok(discordClientOptions.intents.includes(GatewayIntentBits.DirectMessages));
    assert.ok(discordClientOptions.partials.includes(Partials.Channel));
});

test('new joins refresh welcome DMs and report blocked delivery publicly', () => {
    const index = source('index.js');

    assert.match(index, /deliverOnboardingForMember\(member, \{/);
    assert.match(index, /refresh: true/);
    assert.match(index, /Enable \*\*Direct Messages\*\*/);
});

test('startup recovery refreshes welcome DMs for currently affected members', () => {
    const index = source('index.js');
    const startupCalls = index.match(/deliverOnboardingForMember\(member, \{[\s\S]*?refresh: true[\s\S]*?\}\);/g) || [];

    assert.ok(startupCalls.length >= 2);
    assert.match(index, /onboarding DMs blocked=/);
});

test('welcome command no longer references the dismiss X', () => {
    const welcome = source('commands/welcome.js');

    assert.doesNotMatch(welcome, /✕/);
    assert.match(welcome, /fresh welcome tutorial was sent/);
    assert.match(welcome, /Welcome DM could not be delivered/);
});
