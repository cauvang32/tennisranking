/**
 * 🎾 Tennis Ranking System — Server Entry Point
 *
 * This file is the thin orchestration layer. All logic is delegated to:
 *   config/     — environment, cookie, CORS settings
 *   lib/        — Redis cache, JWT encryption, security helpers
 *   middleware/  — auth, CSRF, compression, rate limiting
 *   routes/     — API routes grouped by domain
 *
 * Runs identically under: bare-metal node, PM2 cluster, or Docker.
 */

import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import cors from 'cors'
import helmet from 'helmet'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import cookieParser from 'cookie-parser'
import { validationResult } from 'express-validator'

// ── Internal modules ────────────────────────────────────────────────────────
import config from './config/env.js'
import { withCookieDefaults, clearCookieAllPaths } from './config/cookie.js'
import { generateToken, generateRefreshToken, readToken, verifyToken } from './lib/jwt-encryption.js'
import { globalCSRFProtection, deriveCSRFSecretFromUser, tokens } from './middleware/csrf.js'
import { createCompressionMiddleware } from './middleware/compression.js'
import {
  applyGlobalRateLimiting, logRateLimitConfig, disconnectRateLimitRedis,
  initRateLimitRedis,
  authLimiter, refreshLimiter, initLimiter, smartApiLimiter, conditionalRateLimit,
  createLimiter, deleteLimiter, exportLimiter, criticalLimiter, restoreLimiter,
  strictRestoreLimiter, loginLimiter, deviceRegisterLimiter, cspReportLimiter
} from './middleware/rate-limiter.js'
import { buildAuthMiddleware } from './middleware/auth.js'
import { createTimeoutMiddleware } from './utils/async-handler.js'
import RedisCache from './lib/redis-cache.js'
import TennisDatabase from './database-postgresql.js'
import { createPushSender } from './lib/push-sender.js'
import { getRealClientIP, logAccess } from './access-logger.js'

// Route factories
import { createPlayerRouter } from './routes/players.js'
import { createSeasonRouter } from './routes/seasons.js'
import { createMatchRouter } from './routes/matches.js'
import { createRankingRouter } from './routes/rankings.js'
import { createExportRouter } from './routes/export.js'
import { createAuthRouter } from './routes/users.js'
import { createAdminRouter } from './routes/admin.js'
import { createBackupRouter } from './routes/backup.js'
import { createHealthRouter } from './routes/health.js'
import { createSystemRouter } from './routes/system.js'
import { createDeviceRouter } from './routes/devices.js'
import { createInlineAuthRouter } from './routes/auth-inline.js'

// ── Bootstrap ───────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const PORT = config.port
const SUBPATH = config.subpath
// L1: Hoist subpathNorm to module scope — computed once, reused in two middleware locations
const subpathNorm = SUBPATH.endsWith('/') ? SUBPATH.slice(0, -1) : SUBPATH
const isDevelopment = config.isDevelopment

console.log('🎯 Server subpath configuration:', SUBPATH)
console.log('🔧 Environment:', config.nodeEnv)

// ── Hash passwords on startup ───────────────────────────────────────────────

const hashedAdminPassword = await bcrypt.hash(config.admin.password, config.bcryptRounds)
const hashedEditorPassword = await bcrypt.hash(config.editor.password, config.bcryptRounds)

// ── Database & Cache ────────────────────────────────────────────────────────

const db = new TennisDatabase()
const dbReady = await db.init()
if (!dbReady) {
  console.warn('⚠️  PostgreSQL unavailable at startup - server will keep retrying in the background')
}

// One-time check for expired seasons at startup (previously per-request in seasons routes).
if (db.pool) {
  try {
    const expiredSeasons = await db.checkAndEndExpiredSeasons()
    if (expiredSeasons.length > 0) {
      console.log(`🏁 Auto-ended ${expiredSeasons.length} expired season(s) at startup`)
      await rankingsCache.invalidateOnSeasonChange()
    }
  } catch (err) {
    console.error('❌ Startup expired-season check failed:', err.message)
  }
}

