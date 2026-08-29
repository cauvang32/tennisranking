import dotenv from 'dotenv'
import { join, resolve } from 'path'

// Storage helpers are also imported by isolated unit tests. Load the
// deployment environment here without importing the application-wide config,
// whose startup validation intentionally exits when auth secrets are absent.
if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: join(process.cwd(), '.env'), quiet: true })
}

export const uploadRoot = resolve(
  process.env.UPLOAD_ROOT || join(process.cwd(), 'data', 'uploads')
)

// Directory for database backup files (pg_dump custom-format .dump).
// Production should point UPLOAD_ROOT outside the Git checkout so git
// reset/redeploy cannot remove backups or uploads.
export const backupRoot = resolve(
  process.env.BACKUP_ROOT || join(process.cwd(), 'data', 'backups')
)
