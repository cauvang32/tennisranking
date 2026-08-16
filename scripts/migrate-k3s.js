/**
 * K3s database bootstrap and migration entrypoint.
 *
 * The long-lived PM2 deployment historically creates its core schema during
 * DB.init(), while older feature migrations are Docker-oriented shell scripts.
 * K3s needs a deterministic Job that can initialize a fresh CloudNativePG
 * cluster without changing the behavior of `npm run migrate` for PM2.
 */
import crypto from 'crypto'
import { readFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { extractSqlHeredocs } from './migration-utils.js'

process.env.DB_AUTO_SCHEMA = 'true'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationsDirectory = join(__dirname, '..', 'migrations')
const legacyMigrations = [
  '04-add-ranking-summary.sh',
  '05-fix-trigger-unnest.sh',
  '06-add-score-difference.sh',
  '07-add-daily-stats.sh',
  '08-add-site-images.sh',
  '09-add-season-results.sh',
  '10-add-cup-tournaments.sh',
  '11-add-cup-results.sh'
]

const { default: TennisDatabase } = await import('../database-postgresql.js')
const db = new TennisDatabase()
const initialized = await db.init()
if (!initialized || !db.pool) throw new Error('Core database bootstrap failed')

const client = await db.pool.connect()
try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS k3s_legacy_migrations (
      filename TEXT PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  for (const filename of legacyMigrations) {
    const source = await readFile(join(migrationsDirectory, filename), 'utf8')
    const sql = extractSqlHeredocs(source, filename)
    const checksum = crypto.createHash('sha256').update(sql).digest('hex')
    await client.query('BEGIN')
    try {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('tennis-k3s-legacy-migrations'))`)
      const existing = await client.query(
        'SELECT checksum FROM k3s_legacy_migrations WHERE filename = $1',
        [filename]
      )
      if (existing.rowCount > 0) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`Applied K3s migration was modified: ${filename}`)
        }
        await client.query('COMMIT')
        continue
      }

      await client.query(sql)
      await client.query(
        'INSERT INTO k3s_legacy_migrations (filename, checksum) VALUES ($1, $2)',
        [filename, checksum]
      )
      await client.query('COMMIT')
      console.log(`Applied K3s legacy migration ${filename}`)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  }
} finally {
  client.release()
  await db.close()
}

// Apply the checksum-protected native SQL migrations last.
await import('./migrate.js')