const rankingsCache = new RedisCache({
  redisUrl: config.redisUrl,
  ttl: config.cacheTtlSeconds,
  devLogging: isDevelopment,
  maxKeySize: 256 * 1024  // 256 KB — skip caching oversized values
})
rankingsCache.db = db

try {
  const redisConnected = await rankingsCache.connect()
  if (redisConnected) {
    console.log('✅ Redis cache initialized')
    if (db.pool) await rankingsCache.subscribeToDbChanges(db.pool)
  } else {
    console.warn('⚠️  Redis connection failed - cache will operate in degraded mode')
  }
} catch (error) {
  console.error('❌ Redis initialization failed:', error.message)
  console.warn('⚠️  Server starting without Redis cache')
}

// Initialize rate limiter Redis client (must connect before accepting requests)
await initRateLimitRedis()

try {
  await rankingsCache.clearAndPreload(db)
} catch (error) {
  console.error('❌ Initial cache setup failed:', error.message)
  console.warn('⚠️  Server starting with empty cache - first requests will be slower')
}

// Periodic cache check
const cacheCheckInterval = setInterval(async () => {
  try {
    await rankingsCache.preloadCommonData(db)
    const stats = rankingsCache.getStats()
    if (stats.hits + stats.misses > 0) {
      console.log(`📊 Cache Stats: ${stats.hitRate} hit rate, connected: ${stats.isConnected}`)
    }
  } catch (error) {
    console.error('❌ Periodic cache check failed:', error.message)
  }
}, config.cachePreloadInterval)
cacheCheckInterval.unref()

// ── FCM push notifications ──────────────────────────────────────────────────
// Disabled/no-op if FIREBASE_SERVICE_ACCOUNT_PATH is unset or unreadable.
// Wrapped to mirror the redis init pattern above: a real firebase-admin failure
// (native binding mismatch, malformed service-account JSON, etc.) degrades to
// a warning rather than crashing startup.
let pushSender
try {
  pushSender = await createPushSender({ db })
} catch (error) {
  console.error('📵 FCM init threw unexpectedly, push notifications disabled:', error.message)
  pushSender = { enabled: false, sendMatch: async () => {}, sendSeason: async () => {}, close: async () => {} }
}

// Daily cleanup of FCM tokens not refreshed in 60 days.
// Run once at startup so freshly-stale tokens from prior deploys are reaped
// immediately (not after a 24h wait), then schedule the daily cadence.
// The null-pool guard makes this safe even when DB init failed at boot.
const runDeviceCleanup = async () => {
  if (!db.pool) return
  try {
    const removed = await db.deleteStaleDevices(config.fcm.tokenRetentionDays)
    if (removed > 0) console.log(`🧹 Removed ${removed} stale FCM device token(s) (retention: ${config.fcm.tokenRetentionDays}d)`)
  } catch (error) {
    console.error('❌ Stale device cleanup failed:', error.message)
  }
}
runDeviceCleanup()
const deviceCleanupInterval = setInterval(runDeviceCleanup, 24 * 60 * 60 * 1000)
deviceCleanupInterval.unref()

// ── Security helpers ────────────────────────────────────────────────────────

function formatSecureTimestamp(date = new Date()) {
  return date.toISOString()
}

function sanitizeResponse(data) {
  if (typeof data === 'object' && data !== null) {
    // Handle Date objects from PostgreSQL — convert to ISO string
    if (data instanceof Date) return data.toISOString()
    if (Array.isArray(data)) return data.map(sanitizeResponse)
    const sanitized = {}
    for (const [key, value] of Object.entries(data)) {
      if ((key === 'created_at' || key === 'updated_at' || key === 'timestamp') && typeof value === 'number') {
        sanitized[key] = new Date(value * 1000).toISOString()
      } else if (value instanceof Date) {
        sanitized[key] = value.toISOString()
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = sanitizeResponse(value)
      } else {
        sanitized[key] = value
      }
    }
    return sanitized
  }
  return data
}

