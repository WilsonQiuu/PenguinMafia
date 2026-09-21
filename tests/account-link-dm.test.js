const assert = require('node:assert/strict');
const test = require('node:test');
const {
    Collection
} = require('discord.js');

process.env.DATABASE_URL ||= 'postgres://test:test@localhost/test';

const {
    handleAccountLinkButton,
    handleAccountLinkModal,
    remindUnlinkedPlayers
} = require('../utils/accountLinkReminders.js');

function queuedDatabase(...results) {
    const calls = [];
    const db = async (strings, ...values) => {
        calls.push({ sql: strings.join('?'), values });
        return results.shift() || [];
    };
    db.calls = calls;
    return db;
}

function accountLinkInteraction(customId, userId = '123456789012345') {
    const calls = [];
    return {
        calls,
        interaction: {
            customId,
            user: {
                id: userId,
                username: 'NewPenguin'
            },
            client: {
                guilds: {
                    cache: new Collection(),
                    async fetch() {
                        return null;
                    }
                }
            },
            fields: {
                getTextInputValue() {
                    return 'PenguinPlayer';
                },
                getStringSelectValues() {
                    return ['java'];
                }
            },
            async reply(payload) {
                calls.push(['reply', payload]);
            },
            async showModal(payload) {
                calls.push(['showModal', payload]);
            },
            async deferReply(payload) {
                calls.push(['deferReply', payload]);
            },
            async editReply(payload) {
                calls.push(['editReply', payload]);
            }
        }
    };
}

test('account-link button ignores unrelated interactions', async () => {
    const fixture = accountLinkInteraction('welcome:start:123456789012345');

    assert.equal(await handleAccountLinkButton(fixture.interaction), false);
    assert.deepEqual(fixture.calls, []);
});

test('account-link button enforces DM ownership', async () => {
    const fixture = accountLinkInteraction('account_link_open:123456789012345', '999999999999999');

    assert.equal(await handleAccountLinkButton(fixture.interaction), true);
    assert.equal(fixture.calls[0][0], 'reply');
    assert.match(fixture.calls[0][1].content, /belongs to another player/);
});

test('account-link button opens a prefilled modal for an incomplete account', async () => {
    const fixture = accountLinkInteraction('account_link_open:123456789012345');
    const db = queuedDatabase([{
        minecraft_ign: 'ExistingIgn',
        minecraft_edition: null
    }]);

    assert.equal(await handleAccountLinkButton(fixture.interaction, db), true);
    assert.equal(fixture.calls[0][0], 'showModal');
    assert.equal(fixture.calls[0][1].data.custom_id, 'account_link_submit:123456789012345');
});

test('account-link button reports missing and already-linked players', async () => {
    for (const [rows, pattern] of [
        [[], /could not be found/],
        [[{ minecraft_ign: 'PenguinPlayer', minecraft_edition: 'java' }], /already fully linked/]
    ]) {
        const fixture = accountLinkInteraction('account_link_open:123456789012345');
        assert.equal(await handleAccountLinkButton(fixture.interaction, queuedDatabase(rows)), true);
        assert.match(fixture.calls[0][1].content, pattern);
    }
});

test('account-link modal validates ownership, IGN, and edition', async () => {
    const wrongOwner = accountLinkInteraction('account_link_submit:123456789012345', '999999999999999');
    assert.equal(await handleAccountLinkModal(wrongOwner.interaction), true);
    assert.match(wrongOwner.calls[0][1].content, /belongs to another player/);

    const invalidIgn = accountLinkInteraction('account_link_submit:123456789012345');
    invalidIgn.interaction.fields.getTextInputValue = () => 'x!';
    assert.equal(await handleAccountLinkModal(invalidIgn.interaction), true);
    assert.match(invalidIgn.calls[0][1].content, /3.*16 characters/);

    const invalidEdition = accountLinkInteraction('account_link_submit:123456789012345');
    invalidEdition.interaction.fields.getStringSelectValues = () => ['console'];
    assert.equal(await handleAccountLinkModal(invalidEdition.interaction), true);
    assert.match(invalidEdition.calls[0][1].content, /Java or Bedrock/);
});

test('account-link modal persists a valid account and confirms completion', async () => {
    const fixture = accountLinkInteraction('account_link_submit:123456789012345');
    const db = queuedDatabase([{ discord_id: '123456789012345' }]);

    assert.equal(await handleAccountLinkModal(fixture.interaction, db), true);
    assert.equal(fixture.calls[0][0], 'deferReply');
    assert.equal(fixture.calls[1][0], 'editReply');
    assert.match(fixture.calls[1][1], /Minecraft account linked/);
    assert.deepEqual(db.calls[0].values.slice(0, 3), [
        'NewPenguin',
        'PenguinPlayer',
        'java'
    ]);
});

test('account-link modal reports when the player disappears before update', async () => {
    const fixture = accountLinkInteraction('account_link_submit:123456789012345');

    assert.equal(await handleAccountLinkModal(fixture.interaction, queuedDatabase([])), true);
    assert.equal(fixture.calls[1][0], 'editReply');
    assert.match(fixture.calls[1][1], /could not be found/);
});

test('account-link reminders DM eligible humans and record successful delivery', async () => {
    const sent = [];
    const db = queuedDatabase(
        [
            { discord_id: 'human', minecraft_ign: null, minecraft_edition: null },
            { discord_id: 'bot', minecraft_ign: null, minecraft_edition: null },
            { discord_id: 'missing', minecraft_ign: null, minecraft_edition: null }
        ],
        []
    );
    const guild = {
        members: {
            async fetch(userId) {
                if (userId === 'human') {
                    return {
                        user: { bot: false, tag: 'human' },
                        async send(payload) {
                            sent.push(payload);
                        }
                    };
                }
                if (userId === 'bot') return { user: { bot: true } };
                throw new Error('unknown member');
            }
        }
    };

    const result = await remindUnlinkedPlayers(guild, db);

    assert.deepEqual(result, { checked: 3, sent: 1 });
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /Account Reminder/);
    assert.equal(db.calls.length, 2);
    assert.deepEqual(db.calls[1].values, ['human']);
});
