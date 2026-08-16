const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    dismissButton,
    dismissRow,
    handleDismissInteraction,
    parseDismissCustomId
} = require('../utils/dismissible.js');

const BUILT_IN_DON_DISCORD_ID = '719063111008780338';

function fakeInteraction(customId, userId) {
    const state = {
        deleted: false,
        deferred: false,
        replied: false,
        replyPayload: null
    };

    return {
        customId,
        user: { id: userId },
        message: {
            delete: async () => {
                state.deleted = true;
            }
        },
        deferUpdate: async () => {
            state.deferred = true;
        },
        reply: async payload => {
            state.replied = true;
            state.replyPayload = payload;
        },
        state
    };
}

test('parses only dismiss-prefixed custom IDs', () => {
    assert.equal(parseDismissCustomId('dismiss:12345'), '12345');
    assert.equal(parseDismissCustomId('dismiss:'), '');
    assert.equal(parseDismissCustomId('other:12345'), null);
    assert.equal(parseDismissCustomId(null), null);
    assert.equal(parseDismissCustomId(undefined), null);
});

test('builds a dismiss row with an X button owned by the recipient', () => {
    const row = dismissRow('12345');
    const button = row.components[0];
    const plain = button.toJSON();

    assert.equal(plain.custom_id, 'dismiss:12345');
    assert.equal(plain.label, '✕');
    assert.equal(plain.style, 2);
    assert.equal(dismissButton('12345').toJSON().custom_id, 'dismiss:12345');
});

test('ignores non-dismiss button interactions', async () => {
    const interaction = fakeInteraction('ticket_open', '1000');

    assert.equal(await handleDismissInteraction(interaction), false);
    assert.equal(interaction.state.deleted, false);
    assert.equal(interaction.state.replied, false);
});

test('lets only the recipient or the Don delete a dismissible DM', async () => {
    const ownerId = '2000';

    // A stranger cannot delete it.
    const stranger = fakeInteraction(`dismiss:${ownerId}`, '3000');
    assert.equal(await handleDismissInteraction(stranger), true);
    assert.equal(stranger.state.replied, true);
    assert.match(stranger.state.replyPayload.content, /Only the recipient or the Don/);
    assert.equal(stranger.state.replied, true);
    assert.equal(stranger.state.deleted, false);

    // The recipient can.
    const owner = fakeInteraction(`dismiss:${ownerId}`, ownerId);
    assert.equal(await handleDismissInteraction(owner), true);
    assert.equal(owner.state.deferred, true);
    assert.equal(owner.state.deleted, true);

    // The Don can too.
    const don = fakeInteraction(`dismiss:${ownerId}`, BUILT_IN_DON_DISCORD_ID);
    assert.equal(await handleDismissInteraction(don), true);
    assert.equal(don.state.deferred, true);
    assert.equal(don.state.deleted, true);
});

test('every bot DM includes the dismiss X button', () => {
    const dmFiles = [
        'commands/aura.js',
        'utils/accountLinkReminders.js',
        'utils/commissionPayments.js',
        'utils/hourlyRecruitRewards.js',
        'utils/onboarding.js',
        'utils/teams.js',
        'utils/vcPerks.js'
    ];

    for (const file of dmFiles) {
        const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        assert.match(
            source,
            /dismissRow\(/,
            `${file} should include a dismiss X button on its DMs`
        );
    }
});

test('wires the shared dismiss handler into the button interaction path', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

    assert.match(source, /await handleDismissInteraction\(interaction\)/);
    assert.ok(
        source.indexOf('await handleDismissInteraction(interaction)') <
        source.indexOf('await handleGiveawayButton(interaction, sql)'),
        'dismiss handling should run before the giveaway button handler'
    );
});
