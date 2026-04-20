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
import { encryptJWT, decryptJWT, generateToken, generateRefreshToken } from './lib/jwt-encryption.js'
import { globalCSRFProtection, deriveCSRFSecret, ensureCSRFCookie, tokens } from './middleware/csrf.js'
import { createCompressionMiddleware } from './middleware/compression.js'
import {
  applyGlobalRateLimiting, logRateLimitConfig, disconnectRateLimitRedis,
  authLimiter, smartApiLimiter, conditionalRateLimit,
  createLimiter, deleteLimiter, exportLimiter, criticalLimiter, restoreLimiter
} from './middleware/rate-limiter.js'
import { buildAuthMiddleware } from './middleware/auth.js'
import { createTimeoutMiddleware } from './utils/async-handler.js'
import RedisCache from './lib/redis-cache.js'
import TennisDatabase from './database-postgresql.js'
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

// ── Bootstrap ───────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const PORT = config.port
const SUBPATH = config.subpath
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

const rankingsCache = new RedisCache({
  redisUrl: config.redisUrl,
  ttl: config.cacheTtlSeconds,
  devLogging: isDevelopment
})

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
  decryptJWT,
  clearCookieAllPaths,
  deriveCSRFSecret,
  ensureCSRFCookie
}
const cookiePaths = ['/']
const { authenticateToken, checkAuth, requireAdmin, requireEditor } = buildAuthMiddleware({
  jwt,
  security: securityForAuth,
  tokens,
  cookiePaths
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
  noSniff: true, frameguard: { action: 'deny' }, xssFilter: true
}))

// Rate limiting
logRateLimitConfig()
applyGlobalRateLimiting(app)

// CORS
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
    if (isDevelopment) {
      allowedOrigins.push('http://localhost:3001', 'http://127.0.0.1:3001', 'http://localhost:5173', 'http://127.0.0.1:5173')
    }
    const localNetworkRegex = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):\d+$/
    if (allowedOrigins.includes(origin) || (isDevelopment && localNetworkRegex.test(origin))) {
      callback(null, true)
    } else {
      if (isDevelopment) console.log('CORS: Origin blocked:', origin)
      callback(new Error('Not allowed by CORS'))
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

// Request timeout
app.use('/api', createTimeoutMiddleware(config.requestTimeoutMs))

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
        res.setHeader('Cache-Control', 'public, max-age=600, must-revalidate')
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

// Subpath API normalisation (production)
if (SUBPATH !== '/' && !isDevelopment) {
  app.use((req, res, next) => {
    if (req.originalUrl?.startsWith(`${SUBPATH}/api`)) {
      const normalized = req.originalUrl.slice(SUBPATH.length)
      req.url = normalized.startsWith('/') ? normalized : `/${normalized}`
    }
    next()
  })
}

// API cache headers (ETag based on data version)
const apiCachePaths = ['/api', ...(SUBPATH !== '/' && !isDevelopment ? [`${SUBPATH}/api`] : [])]
app.use(apiCachePaths, (req, res, next) => {
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Pragma', 'no-cache')
    const dv = rankingsCache.getDataVersion()
    if (dv) {
      const etag = `W/"v-${dv}"`
      res.setHeader('ETag', etag)
      if (req.get('If-None-Match') === etag) return res.status(304).end()
    }
  } else {
    res.setHeader('Cache-Control', 'no-store, max-age=0')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
  }
  next()
})

// Access logging
app.use((req, res, next) => {
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
  for (const client of sseClients) {
    try { client.write(payload) } catch { sseClients.delete(client) }
  }
})

// ── Shared context for route factories ──────────────────────────────────────

const routeCtx = {
  db, app, rankingsCache, sseClients,
  authenticateToken, checkAuth, requireAdmin, requireEditor,
  conditionalRateLimit, smartApiLimiter,
  authLimiter, createLimiter, deleteLimiter, exportLimiter, criticalLimiter, restoreLimiter,
  handleValidationErrors, sanitizeResponse, formatSecureTimestamp,
  // Auth helpers for inline routes
  hashedAdminPassword, hashedEditorPassword,
  encryptJWT, decryptJWT, generateToken, generateRefreshToken,
  withCookieDefaults, clearCookieAllPaths, deriveCSRFSecret, ensureCSRFCookie, tokens
}

// ── Mount routes ────────────────────────────────────────────────────────────

// Domain routes (already extracted before this refactoring)
app.use('/api/players', createPlayerRouter(routeCtx))
app.use('/api/seasons', createSeasonRouter(routeCtx))
app.use('/api/matches', createMatchRouter(routeCtx))
app.use('/api/rankings', createRankingRouter(routeCtx))
app.use('/api/export-excel', createExportRouter(routeCtx))
app.use('/api/auth', createAuthRouter(routeCtx))

// System & admin routes (newly extracted)
app.use('/api/admin', createAdminRouter(routeCtx))
app.use('/api', createBackupRouter(routeCtx))
app.use('/', createHealthRouter(routeCtx))
app.use('/', createSystemRouter(routeCtx))

// ── Inline legacy auth routes (login / logout / refresh / status) ───────────
// These stay here because they tightly couple auth state with cookies.

import { body } from 'express-validator'

