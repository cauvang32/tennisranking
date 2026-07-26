import dotenv from 'dotenv'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Storage helpers are also imported by isolated unit tests. Load the
// deployment environment here without importing the application-wide config,
// whose startup validation intentionally exits when auth secrets are absent.
if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: join(__dirname, '../.env'), quiet: true })
}

export const uploadRoot = resolve(
  process.env.UPLOAD_ROOT || join(__dirname, '..', 'data', 'uploads')
)
