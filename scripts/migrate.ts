import '../config/env.js'
import crypto from 'crypto'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import pg from 'pg'

const migrationsDirectory = join(process.cwd(), 'migrations')
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true'
    ? { rejectUnauthorized: process.env.NODE_ENV === 'production' || process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
    : false,
  max: 1
})

const client = await pool.connect()
try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  const files = (await readdir(migrationsDirectory))
    .filter(filename => /^\d+.*\.sql$/.test(filename))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  for (const filename of files) {
    const sql = await readFile(join(migrationsDirectory, filename), 'utf8')
    const checksum = crypto.createHash('sha256').update(sql).digest('hex')
    const existing = await client.query(
      'SELECT checksum FROM schema_migrations WHERE filename = $1',
      [filename]
    )
    if (existing.rowCount > 0) {
      if (existing.rows[0].checksum !== checksum) {
        throw new Error(`Applied migration was modified: ${filename}`)
      }
      continue
    }

    await client.query('BEGIN')
    try {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('tennis-migrations'))`)
      await client.query(sql)
      await client.query(
        'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
        [filename, checksum]
      )
      await client.query('COMMIT')
      console.log(`Applied migration ${filename}`)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  }
} finally {
  client.release()
  await pool.end()
}
