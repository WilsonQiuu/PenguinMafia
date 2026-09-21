const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function source(relativePath) {
    return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('database pool stays small and recycles Railway connections', () => {
    const database = source('db.js');

    assert.match(database, /DATABASE_POOL_SIZE \|\| 3/);
    assert.match(database, /DATABASE_IDLE_TIMEOUT_SECONDS \|\| 20/);
    assert.match(database, /DATABASE_MAX_LIFETIME_SECONDS \|\| 300/);
});

test('expensive auxiliary member scans are opt-in during startup', () => {
    const index = source('index.js');

    assert.match(index, /STARTUP_AUXILIARY_MEMBER_SYNC === 'true'/);
    assert.match(index, /auxiliary Iceberg member sync skipped/);
    assert.match(index, /auxiliary VC perk member sync skipped/);
});