// ── Build auth middleware with security helpers ─────────────────────────────

const securityForAuth = {
  clearCookieAllPaths,
  readToken,
  deriveCSRFSecretFromUser
}

const { authenticateToken, checkAuth, requireAdmin, requireEditor } = buildAuthMiddleware({
  jwt,
  security: securityForAuth,
  tokens,
  db
})

// ── Middleware stack ─────────────────────────────────────────────────────────

// Trust proxy
if (config.trustProxy) {
  app.set('trust proxy', 1)
  console.log('🔗 Trust proxy enabled')
} else {
  app.set('trust proxy', false)
  console.log('🔧 Trust proxy disabled - development mode')
}

// Helmet security headers
// xssFilter removed: deprecated in helmet 7.x and redundant with CSP
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "https://fonts.googleapis.com"],
      scriptSrc: ["'self'", "https://static.cloudflareinsights.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"], mediaSrc: ["'self'"], frameSrc: ["'none'"],
      baseUri: ["'self'"],
      fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
      formAction: ["'self'"], frameAncestors: ["'none'"],
      scriptSrcAttr: ["'none'"], upgradeInsecureRequests: [],
      workerSrc: ["'none'"], manifestSrc: ["'self'"], childSrc: ["'none'"],
      reportUri: ['/api/csp-report']
    }
  },
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
  permissionsPolicy: {
    camera: [], microphone: [], geolocation: [], gyroscope: [],
    magnetometer: [], usb: [], autoplay: [], payment: [],
    pictureInPicture: [], accelerometer: [], ambientLightSensor: [],
    displayCapture: [], documentDomain: [], encryptedMedia: [],
    executionWhileNotRendered: [], executionWhileOutOfViewport: [],
    fullscreen: ["'self'"], midi: [], navigationOverride: [],
    notifications: [], oversizedImages: [], publicKeyCredentialsGet: [],
    pushMessaging: [], screenWakeLock: [], syncScript: [], syncXhr: [],
    unsizedMedia: [], webShare: [], xrSpacialTracking: []
  },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  noSniff: true, frameguard: { action: 'deny' }
}))

// Rate limiting
logRateLimitConfig()
applyGlobalRateLimiting(app)

