import dotenv from 'dotenv'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { uploadRoot } from './upload-paths.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load environment variables (idempotent — safe to call multiple times)
dotenv.config({ path: join(__dirname, '../.env') })

// ── Helper utilities ────────────────────────────────────────────────────────

export const envFlagTrue = (value) => {
  if (value === undefined || value === null) return false
  const normalized = value.toString().trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes'
}

export const parseNumberEnv = (name, fallback) => {
  const raw = process.env[name]
  if (raw === undefined || raw === null || raw === '') return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const clampNumber = (value, min, max) => {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

// ── Validate required environment variables ─────────────────────────────────

const required = ['ADMIN_USERNAME', 'ADMIN_PASSWORD', 'EDITOR_USERNAME', 'EDITOR_PASSWORD', 'JWT_SECRET', 'CSRF_SECRET']
for (const key of required) {
  if (!process.env[key]) {
    console.error(`❌ ${key} environment variable is required`)
    process.exit(1)
  }
}

// SECURITY (S-1): Reject known-weak / guessable secrets in production.
// A leaked or guessable JWT_SECRET allows offline token forgery → full account
// takeover (verified red-team PoC). Block documented dev values and catch
// low-entropy secrets (e.g. repeated characters) that slip past the length check.
const KNOWN_WEAK_SECRETS = new Set([
  'dev_jwt_secret_32_characters_long_12345',
  'dev_csrf_secret_32_characters_long_123',
  'your_jwt_secret_at_least_32_characters_long',
  'your_csrf_secret_at_least_32_characters_long'
])
const isWeakSecret = (value) => {
  if (KNOWN_WEAK_SECRETS.has(value)) return true
  // Fewer than 10 distinct characters in a 32+ char secret is not random.
  return new Set(value.split('')).size < 10
}
if (process.env.NODE_ENV === 'production') {
  for (const key of ['JWT_SECRET', 'CSRF_SECRET']) {
    if (process.env[key].length < 32) {
      console.error(`❌ ${key} must contain at least 32 characters in production`)
      process.exit(1)
    }
    if (isWeakSecret(process.env[key])) {
      console.error(`❌ ${key} looks weak/guessable. Use a long random value (e.g. \`openssl rand -hex 32\`).`)
      process.exit(1)
    }
  }
  if (process.env.JWT_SECRET === process.env.CSRF_SECRET) {
    console.error('❌ JWT_SECRET and CSRF_SECRET must be different')
    process.exit(1)
  }
}

// ── Exported typed config (read once at startup) ────────────────────────────

const determineSecureCookies = () => {
  // Production authentication cookies must never be sent over plaintext HTTP.
  // Ignore an accidentally stale COOKIE_SECURE=false rather than silently
  // weakening every login session after a deployment.
  if (process.env.NODE_ENV === 'production') return true
  const raw = process.env.COOKIE_SECURE
  if (raw !== undefined) {
    const normalized = raw.toString().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return process.env.NODE_ENV === 'production'
}

const secureCookiesEnabled = determineSecureCookies()

/**
 * Read an RSA key from a file path given in an environment variable.
 * Returns the key string (PEM) on success, or null if the path is unset / unreadable.
 * Logs a warning on failure so the server falls back to HS256 gracefully.
 */
function _readRsaKey(envName) {
  const path = process.env[envName]
  if (!path) return null
  try {
    return readFileSync(path, 'utf8').trim()
  } catch (err) {
    console.warn(`⚠️ ${envName}="${path}" — could not read key file: ${err.message}`)
    return null
  }
}
const configuredSameSite = process.env.COOKIE_SAMESITE?.toLowerCase()
const sameSitePolicy = process.env.NODE_ENV === 'production'
  ? 'strict'
  : (['strict', 'lax', 'none'].includes(configuredSameSite) ? configuredSameSite : 'lax')
const cookieDomain = process.env.COOKIE_DOMAIN || undefined

const config = {
  // Server
  port: parseInt(process.env.PORT) || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',
  isDevelopment: process.env.NODE_ENV === 'development',
  isProduction: process.env.NODE_ENV === 'production',

  // Auth credentials
  admin: {
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD,
    email: process.env.ADMIN_EMAIL || 'admin@tennis.local'
  },
  editor: {
    username: process.env.EDITOR_USERNAME,
    password: process.env.EDITOR_PASSWORD,
    email: process.env.EDITOR_EMAIL || 'editor@tennis.local'
  },
  // H3: Allow disabling env-based accounts at runtime (e.g. after creating DB users)
  disableEnvAdmin: envFlagTrue(process.env.DISABLE_ENV_ADMIN),
  disableEnvEditor: envFlagTrue(process.env.DISABLE_ENV_EDITOR),

  // Security
  jwtSecret: process.env.JWT_SECRET,
  // RSA key pair for RS256 (asymmetric JWT signing — 2026 OWASP recommendation).
  // Store file *paths* in env; keys are read from disk at startup.
  // If either path is missing or unreadable, RS256 is disabled and HS256 is used.
  rsaPrivateKey: _readRsaKey('RSA_PRIVATE_KEY_PATH') || null,
  rsaPublicKey: _readRsaKey('RSA_PUBLIC_KEY_PATH') || null,
  csrfSecret: process.env.CSRF_SECRET,
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS) || 12, // 2^12 = 4096 work factor (OWASP min 2^10)
  jwtAccessTokenExpiry: process.env.JWT_ACCESS_TOKEN_EXPIRY || '15m',
  jwtRefreshTokenExpiry: process.env.JWT_REFRESH_TOKEN_EXPIRY || '7d',
  jwtIssuer: process.env.JWT_ISSUER || 'tennis-ranking',
  jwtAudience: process.env.JWT_AUDIENCE || 'tennis-ranking-web',
  // Prefer RS256 (asymmetric) when valid RSA keys are provided; fall back to HS256 otherwise.
  // Keys shorter than 200 chars are clearly invalid (just a header) — skip RS256.
  jwtAlgorithm: (() => {
    const priv = _readRsaKey('RSA_PRIVATE_KEY_PATH')
    const pub = _readRsaKey('RSA_PUBLIC_KEY_PATH')
    const privLen = (priv || '').length
    const pubLen = (pub || '').length
    if (privLen > 200 && pubLen > 100) return 'RS256'
    return 'HS256'
  })(),

  // Cookie
  cookie: {
    secure: secureCookiesEnabled,
    sameSite: sameSitePolicy,
    domain: cookieDomain,
    defaults: {
      httpOnly: true,
      secure: secureCookiesEnabled,
      sameSite: sameSitePolicy
    }
  },

  // Subpath / deployment
  // Normalized to always have a trailing slash (or '/' for root) for consistency
  subpath: (() => {
    const raw = process.env.SUBPATH || process.env.BASE_PATH || (process.env.NODE_ENV === 'production' ? '/tennis' : '/')
    return raw ? (raw.endsWith('/') ? raw : `${raw}/`) : '/'
  })(),
  // Graceful shutdown timeout in milliseconds (4500ms default)
  shutdownTimeoutMs: parseInt(process.env.SHUTDOWN_TIMEOUT_MS) || 4500,
  publicDomain: process.env.PUBLIC_DOMAIN,
  // Express proxy trust changes the security boundary for req.ip and all
  // IP-based rate limits. It must be an explicit deployment decision.
  trustProxy: envFlagTrue(process.env.TRUST_PROXY) || envFlagTrue(process.env.BEHIND_PROXY),
  trustProxyHops: Math.max(1, parseInt(process.env.TRUST_PROXY_HOPS, 10) || 1),

  // User-generated files are persistent application data. Production should
  // point this outside the Git checkout (for example
  // /home/vps/tennisranking-data/uploads) so git reset/redeploy cannot remove it.
  uploadRoot,

  // Database connection pool
  // Default of 10 is reasonable for a single-worker app; increase for PM2 cluster mode.
  // Each PM2 instance creates its own pool, so total connections = instances * dbPoolMax.
  dbPoolMax: parseInt(process.env.DB_POOL_MAX) || 10,
  dbIdleTimeoutMs: parseInt(process.env.DB_IDLE_TIMEOUT_MS) || 30000,
  dbConnectionTimeoutMs: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS) || 2000,
  dbStatementTimeoutMs: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS) || 30000,
  dbSlowQueryMs: parseInt(process.env.DB_SLOW_QUERY_MS) || 500,
  // Legacy PM2/Compose deployments historically bootstrap idempotent tables
  // from database-postgresql.js. Kubernetes runs a dedicated migration Job,
  // so its application pods set DB_AUTO_SCHEMA=false to keep schema ownership
  // out of horizontally scaled processes.
  dbAutoSchema: process.env.DB_AUTO_SCHEMA === undefined
    ? true
    : envFlagTrue(process.env.DB_AUTO_SCHEMA),

  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  queueRedisUrl: process.env.QUEUE_REDIS_URL || process.env.REDIS_URL || 'redis://localhost:6379',
  rateLimitRedisUrl: process.env.RATE_LIMIT_REDIS_URL || process.env.REDIS_URL || 'redis://localhost:6379',
  cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS) || 24 * 60 * 60,
  cachePreloadInterval: parseInt(process.env.CACHE_PRELOAD_INTERVAL) || 240000,

  // CORS
  // Validate each origin: must be a valid http(s) URL, trimmed, no empty strings.
  allowedOrigins: (() => {
    if (!process.env.ALLOWED_ORIGINS) return []
    return process.env.ALLOWED_ORIGINS
      .split(',')
      .map(o => o.trim())
      .filter(o => o !== '')
      .map(o => {
        if (o === 'null') {
          if (process.env.NODE_ENV === 'production') {
            console.warn('⚠️ ALLOWED_ORIGINS: ignoring unsafe "null" origin in production')
            return null
          }
          return 'null'
        }
        // Strip path and query from configured origins for comparison with Origin header.
        // The browser sends Origin without path (e.g., "https://tennis.example.com"),
        // but admins may configure origins with paths (e.g., "https://tennis.example.com/tennis").
        try {
          const url = new URL(o)
          if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
            console.warn(`⚠️ ALLOWED_ORIGINS: ignoring non-HTTPS production origin "${o}"`)
            return null
          }
          return `${url.protocol}//${url.host}`
        } catch {
          console.warn(`⚠️ ALLOWED_ORIGINS: ignoring invalid origin "${o}" (must start with http:// or https://)`)
          return null
        }
      })
      .filter(o => o !== null)
  })(),

  // Rate limiting
  rateLimit: {
    disabled: envFlagTrue(process.env.DISABLE_RATE_LIMITING) || envFlagTrue(process.env.DISABLE_RATELIMITING),
    bypassInDev: envFlagTrue(process.env.RATE_LIMIT_BYPASS_IN_DEV),
    redisTimeoutMs: parseInt(process.env.RATE_LIMIT_REDIS_TIMEOUT_MS) || 120000,
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 1000,
    apiMax: parseInt(process.env.RATE_LIMIT_API_MAX) || 100,
    anonymousMax: parseInt(process.env.RATE_LIMIT_ANONYMOUS_MAX) || 50,
    authenticatedMax: parseInt(process.env.RATE_LIMIT_AUTHENTICATED_MAX) || 200,
    dynamic: {
      enabled: envFlagTrue(process.env.RATE_LIMIT_DYNAMIC_ENABLED),
      sampleMs: parseInt(process.env.RATE_LIMIT_DYNAMIC_SAMPLE_MS) || 5000,
      cpuHighPct: clampNumber(parseNumberEnv('RATE_LIMIT_CPU_HIGH_PCT', 80), 0, 1000),
      cpuCriticalPct: clampNumber(parseNumberEnv('RATE_LIMIT_CPU_CRITICAL_PCT', 95), 0, 1000),
      ramHighPct: clampNumber(parseNumberEnv('RATE_LIMIT_RAM_HIGH_PCT', 85), 0, 100),
      ramCriticalPct: clampNumber(parseNumberEnv('RATE_LIMIT_RAM_CRITICAL_PCT', 95), 0, 100),
      scaleHigh: clampNumber(parseNumberEnv('RATE_LIMIT_DYNAMIC_SCALE_HIGH', 0.7), 0.01, 1),
      scaleCritical: clampNumber(parseNumberEnv('RATE_LIMIT_DYNAMIC_SCALE_CRITICAL', 0.4), 0.01, 1),
      minScale: clampNumber(parseNumberEnv('RATE_LIMIT_DYNAMIC_MIN_SCALE', 0.2), 0.01, 1)
    }
  },

  // Request timeout
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS) || 30000,

  // SSE
  maxSseClients: parseInt(process.env.MAX_SSE_CLIENTS) || 200, // Reduced from 1000 for security

  // FCM push notifications. When serviceAccountPath is unset or the file is
  // missing, the push sender runs in disabled/no-op mode so the server boots
  // fine without Firebase configured (e.g. local dev).
  firebase: {
    serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || null
  },

  // FCM device-token retention window. Tokens not refreshed in this many days
  // are reaped by the daily cleanup. FCM docs recommend 30 ("hasn't connected
  // for a month"). Lower = less bloat, higher = more forgiving for inactive users.
  fcm: {
    tokenRetentionDays: parseInt(process.env.FCM_TOKEN_RETENTION_DAYS) || 30,
    maxDevicesPerUser: parseInt(process.env.FCM_MAX_DEVICES_PER_USER) || 10,
    maxGuestDevicesPerIp: parseInt(process.env.FCM_MAX_GUEST_DEVICES_PER_IP) || 5
  },

  // Auto-redirect from domain root to subpath (e.g. domain.com → domain.com/tennis).
  // Set to false to serve the app at the domain root without redirecting.
  allowSubpathRedirect: process.env.ALLOW_SUBPATH_REDIRECT === undefined
    ? true
    : envFlagTrue(process.env.ALLOW_SUBPATH_REDIRECT),

  // AI Image Parser (optional — if AI_MODEL is set, AI_API_KEY becomes required)
  ai: {
    apiKey: process.env.AI_API_KEY || null,
    model: process.env.AI_MODEL || null,
    baseUrl: (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
  }
}

// Validate: if AI_MODEL is set, AI_API_KEY is required
if (config.ai.model) {
  if (!config.ai.apiKey) {
    console.error('❌ AI_MODEL is set but AI_API_KEY is missing')
    process.exit(1)
  }
}

export default config
