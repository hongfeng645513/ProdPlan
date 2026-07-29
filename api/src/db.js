/**
 * One connection pool per function host process.
 *
 * The pool is deliberately tiny. A Burstable B1ms Postgres server allows only
 * about 35 connections in total, and Static Web Apps scales functions out to
 * however many instances it likes — each with its own pool. A generous `max`
 * here is how you exhaust the server under mild load and start refusing
 * connections for reasons that look nothing like the cause. If this ever needs
 * to scale, turn on the Flexible Server's built-in PgBouncer rather than
 * raising this number.
 */
const { Pool } = require('pg')

let pool

function getPool() {
  if (!pool) {
    const connectionString = process.env.PGCONNSTRING
    if (!connectionString) {
      throw new Error('PGCONNSTRING is not configured on this Static Web App')
    }
    pool = new Pool({
      connectionString,
      // Azure Database for PostgreSQL refuses plaintext connections outright.
      ssl: { rejectUnauthorized: true },
      max: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
  }
  return pool
}

async function query(text, params) {
  return getPool().query(text, params)
}

module.exports = { getPool, query }