// CORS — tie dev-origin allowance to explicit env var, not NODE_ENV
const allowDevOrigins = (() => {
  const raw = process.env.ALLOW_DEV_ORIGINS
  if (raw !== undefined) {
    const n = raw.toString().trim().toLowerCase()
    return n === 'true' || n === '1' || n === 'yes'
  }
  return isDevelopment
})()
const corsOptions = {
  origin: function (origin, callback) {
    if (isDevelopment) console.log('CORS Origin:', origin)
    if (!origin) return callback(null, true)
    const allowedOrigins = [...config.allowedOrigins]
    if (config.publicDomain) {
      const protocol = config.isProduction ? 'https' : 'http'
      allowedOrigins.push(`${protocol}://${config.publicDomain}`)
      if (!config.publicDomain.includes('www.')) {
        allowedOrigins.push(`${protocol}://www.${config.publicDomain}`)
      }
    }
    if (allowDevOrigins) {
      allowedOrigins.push('http://localhost:3001', 'http://127.0.0.1:3001', 'http://localhost:5173', 'http://127.0.0.1:5173')
    }
    const localNetworkRegex = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):\d+$/
    if (allowedOrigins.includes(origin) || (allowDevOrigins && localNetworkRegex.test(origin))) {
      callback(null, true)
    } else {
      console.warn(`⚠️ CORS request blocked from origin: ${origin}`)
      // Deny CORS — browser will block the response; no crash on the server side
      callback(null, false)
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
}
app.use(cors(corsOptions))

// Cookie parser
app.use(cookieParser())

// Compression (Brotli + gzip)
const [brotliMiddleware, gzipMiddleware] = createCompressionMiddleware()
app.use(brotliMiddleware)
app.use(gzipMiddleware)

// Request timeout (skip SSE — it's a long-lived connection)
const _timeoutMw = createTimeoutMiddleware(config.requestTimeoutMs)
app.use('/api', (req, res, next) => {
  if (req.path === '/events') return next()
  // Skip socket timeout for /parse-image — it waits on an external AI API
  // that may take longer than the request timeout. Give it 5min instead of
  // the default 30s, but still enforce a hard cap to prevent connection exhaustion.
  if (req.path === '/matches/parse-image') {
    req.socket.setTimeout(300000)
    return next()
  }
  _timeoutMw(req, res, next)
})

// Body parsing
app.use(express.json({ limit: '1mb' }))

// Static files (production only)
if (!isDevelopment) {
  app.use(SUBPATH, express.static(join(__dirname, 'dist'), {
    setHeaders: (res, filePath) => {
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('X-Frame-Options', 'DENY')
      const lp = filePath.toLowerCase()
      if (lp.endsWith('.html')) {
        res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate')
      } else if (/\.(js|css|mjs|cjs|svg|png|jpg|jpeg|gif|ico|webp|avif|woff|woff2|ttf)$/i.test(lp)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      } else {
        res.setHeader('Cache-Control', 'public, max-age=86400')
      }
    }
  }))
  console.log(`📁 Static files served from: ${SUBPATH}`)
} else {
  console.log('🚧 Development mode: Static files handled by Vite')
}

// Subpath API normalisation (production + development)
// Strips the configured subpath (e.g. /tennis) from incoming API requests so that
// routes defined as /api/... work regardless of whether the client includes the
// subpath prefix.
if (SUBPATH !== '/') {
  // SUBPATH is normalized to always end with '/' (e.g. /tennis/).
  // Strip the trailing slash for URL matching to avoid double-slash mismatches.
  app.use((req, res, next) => {
    if (req.originalUrl?.startsWith(`${subpathNorm}/api`)) {
      const normalized = req.originalUrl.slice(subpathNorm.length)
      req.url = normalized.startsWith('/') ? normalized : `/${normalized}`
    }
    next()
  })
}

// API cache headers (ETag based on data version)
// Skip routes that return user-specific or auth state — ETag only encodes
// the data version, not the user identity. Without these exclusions an admin's
// cached response for `/api/players` or `/api/admin/*` would be served to guests.
const apiCachePaths = subpathNorm !== '/' ? [`${subpathNorm}/api`, '/api'] : ['/api']

// Routes that must never receive ETag / 304 responses because their bodies vary
// per-user, per-session, or per-role. Public rankings (GET /rankings/*) are safe
// to cache since they don't depend on auth state.
const skipETagRoutes = [
  '/auth/',       // login response body includes user data
  '/init',        // contains per-user auth state
  '/admin/',      // admin dashboard may return role-specific data
  '/users',       // user list/profile
  '/devices',     // device registry (per-user)
]

app.use(apiCachePaths, (req, res, next) => {
  if (req.method === 'GET' && !skipETagRoutes.some(p => req.path.startsWith(p))) {
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Pragma', 'no-cache')
    const dv = rankingsCache.getDataVersion()
    if (dv) {
      const etag = `W/"v-${dv}"`
      res.setHeader('ETag', etag)
      if (req.get('If-None-Match') === etag) return res.status(304).end()
    }
  } else {
    // Never cache: auth routes, admin, users, devices, or non-GET methods
    if (req.path === '/init') {
      res.setHeader('Vary', 'Cookie')
    }
    res.setHeader('Cache-Control', 'no-store, max-age=0')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
  }
  next()
})

// Access logging — skip static assets, health checks, and SPA HTML to avoid
// log spam (an SPA page load can request 10+ assets, each would allocate a
// 60-property object and write to disk).
const isLoggablePath = (p) => {
  if (!p) return false
  if (p === '/health' || p.startsWith('/health')) return false
  if (p === '/favicon.ico' || p.endsWith('/favicon.ico')) return false
  // Normalize SUBPATH prefix for static asset match
  const stripped = SUBPATH !== '/' && p.startsWith(SUBPATH) ? p.slice(SUBPATH.length) : p
  return !/\.(js|css|mjs|cjs|map|svg|png|jpg|jpeg|gif|ico|webp|avif|woff|woff2|ttf|mp4|webm)$/i.test(stripped)
}

app.use((req, res, next) => {
  if (!isLoggablePath(req.path)) return next()
  const startTime = Date.now()
  const originalEnd = res.end
  res.end = function (...args) {
    logAccess(req, res, Date.now() - startTime, req.user || null)
    originalEnd.apply(res, args)
  }
  next()
})

// CSRF protection (global)
app.use(globalCSRFProtection)

// Validation middleware
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() })
  }
  next()
}

