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

test('announcement dedupes allowedMentions.users so a Don-hosted giveaway (host === sponsor) does not 400', () => {
    const giveaways = source('utils/giveaways.js');

    // Discord rejects allowed_mentions.users containing the same user twice
    // (DiscordAPIError 50035 "SET_TYPE_ALREADY_CONTAINS_VALUE"). When the Don
    // hosts, host_discord_id === sponsor_discord_id, so the array must be deduped.
    assert.match(giveaways, /users:\s*\[\.\.\.new Set\(\s*\[giveaway\.host_discord_id, giveaway\.sponsor_discord_id\]\.filter\(Boolean\)\s*\)\s*\]/);
});

test('the active giveaways board warns instead of silently vanishing when the channel is missing', () => {
    const giveaways = source('utils/giveaways.js');

    assert.match(giveaways, /configured giveaway channel \$\{GIVEAWAY_CHANNEL_ID\} was not found/);
    assert.match(giveaways, /Could not post the active giveaways board/);
});