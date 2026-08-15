const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');

process.env.DATABASE_URL ||= 'postgres://test:test@localhost/test';

const {
    GIVEAWAY_WINNER_CHANNEL_ID,
    fetchGiveawayWinnerChannel
} = require('../utils/giveaways.js');

function textChannel(id, name) {
    return {
        id,
        name,
        isTextBased: () => true
    };
}

test('winner announcements use the configured giveaway winners channel first', async () => {
    assert.equal(GIVEAWAY_WINNER_CHANNEL_ID, '1536602944605134958');

    const winnerChannel = textChannel(GIVEAWAY_WINNER_CHANNEL_ID, '🎉・giveaway-winners');
    let fetchedAllChannels = false;
    const guild = {
        channels: {
            cache: new Collection(),
            fetch: async channelId => {
                if (channelId === GIVEAWAY_WINNER_CHANNEL_ID) {
                    return winnerChannel;
                }

                fetchedAllChannels = true;
                return new Collection();
            }
        }
    };

    assert.equal(await fetchGiveawayWinnerChannel(guild), winnerChannel);
    assert.equal(fetchedAllChannels, false);
});

test('winner channel lookup discovers a recreated channel when the configured ID is stale', async () => {
    const replacement = textChannel('replacement-channel', '🎉・giveaway-winners');
    const fetchedChannels = new Collection([[replacement.id, replacement]]);
    const guild = {
        channels: {
            cache: new Collection(),
            fetch: async channelId => channelId ? null : fetchedChannels
        }
    };

    const channel = await fetchGiveawayWinnerChannel(guild);

    assert.equal(channel, replacement);
});

test('winner channel lookup ignores unrelated text channels', async () => {
    const fetchedChannels = new Collection([
        ['general-channel', textChannel('general-channel', '💬・general')]
    ]);
    const guild = {
        channels: {
            cache: new Collection(),
            fetch: async channelId => channelId ? null : fetchedChannels
        }
    };

    const channel = await fetchGiveawayWinnerChannel(guild);

    assert.equal(channel, null);
});
