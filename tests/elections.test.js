const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const dbPath = path.join(__dirname, '..', 'db.js');
require.cache[require.resolve(dbPath)] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: async () => []
};

const {
    DON_ELECTION_ROLE_ID,
    electionWinnerIds,
    syncDonElectionRole
} = require('../utils/elections.js');

function mockMember(id, hasDonRole, changes) {
    const roleIds = new Set(hasDonRole ? [DON_ELECTION_ROLE_ID] : []);

    return {
        id,
        roles: {
            cache: {
                has: roleId => roleIds.has(roleId)
            },
            add: async role => {
                roleIds.add(role.id);
                changes.push(`add:${id}`);
            },
            remove: async role => {
                roleIds.delete(role.id);
                changes.push(`remove:${id}`);
            }
        }
    };
}

test('identifies every first-place finisher as a Don election winner', () => {
    assert.deepEqual(electionWinnerIds([
        { discord_id: 'winner-a', votes: 5 },
        { discord_id: 'winner-b', votes: 5 },
        { discord_id: 'runner-up', votes: 4 }
    ]), ['winner-a', 'winner-b']);
    assert.deepEqual(electionWinnerIds([]), []);
});

test('Don election role moves from all previous holders to the winner', async () => {
    const changes = [];
    const role = { id: DON_ELECTION_ROLE_ID, editable: true };
    const members = new Map([
        ['winner', mockMember('winner', false, changes)],
        ['old-don', mockMember('old-don', true, changes)],
        ['extra-holder', mockMember('extra-holder', true, changes)],
        ['bystander', mockMember('bystander', false, changes)]
    ]);
    const guild = {
        roles: {
            cache: new Map([[DON_ELECTION_ROLE_ID, role]]),
            fetch: async () => role
        },
        members: {
            fetch: async () => members
        }
    };

    const result = await syncDonElectionRole(guild, [
        { discord_id: 'winner', votes: 8 },
        { discord_id: 'old-don', votes: 3 }
    ]);

    assert.deepEqual(changes, ['add:winner', 'remove:old-don', 'remove:extra-holder']);
    assert.deepEqual(result, {
        added: 1,
        removed: 2,
        winnerIds: ['winner']
    });
});

test('an election with no votes leaves the existing Don role untouched', async () => {
    let fetched = false;
    const guild = {
        roles: {
            cache: new Map(),
            fetch: async () => {
                fetched = true;
            }
        }
    };

    assert.deepEqual(await syncDonElectionRole(guild, []), {
        added: 0,
        removed: 0,
        winnerIds: []
    });
    assert.equal(fetched, false);
});
