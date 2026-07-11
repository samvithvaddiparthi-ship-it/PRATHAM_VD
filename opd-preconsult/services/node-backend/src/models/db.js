const { Pool } = require('pg');

let config;

// Railway / Heroku style DATABASE_URL takes precedence
if (process.env.DATABASE_URL) {
  config = {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('railway') || process.env.DATABASE_URL.includes('.proxy.') || process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
  };
} else {
  const password = process.env.POSTGRES_PASSWORD || 'changeme_in_production';
  // §7a — fail closed in production on a default/weak DB password (mirrors the
  // JWT_SECRET guard). The base docker-compose.yml has no `:?` guard on this, so a
  // real deployment off the base compose would otherwise silently run on defaults.
  const WEAK_DB = new Set(['', 'changeme', 'changeme_in_production', 'postgres', 'password']);
  if (process.env.NODE_ENV === 'production' && WEAK_DB.has(password)) {
    throw new Error(
      '[db] Refusing to start in production with a default/weak POSTGRES_PASSWORD. ' +
      'Set a strong POSTGRES_PASSWORD (not the .env.example placeholder).'
    );
  }
  config = {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    database: process.env.POSTGRES_DB || 'opd_preconsult',
    user: process.env.POSTGRES_USER || 'opd_user',
    password,
  };
}

console.log('[db] Connecting to:', config.connectionString ? 'DATABASE_URL' : `${config.host}:${config.port}/${config.database}`);

const pool = new Pool(config);

module.exports = pool;
