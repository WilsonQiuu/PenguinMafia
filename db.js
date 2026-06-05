const postgres = require('postgres');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    throw new Error('DATABASE_URL is missing from .env');
}

const sql = postgres(connectionString, {
    ssl: 'require',
    onnotice: () => {}
});

module.exports = sql;
