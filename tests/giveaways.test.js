const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Collection } = require('discord.js');

process.env.DATABASE_URL ||= 'postgres://test:test@localhost/test';

const {
    APPROVED_GIVEAWAY_HOSTS,
    GIVEAWAY_WINNER_CHANNEL_ID,
    fetchGiveawayWinnerChannel,
    manualGiveawayPayoutDetails,
    manualGiveawayPayoutDmChunks,
    sponsoredGiveawayHostRequestPayload,
    sponsoredGiveawayPaymentPayload
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

test('manual giveaway payout commands support Java and Bedrock recipients', () => {
    const details = manualGiveawayPayoutDetails({
        payouts: [
            {
                amountCents: 75_000n,
                player: {
                    discord_id: 'java-user',
                    minecraft_ign: 'JavaWinner',
                    minecraft_edition: 'java'
                }
            },
            {
                amountCents: 25_050n,
                player: {
                    discord_id: 'bedrock-user',
                    minecraft_ign: 'BedrockWinner',
                    minecraft_edition: 'bedrock'
                }
            },
            {
                amountCents: 0n,
                player: {
                    minecraft_ign: 'ZeroShare',
                    minecraft_edition: 'java'
                }
            },
            {
                amountCents: 5_000n,
                player: {
                    discord_id: 'unlinked-user',
                    minecraft_ign: null,
                    minecraft_edition: null
                }
            }
        ]
    });

    assert.deepEqual(details.commands, [
        '/pay JavaWinner 750',
        '/pay .BedrockWinner 250.50'
    ]);
    assert.deepEqual(details.unresolved, [
        '<@unlinked-user> — 50 (missing a complete Minecraft account link)'
    ]);
});

test('host payout DM contains copy-ready commands and manual-review warnings', () => {
    const chunks = manualGiveawayPayoutDmChunks({
        id: 42,
        amount: 1_000_000,
        host_discord_id: 'host'
    }, {
        payouts: [
            {
                amountCents: 100_000_000n,
                player: {
                    discord_id: 'winner',
                    minecraft_ign: 'WinnerIGN',
                    minecraft_edition: 'java'
                }
            },
            {
                amountCents: 50_000n,
                player: {
                    discord_id: 'needs-link'
                }
            }
        ]
    }, 'winner');

    assert.match(chunks[0], /Manual Giveaway Payouts/);
    assert.match(chunks[0], /```text\n\/pay WinnerIGN 1000000\n```/);
    assert.match(chunks[1], /Manual review required/);
    assert.match(chunks[1], /<@needs-link> — 500/);
});

test('new giveaway endings do not enqueue automatic Minecraft payouts', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'utils/giveaways.js'), 'utf8');

    assert.doesNotMatch(source, /enqueueGiveawayPayouts/);
    assert.match(source, /sendManualGiveawayPayoutDm/);
});

test('sponsored giveaways only offer the two approved payment hosts', () => {
    assert.deepEqual(APPROVED_GIVEAWAY_HOSTS, [
        { discordId: '352217415905574914', minecraftIgn: 'itsWSQ' },
        { discordId: '719063111008780338', minecraftIgn: 'rainbowbeltzz' }
    ]);
});

test('host acceptance happens before sponsor payment instructions', () => {
    const request = {
        id: 81,
        sponsor_discord_id: 'sponsor',
        host_discord_id: '352217415905574914',
        host_minecraft_ign: 'itsWSQ',
        amount: 10_000_000n
    };
    const hostRequest = sponsoredGiveawayHostRequestPayload(request);
    const paymentPrompt = sponsoredGiveawayPaymentPayload(request);
    const hostComponents = hostRequest.components[0].toJSON().components;
    const paymentComponents = paymentPrompt.components[0].toJSON().components;

    assert.match(hostRequest.content, /accept below/i);
    assert.doesNotMatch(hostRequest.content, /\/pay/);
    assert.match(paymentPrompt.content, /\/pay itsWSQ 10m/);
    assert.ok(hostComponents.some(component => component.label === '✕'));
    assert.equal(paymentComponents[0].label, '✕');
});

test('Don giveaways do not check any Minecraft bot balance', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'commands/giveaway.js'), 'utf8');

    assert.doesNotMatch(source, /checkBalance|ensureMinecraftBotConnected|giveawayPaymentBotUser/);
    assert.match(source, /if \(isDon\(interaction\.user\.id\)\)/);
    assert.match(source, /startFundedGiveaway/);
});