// ── SSE setup ───────────────────────────────────────────────────────────────

const sseClients = new Set()

rankingsCache.on('versionChange', (version) => {
  const payload = `data: ${JSON.stringify({ version })}\n\n`
  // Snapshot the client set and write in batches via setImmediate.
  // A synchronous loop over 1000 clients would hold the event loop until
  // the slowest socket accepts the write; batching yields between groups
  // so one slow client can't backpressure the entire broadcast.
  const clients = Array.from(sseClients)
  const BATCH_SIZE = 50
  let i = 0
  const writeBatch = () => {
    const end = Math.min(i + BATCH_SIZE, clients.length)
    while (i < end) {
      const client = clients[i++]
      try {
        client.write(payload)
        if (typeof client.flush === 'function') client.flush()
      } catch { sseClients.delete(client) }
    }
    if (i < clients.length) setImmediate(writeBatch)
  }
  setImmediate(writeBatch)
})

// ── Shared context for route factories ──────────────────────────────────────

const routeCtx = {
  db, app, rankingsCache, sseClients, pushSender,
  authenticateToken, checkAuth, requireAdmin, requireEditor,
  conditionalRateLimit, smartApiLimiter,
  authLimiter, refreshLimiter, initLimiter, createLimiter, deleteLimiter, exportLimiter, criticalLimiter, restoreLimiter,
  strictRestoreLimiter, cspReportLimiter,
  deviceRegisterLimiter,
  handleValidationErrors, sanitizeResponse, formatSecureTimestamp,
  // Auth helpers for inline routes
  hashedAdminPassword, hashedEditorPassword,
  generateToken, generateRefreshToken, readToken, verifyToken,
  withCookieDefaults, clearCookieAllPaths, deriveCSRFSecretFromUser, tokens
}

// ── Mount routes ────────────────────────────────────────────────────────────

// Domain routes (already extracted before this refactoring)
app.use('/api/players', createPlayerRouter(routeCtx))
app.use('/api/seasons', createSeasonRouter(routeCtx))
app.use('/api/matches', createMatchRouter(routeCtx))
app.use('/api/rankings', createRankingRouter(routeCtx))
app.use('/api/export-excel', createExportRouter(routeCtx))
app.use('/api/auth', createAuthRouter(routeCtx))
app.use('/api/devices', createDeviceRouter(routeCtx))

// System & admin routes (newly extracted)
app.use('/api/admin', createAdminRouter(routeCtx))
app.use('/api', createBackupRouter(routeCtx))
app.use('/', createHealthRouter(routeCtx))
const systemRouter = createSystemRouter(routeCtx)
app.use('/', systemRouter)