// Login
app.post('/api/auth/login',
  authLimiter,
  [
    body('username').isLength({ min: 1, max: 50 }),
    body('password').isLength({ min: 1, max: 100 })
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { username, password } = req.body
      let user = null, isDbUser = false

      // Check database users first
      try {
        const dbUser = await db.getUserByUsername(username)
        if (dbUser && dbUser.is_active) {
          if (await bcrypt.compare(password, dbUser.password_hash)) {
            user = { id: dbUser.id, username: dbUser.username, email: dbUser.email, role: dbUser.role, displayName: dbUser.display_name }
            isDbUser = true
            await db.updateUserLastLogin(dbUser.id)
          }
        }
      } catch { /* continue to env-based check */ }

      // Fallback to env-based admin/editor
      if (!user) {
        if (username === config.admin.username && await bcrypt.compare(password, hashedAdminPassword)) {
          user = { username: config.admin.username, email: config.admin.email, role: 'admin', displayName: 'System Admin' }
        } else if (username === config.editor.username && await bcrypt.compare(password, hashedEditorPassword)) {
          user = { username: config.editor.username, email: config.editor.email, role: 'editor', displayName: 'System Editor' }
        }
      }

      if (!user) return res.status(401).json({ error: 'Invalid credentials' })

      const token = generateToken(user)
      const refreshToken = generateRefreshToken(user)

      res.cookie('authToken', encryptJWT(token), withCookieDefaults({ httpOnly: true, maxAge: 15 * 60 * 1000 }))
      res.cookie('refreshToken', encryptJWT(refreshToken), withCookieDefaults({ httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 }))

      const sessionId = ensureCSRFCookie(req, res)
      const csrfToken = tokens.create(deriveCSRFSecret(sessionId))

      const isAPIClient = !req.headers.accept?.includes('text/html') && req.headers.accept?.includes('application/json')
      const response = {
        success: true, message: 'Login successful', csrfToken,
        user: { id: user.id, username: user.username, email: user.email, role: user.role, displayName: user.displayName, isSystemUser: !isDbUser }
      }
      if (isAPIClient) { response.token = token; response.authMethod = 'bearer_token' } else { response.authMethod = 'httponly_cookie' }

      res.json(response)
    } catch (error) {
      console.error('Login error:', error)
      res.status(500).json({ error: 'Login failed' })
    }
  }
)

// Logout
app.post('/api/auth/logout', checkAuth, (req, res) => {
  try {
    if (res.headersSent) return
    if (req.isAuthenticated) {
      const token = req.get('X-CSRF-Token') || req.body._csrf
      if (!token || !tokens.verify(req.csrfSecret, token)) {
        return res.status(403).json({ error: 'Invalid CSRF token', csrfRequired: true })
      }
    }
    clearCookieAllPaths(res, 'authToken')
    clearCookieAllPaths(res, 'refreshToken')
    clearCookieAllPaths(res, 'csrfSessionId')
    return res.json({ success: true, message: 'Logged out successfully' })
  } catch (error) {
    console.error('Logout error:', error)
    if (!res.headersSent) return res.status(500).json({ success: false, error: 'Logout failed' })
  }
})

// Auth status
app.get('/api/auth/status', checkAuth, (req, res) => {
  if (req.isAuthenticated) {
    res.json({ authenticated: true, user: req.user, csrfToken: tokens.create(req.csrfSecret) })
  } else {
    res.json({ authenticated: false })
  }
})

// Refresh token
app.post('/api/auth/refresh', async (req, res) => {
  try {
    const enc = req.cookies?.refreshToken
    if (!enc) return res.status(401).json({ error: 'No refresh token provided' })
    let decoded
    try {
      decoded = jwt.verify(decryptJWT(enc), config.jwtSecret, { algorithms: [config.jwtAlgorithm] })
      if (decoded.type !== 'refresh') return res.status(401).json({ error: 'Invalid token type' })
    } catch { return res.status(401).json({ error: 'Invalid refresh token' }) }

    const user = { username: decoded.username, role: decoded.role }
    res.cookie('authToken', encryptJWT(generateToken(user)), withCookieDefaults({ httpOnly: true, maxAge: 15 * 60 * 1000 }))
    const sessionId = req.cookies?.csrfSessionId || ensureCSRFCookie(req, res)
    res.json({ success: true, csrfToken: tokens.create(deriveCSRFSecret(sessionId)), user })
  } catch (error) {
    console.error('Token refresh error:', error)
    res.status(500).json({ error: 'Token refresh failed' })
  }
})

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
  app.get(`${SUBPATH}/*`, (_req, res) => res.sendFile(join(__dirname, 'dist', 'index.html')))
}

app.get('/', (_req, res) => res.redirect(SUBPATH))

// Production 404
if (!isDevelopment) {
  app.get('*', (_req, res) => res.status(404).json({ error: 'Not found' }))
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
    try { await rankingsCache.disconnect() } catch { /* ignore */ }
    try { await disconnectRateLimitRedis() } catch { /* ignore */ }
    try { await db.close() } catch { /* ignore */ }
    console.log('✅ Graceful shutdown complete')
    process.exit(0)
  })

  setTimeout(() => { console.error('⚠️  Forced shutdown after timeout'); process.exit(1) }, 4500).unref()
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
