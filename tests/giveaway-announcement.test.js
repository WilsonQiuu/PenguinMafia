const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function source(relativePath) {
    return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('giveaway-starting announcement uses a name-based fallback for general chat', () => {
    const giveaways = source('utils/giveaways.js');

    assert.match(giveaways, /async function fetchGiveawayAnnouncementChannel\(guild\)/);
    assert.match(giveaways, /isGeneralChat/);
    assert.match(giveaways, /general\/i\.test/);
    assert.match(giveaways, /announcementChannel = await fetchGiveawayAnnouncementChannel\(guild\)/);
});

test('announcement post no longer fails silently', () => {
    const giveaways = source('utils/giveaways.js');

    // Must log loudly when the announcement channel is missing.
    assert.match(giveaways, /no #general chat exists/);
    assert.match(giveaways, /Could not post giveaway-starting announcement/);
});

test('the active giveaways board warns instead of silently vanishing when the channel is missing', () => {
    const giveaways = source('utils/giveaways.js');

    assert.match(giveaways, /configured giveaway channel \$\{GIVEAWAY_CHANNEL_ID\} was not found/);
    assert.match(giveaways, /Could not post the active giveaways board/);
});