// ── Inline auth routes (login / logout / refresh / status) ────────────────
// Extracted from server.js for modularity.
app.use(createInlineAuthRouter({
  db, checkAuth, hashedAdminPassword, hashedEditorPassword,
  generateToken, generateRefreshToken, readToken, verifyToken,
  withCookieDefaults, clearCookieAllPaths, deriveCSRFSecretFromUser, tokens,
  authLimiter, refreshLimiter, loginLimiter, handleValidationErrors
}))

// Legacy play-dates routes (frontend calls /api/play-dates directly)
app.get('/api/play-dates', checkAuth, async (req, res) => {
  try {
    const { data } = await rankingsCache.getOrSet('playdates', () => db.getPlayDates())
    res.json(data)
  } catch (error) { console.error('Error:', error); res.status(500).json({ error: 'Failed to get play dates' }) }
})

app.get('/api/play-dates/latest', checkAuth, async (req, res) => {
  try {
    const { data } = await rankingsCache.getOrSet('playdate:latest', () => db.getLatestPlayDate())
    res.json({ playDate: data })
  } catch (error) { console.error('Error:', error); res.status(500).json({ error: 'Failed to get latest play date' }) }
})

// ── Serve application ───────────────────────────────────────────────────────

if (isDevelopment) {
  app.get(SUBPATH, (_req, res) => {
    res.send(`<html><head><title>Tennis Ranking - Development</title></head><body>
      <h2>Tennis Ranking System</h2>
      <p>Development mode: Please use <a href="http://localhost:5173${SUBPATH}">http://localhost:5173${SUBPATH}</a></p>
    </body></html>`)
  })
} else {
  app.get(SUBPATH, (_req, res) => res.sendFile(join(__dirname, 'dist', 'index.html')))
  // Express 5.x requires named splat parameter syntax: {/*splat} instead of bare *
  app.get(`${SUBPATH}{/*splat}`, (_req, res) => res.sendFile(join(__dirname, 'dist', 'index.html')))
}

// Auto-redirect from domain root to subpath (controlled by ALLOW_SUBPATH_REDIRECT env).
if (config.allowSubpathRedirect) {
  app.get('/', (_req, res) => res.redirect(SUBPATH))
}

// Production 404 — Express 5.x requires named splat parameter syntax
if (!isDevelopment) {
  app.get('{/*splat}', (_req, res) => res.status(404).json({ error: 'Not found' }))
}

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err)
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' })
})

// ── Start server ────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`🎾 Tennis Ranking System Server running on http://localhost:${PORT}`)
  console.log(`🗄️ Using PostgreSQL database for data storage`)
  console.log(`🔌 Redis URL configured: ${config.redisUrl}`)
  if (process.send) process.send('ready') // PM2 wait_ready
})

// ── Graceful shutdown ───────────────────────────────────────────────────────

let isShuttingDown = false
function gracefulShutdown(signal) {
  if (isShuttingDown) return
  isShuttingDown = true
  console.log(`\n📴 Received ${signal}, shutting down gracefully...`)

  server.close(async () => {
    for (const client of sseClients) { client.end() }
    sseClients.clear()
    clearInterval(cacheCheckInterval)
    clearInterval(deviceCleanupInterval)
    if (systemRouter?.sseCleanupInterval) clearInterval(systemRouter.sseCleanupInterval)
    try { await rankingsCache.disconnect() } catch { /* ignore */ }
    try { await disconnectRateLimitRedis() } catch { /* ignore */ }
    try { if (pushSender?.close) await pushSender.close() } catch { /* ignore */ }
    try { await db.close() } catch { /* ignore */ }
    console.log('✅ Graceful shutdown complete')
    process.exit(0)
  })

  const shutdownTimeout = config.shutdownTimeoutMs
  setTimeout(() => { console.error(`⚠️  Forced shutdown after ${shutdownTimeout}ms timeout`); process.exit(1) }, shutdownTimeout).unref()
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
