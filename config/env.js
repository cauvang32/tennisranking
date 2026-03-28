import dotenv from 'dotenv'

// Load environment variables (idempotent — safe to call multiple times)
dotenv.config()

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

// ── Exported typed config (read once at startup) ────────────────────────────

const determineSecureCookies = () => {
  const raw = process.env.COOKIE_SECURE
  if (raw !== undefined) {
    const normalized = raw.toString().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return process.env.NODE_ENV === 'production'
}

const secureCookiesEnabled = determineSecureCookies()
const sameSitePolicy = process.env.COOKIE_SAMESITE || (secureCookiesEnabled ? 'strict' : 'lax')
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

  // Security
  jwtSecret: process.env.JWT_SECRET,
  csrfSecret: process.env.CSRF_SECRET,
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS) || 14,
  jwtAccessTokenExpiry: process.env.JWT_ACCESS_TOKEN_EXPIRY || '15m',
  jwtRefreshTokenExpiry: process.env.JWT_REFRESH_TOKEN_EXPIRY || '7d',
  jwtAlgorithm: 'HS256',

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
  subpath: process.env.SUBPATH || process.env.BASE_PATH || (process.env.NODE_ENV === 'production' ? '/tennis' : '/'),
  publicDomain: process.env.PUBLIC_DOMAIN,
  trustProxy: envFlagTrue(process.env.TRUST_PROXY) || envFlagTrue(process.env.BEHIND_PROXY) || process.env.NODE_ENV === 'production',

  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS) || 24 * 60 * 60,
  cachePreloadInterval: parseInt(process.env.CACHE_PRELOAD_INTERVAL) || 240000,

  // CORS
  allowedOrigins: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [],

  // Rate limiting
  rateLimit: {
    disabled: envFlagTrue(process.env.DISABLE_RATE_LIMITING) || envFlagTrue(process.env.DISABLE_RATELIMITING),
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
  maxSseClients: parseInt(process.env.MAX_SSE_CLIENTS) || 1000
}

export default config
