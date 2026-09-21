const postgres = require('postgres');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    throw new Error('DATABASE_URL is missing from .env');
}

const sql = postgres(connectionString, {
    ssl: 'require',
    // Railway shares Supabase's pooler with several long-running bot jobs.
    // Keep the client pool small and recycle idle connections so startup
    // member scans do not exhaust or retain stale pooler sessions.
    max: Number(process.env.DATABASE_POOL_SIZE || 3),
    idle_timeout: Number(process.env.DATABASE_IDLE_TIMEOUT_SECONDS || 20),
    connect_timeout: Number(process.env.DATABASE_CONNECT_TIMEOUT_SECONDS || 15),
    max_lifetime: Number(process.env.DATABASE_MAX_LIFETIME_SECONDS || 300),
    onnotice: () => {}
});

module.exports = sql;
