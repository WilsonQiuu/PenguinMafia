const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

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

test('welcome command no longer references the dismiss X', () => {
    const welcome = source('commands/welcome.js');

    assert.doesNotMatch(welcome, /✕/);
    assert.match(welcome, /cleans the DM up automatically/);
    assert.match(welcome, /when it comes back online/);
});