const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function source(relativePath) {
    return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('trust requirements are 2 admin vouches + 3 total vouches', () => {
    const trust = source('utils/trust.js');

    assert.match(trust, /ICEBERG_ADMIN_VOUCHES_REQUIRED = 2/);
    assert.match(trust, /ICEBERG_TOTAL_VOUCHES_REQUIRED = 3/);
    assert.match(trust, /2 Admin vouches.*3 total/m);
});

test('eligibility requires 2 admin vouches, 3 total vouches and no admin vetoes', () => {
    const trust = source('utils/trust.js');

    assert.match(trust, /isIcebergEligible/);
    assert.match(trust, /admin_vouches \|\| 0\) >= ICEBERG_ADMIN_VOUCHES_REQUIRED/);
    assert.match(trust, /vouches \|\| 0\) >= ICEBERG_TOTAL_VOUCHES_REQUIRED/);
    assert.match(trust, /admin_vetoes \|\| 0\) === 0/);
    assert.match(trust, /shouldHaveRole =\s*isAdmin \|\|\s*isIcebergEligible\(profile\)/);
});

test('trust summary shows progress toward 2 admin and 3 total vouches', () => {
    const trust = source('utils/trust.js');

    assert.match(trust, /Admin vouches: \*\*\$\{profile\.admin_vouches\}\/\$\{ICEBERG_ADMIN_VOUCHES_REQUIRED\}\*\*/);
    assert.match(trust, /Total vouches: \*\*\$\{profile\.vouches\}\/\$\{ICEBERG_TOTAL_VOUCHES_REQUIRED\}\*\*/);
});

test('regular (iceberg penguin) vouches count toward the total requirement', () => {
    const vouche = source('commands/vouche.js');

    assert.match(vouche, /Regular vouches from Iceberg Penguins count toward the \*\*3 total vouches\*\*/);
    assert.match(vouche, /willBeIcebergAfterVouch\(target, deltas\)/);
    assert.match(vouche, /admin: 0, total: 1/);
    assert.match(vouche, /Iceberg Penguin needs \*\*2 Admin vouches\*\* and \*\*3 total vouches\*\*/);
});

test('removing any vouch re-evaluates iceberg penguin role', () => {
    const unvouche = source('commands/unvouche.js');

    assert.match(unvouche, /Regular vouches count toward the 3 total vouches needed/);
    assert.match(unvouche, /const roleResult = result\.removed/);
});

test('vouches command hides veto sources from non-admins', () => {
    const vouches = source('commands/vouches.js');

    assert.match(vouches, /isAdminViewer/);
    assert.match(vouches, /sources are only visible to staff/);
    assert.match(vouches, /isDon\(interaction\.user\.id\)/);
    assert.match(vouches, /Needs \$/);
});

test('vetoes are never announced publicly', () => {
    const veto = source('commands/veto.js');
    const unveto = source('commands/unveto.js');

    assert.doesNotMatch(veto, /channel\.send/);
    assert.doesNotMatch(unveto, /channel\.send/);
});

test('promoting to admin converts previously given regular vouches to admin vouches', () => {
    const trust = source('utils/trust.js');
    const promotestaff = source('commands/promotestaff.js');

    assert.match(trust, /promoteRegularVouchesToAdminVouches/);
    assert.match(trust, /delete from player_vouches/);
    assert.match(trust, /insert into player_admin_vouches/);
    assert.match(promotestaff, /promoteRegularVouchesToAdminVouches\(sql, playerUser\.id\)/);
});