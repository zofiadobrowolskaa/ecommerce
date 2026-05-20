const { Pool } = require('pg');

// singleton connection pool - one Pool instance shared across the whole app.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://user:password@postgres:5432/ecommerce_db'
});

module.exports = pool;