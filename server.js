import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { RedisStore } from 'rate-limit-redis'
import IORedis from 'ioredis'
import { body, param, query, validationResult } from 'express-validator'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import cookieParser from 'cookie-parser'
import dotenv from 'dotenv'
import compression from 'compression'
import zlib from 'zlib'
import TennisDatabase from './database-postgresql.js'
import {
  createFullExportBuffer,
  createDateExportBuffer,
  createSeasonExportBuffer,
  createLifetimeExportBuffer
} from './utils/excel-helper.js'
import csrf from 'csrf'
import crypto from 'crypto'
import os from 'os'
import { getRealClientIP, logAccess, logError, getLogStats } from './access-logger.js'
import { createPlayerRouter } from './routes/players.js'
import { createSeasonRouter } from './routes/seasons.js'
import { createMatchRouter } from './routes/matches.js'
import { createRankingRouter } from './routes/rankings.js'
import { createExportRouter } from './routes/export.js'
import { createAuthRouter } from './routes/users.js'
import { createTimeoutMiddleware, sendError, ErrorCodes } from './utils/async-handler.js'
import RedisCache from './lib/redis-cache.js'

// Load environment variables
dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3001

// Initialize CSRF protection
const tokens = new csrf()

// Cookie security configuration (allow overrides for local HTTPS testing)
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

const sharedCookieDefaults = {
  httpOnly: true,
  secure: secureCookiesEnabled,
  sameSite: sameSitePolicy
}

const withCookieDefaults = (options = {}) => {
  const base = {
    ...sharedCookieDefaults,
    path: '/',
    ...options
  }

  if (cookieDomain) {
    base.domain = cookieDomain
  }

  return base
}

// Security helper functions
function formatSecureTimestamp(date = new Date()) {
  // Return ISO string instead of Unix timestamp to avoid timestamp disclosure
  return date.toISOString()
}

function sanitizeResponse(data) {
  // Remove sensitive timestamp fields that could reveal system time
  if (typeof data === 'object' && data !== null) {
    if (Array.isArray(data)) {
      return data.map(sanitizeResponse)
    }

    const sanitized = {}
    for (const [key, value] of Object.entries(data)) {
      // Convert Unix timestamps to ISO strings
      if ((key === 'created_at' || key === 'updated_at' || key === 'timestamp') && typeof value === 'number') {
        sanitized[key] = new Date(value * 1000).toISOString()
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

// CSRF secret derivation using HMAC (fixes cleartext storage vulnerability)
function deriveCSRFSecret(sessionId) {
  if (!sessionId) {
    throw new Error('Session ID is required for CSRF secret derivation')
  }
  // Use HMAC to derive a secret from the session ID and server secret
  return crypto.createHmac('sha256', CSRF_SECRET)
    .update(sessionId)
    .digest('base64')
}

function generateSessionId() {
  return crypto.randomBytes(32).toString('base64url')
}

// JWT token encryption/decryption for secure cookie storage (AES-256-GCM authenticated encryption)
// Note: jwtEncryptionKey is initialized after env variable validation below
function encryptJWT(token) {
  const iv = crypto.randomBytes(12) // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', jwtEncryptionKey, iv)

  let encrypted = cipher.update(token, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  const authTag = cipher.getAuthTag().toString('hex')

  // Combine iv + encrypted data + auth tag
  return `${iv.toString('hex')}:${encrypted}:${authTag}`
}

function decryptJWT(encryptedToken) {
  try {
    const parts = encryptedToken.split(':')

    if (parts.length === 2) {
      // Legacy CBC format (iv:encrypted) — backward compatibility
      const [ivHex, encrypted] = parts
      if (!ivHex || !encrypted) throw new Error('Invalid token format')
      const decipher = crypto.createDecipheriv('aes-256-cbc', jwtEncryptionKey, Buffer.from(ivHex, 'hex'))
      let decrypted = decipher.update(encrypted, 'hex', 'utf8')
      decrypted += decipher.final('utf8')
      return decrypted
    }

    if (parts.length !== 3) {
      throw new Error('Invalid encrypted token format')
    }

    const [ivHex, encrypted, authTagHex] = parts
    if (!ivHex || !encrypted || !authTagHex) throw new Error('Invalid token format')

    const decipher = crypto.createDecipheriv('aes-256-gcm', jwtEncryptionKey, Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'))

    let decrypted = decipher.update(encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')

    return decrypted
  } catch (error) {
    console.error('JWT decryption failed:', error)
    return null
  }
}

// Admin credentials from environment (no fallback passwords for security)
const ADMIN_USERNAME = process.env.ADMIN_USERNAME
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@tennis.local'
const EDITOR_USERNAME = process.env.EDITOR_USERNAME
const EDITOR_PASSWORD = process.env.EDITOR_PASSWORD
const EDITOR_EMAIL = process.env.EDITOR_EMAIL || 'editor@tennis.local'
const JWT_SECRET = process.env.JWT_SECRET
const CSRF_SECRET = process.env.CSRF_SECRET

// Validate required environment variables
if (!ADMIN_USERNAME) {
  console.error('❌ ADMIN_USERNAME environment variable is required')
  process.exit(1)
}

if (!ADMIN_PASSWORD) {
  console.error('❌ ADMIN_PASSWORD environment variable is required')
  process.exit(1)
}

if (!EDITOR_USERNAME) {
  console.error('❌ EDITOR_USERNAME environment variable is required')
  process.exit(1)
}

if (!EDITOR_PASSWORD) {
  console.error('❌ EDITOR_PASSWORD environment variable is required')
  process.exit(1)
}

if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET environment variable is required')
  process.exit(1)
}

if (!CSRF_SECRET) {
  console.error('❌ CSRF_SECRET environment variable is required')
  process.exit(1)
}

// Pre-compute scrypt key once at startup (scrypt is intentionally slow ~100ms per call)
let jwtEncryptionKey = crypto.scryptSync(JWT_SECRET, 'jwt-salt', 32)

// Hash the passwords on startup (2026 security: 14 rounds minimum)
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS) || 14
const hashedAdminPassword = await bcrypt.hash(ADMIN_PASSWORD, BCRYPT_ROUNDS)
const hashedEditorPassword = await bcrypt.hash(EDITOR_PASSWORD, BCRYPT_ROUNDS)

// Initialize database
const db = new TennisDatabase()
await db.init()

// Initialize Redis cache
const rankingsCache = new RedisCache({
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  ttl: parseInt(process.env.CACHE_TTL_SECONDS) || 24 * 60 * 60, // 24 hours default
  devLogging: process.env.NODE_ENV === 'development'
})

// Connect to Redis and subscribe to PostgreSQL notifications for auto-invalidation
try {
  const redisConnected = await rankingsCache.connect()
  if (redisConnected) {
    console.log('✅ Redis cache initialized')
    
    // Subscribe to PostgreSQL LISTEN/NOTIFY for automatic cache invalidation
    if (db.pool) {
      await rankingsCache.subscribeToDbChanges(db.pool)
    }
  } else {
    console.warn('⚠️  Redis connection failed - cache will operate in degraded mode')
  }
} catch (error) {
  console.error('❌ Redis initialization failed:', error.message)
  console.warn('⚠️  Server starting without Redis cache')
}

// Clear all cache and preload startup data on server start
// This ensures fresh cache state and immediate availability of common data
try {
  await rankingsCache.clearAndPreload(db)
} catch (error) {
  console.error('❌ Initial cache setup failed:', error.message)
  console.warn('⚠️  Server starting with empty cache - first requests will be slower')
}

// Periodic cache check (every 4 minutes by default)
// Only loads data if not already cached (invalidation handles updates)
const CACHE_CHECK_INTERVAL = parseInt(process.env.CACHE_PRELOAD_INTERVAL) || 240000
console.log(`⏰ Scheduling cache check every ${CACHE_CHECK_INTERVAL / 1000 / 60} minutes`)

setInterval(async () => {
  try {
    // Check and reload any missing startup cache (after invalidation or eviction)
    await rankingsCache.preloadCommonData(db)
    
    // Log stats periodically
    const stats = rankingsCache.getStats()
    if (stats.hits + stats.misses > 0) {
      console.log(`📊 Cache Stats: ${stats.hitRate} hit rate, connected: ${stats.isConnected}`)
    }
  } catch (error) {
    console.error('❌ Periodic cache check failed:', error.message)
  }
}, CACHE_CHECK_INTERVAL)

// Trust proxy (required for Cloudflare and other reverse proxies)
// Proxy configuration for Nginx Proxy Manager
if (process.env.TRUST_PROXY === 'true' || process.env.BEHIND_PROXY === 'true' || process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1) // Trust first proxy (NPM)
  console.log('🔗 Trust proxy enabled - real client IPs will be detected from X-Forwarded-For headers')
} else {
  app.set('trust proxy', false)
  console.log('🔧 Trust proxy disabled - development mode')
}

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "https://fonts.googleapis.com"],
      scriptSrc: ["'self'", "https://static.cloudflareinsights.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
      baseUri: ["'self'"],
      fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      scriptSrcAttr: ["'none'"], // Hardened: no inline event handlers
      upgradeInsecureRequests: [],
      workerSrc: ["'none'"],
      manifestSrc: ["'self'"],
      childSrc: ["'none'"],
      reportUri: ['/api/csp-report']
    }
  },
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 63072000, // 2 years (stronger than 1 year)
    includeSubDomains: true,
    preload: true
  },
  // Add Permissions Policy header to restrict browser features
  permissionsPolicy: {
    camera: [],
    microphone: [],
    geolocation: [],
    gyroscope: [],
    magnetometer: [],
    usb: [],
    autoplay: [],
    payment: [],
    pictureInPicture: [],
    accelerometer: [],
    ambientLightSensor: [],
    displayCapture: [],
    documentDomain: [],
    encryptedMedia: [],
    executionWhileNotRendered: [],
    executionWhileOutOfViewport: [],
    fullscreen: ["'self'"],
    midi: [],
    navigationOverride: [],
    notifications: [],
    oversizedImages: [],
    publicKeyCredentialsGet: [],
    pushMessaging: [],
    screenWakeLock: [],
    syncScript: [],
    syncXhr: [],
    unsizedMedia: [],
    webShare: [],
    xrSpacialTracking: []
  },
  // Additional security headers
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  noSniff: true,
  frameguard: { action: 'deny' },
  xssFilter: true
}))

// Enhanced rate limiting with comprehensive IP detection
const envFlagTrue = (value) => {
  if (value === undefined || value === null) return false
  const normalized = value.toString().trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes'
}

const parseNumberEnv = (name, fallback) => {
  const raw = process.env[name]
  if (raw === undefined || raw === null || raw === '') return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

const clampNumber = (value, min, max) => {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

const isRateLimitingDisabled = () => {
  // Support both spellings (some deployments used DISABLE_RATELIMITING)
  return envFlagTrue(process.env.DISABLE_RATE_LIMITING) || envFlagTrue(process.env.DISABLE_RATELIMITING)
}

// Dynamic rate limiting based on server resource pressure (CPU/RAM)
const rateLimitDynamicEnabled = envFlagTrue(process.env.RATE_LIMIT_DYNAMIC_ENABLED)
const rateLimitDynamicSampleMs = parseInt(process.env.RATE_LIMIT_DYNAMIC_SAMPLE_MS) || 5000

const rateLimitCpuHighPct = clampNumber(parseNumberEnv('RATE_LIMIT_CPU_HIGH_PCT', 80), 0, 1000)
const rateLimitCpuCriticalPct = clampNumber(parseNumberEnv('RATE_LIMIT_CPU_CRITICAL_PCT', 95), 0, 1000)
const rateLimitRamHighPct = clampNumber(parseNumberEnv('RATE_LIMIT_RAM_HIGH_PCT', 85), 0, 100)
const rateLimitRamCriticalPct = clampNumber(parseNumberEnv('RATE_LIMIT_RAM_CRITICAL_PCT', 95), 0, 100)

const rateLimitDynamicScaleHigh = clampNumber(parseNumberEnv('RATE_LIMIT_DYNAMIC_SCALE_HIGH', 0.7), 0.01, 1)
const rateLimitDynamicScaleCritical = clampNumber(parseNumberEnv('RATE_LIMIT_DYNAMIC_SCALE_CRITICAL', 0.4), 0.01, 1)
const rateLimitDynamicMinScale = clampNumber(parseNumberEnv('RATE_LIMIT_DYNAMIC_MIN_SCALE', 0.2), 0.01, 1)

let resourceSnapshot = {
  cpuPct: 0,
  ramUsedPct: 0,
  updatedAt: 0
}

const sampleServerResources = () => {
  try {
    const cpuCores = os.cpus()?.length || 1
    const load1 = Array.isArray(os.loadavg?.()) ? os.loadavg()[0] : 0
    // Heuristic CPU% based on 1-minute load average / CPU cores.
    // Can exceed 100% under heavy load; that's fine for thresholding.
    const cpuPct = cpuCores > 0 ? (load1 / cpuCores) * 100 : 0

    const totalMem = os.totalmem?.() || 0
    const freeMem = os.freemem?.() || 0
    const ramUsedPct = totalMem > 0 ? ((totalMem - freeMem) / totalMem) * 100 : 0

    resourceSnapshot = {
      cpuPct,
      ramUsedPct,
      updatedAt: Date.now()
    }
  } catch (error) {
    // Ignore sampling errors; keep last good snapshot.
  }
}

if (rateLimitDynamicEnabled) {
  sampleServerResources()
  const interval = setInterval(sampleServerResources, rateLimitDynamicSampleMs)
  if (typeof interval.unref === 'function') interval.unref()
}

const getRateLimitDynamicMultiplier = () => {
  if (!rateLimitDynamicEnabled) return 1

  const { cpuPct, ramUsedPct } = resourceSnapshot

  let multiplier = 1
  if (cpuPct >= rateLimitCpuCriticalPct || ramUsedPct >= rateLimitRamCriticalPct) {
    multiplier = rateLimitDynamicScaleCritical
  } else if (cpuPct >= rateLimitCpuHighPct || ramUsedPct >= rateLimitRamHighPct) {
    multiplier = rateLimitDynamicScaleHigh
  }

  return clampNumber(multiplier, rateLimitDynamicMinScale, 1)
}

// Dedicated Redis client for distributed rate limiting across PM2 cluster workers.
// Uses a separate connection from the cache client so a cache failure can't
// take down rate limiting and vice versa.
// enableOfflineQueue:false ensures fast-fail (no command queuing) if Redis is down;
// passOnStoreError:true (set per-limiter below) lets requests through on failure.
const rateLimitRedis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
})
rateLimitRedis.on('error', () => {
  // Errors suppressed here — passOnStoreError:true in each limiter handles graceful degradation
})

const createRedisRateLimitStore = (suffix) => new RedisStore({
  sendCommand: (...args) => rateLimitRedis.call(...args),
  prefix: `rate-limit-redis-tennis:${suffix}:`,
})

const createProxyAwareRateLimiter = ({ storePrefix, ...options }) => {
  // Check if rate limiting is disabled
  if (isRateLimitingDisabled()) {
    console.log('🚫 Rate limiting is disabled via environment variable');
    return (req, res, next) => next();
  }

  const baseLimit = options.limit
  const dynamicLimit = (req, res) => {
    const resolvedBase = typeof baseLimit === 'function' ? baseLimit(req, res) : baseLimit
    const numericBase = Number(resolvedBase)
    const safeBase = Number.isFinite(numericBase) && numericBase > 0 ? numericBase : 1

    const multiplier = getRateLimitDynamicMultiplier()
    const computed = Math.floor(safeBase * multiplier)
    return computed > 0 ? computed : 1
  }

  const store = storePrefix ? createRedisRateLimitStore(storePrefix) : undefined

  return rateLimit({
    ...options,
    standardHeaders: 'draft-8', // Use the latest IETF draft standard
    legacyHeaders: false,
    // Always compute limit at request-time so dynamic scaling can apply.
    limit: dynamicLimit,
    store,
    // Pass requests through if the Redis store errors (graceful degradation)
    passOnStoreError: true,
    // Enhanced key generator using our comprehensive IP detection
    keyGenerator: (req) => {
      const clientIP = getRealClientIP(req);
      
      // Log for debugging (remove in production if too verbose)
      if (process.env.NODE_ENV === 'development') {
        const originalIP = req.connection.remoteAddress;
        const forwardedFor = req.get('X-Forwarded-For');
        const cfIP = req.get('CF-Connecting-IP');
        console.log(`🔍 Rate limit IP detection: ${clientIP} (Original: ${originalIP}, X-FF: ${forwardedFor}, CF: ${cfIP})`);
      }
      
      return clientIP;
    },
    // Skip internal health checks and static assets
    skip: (req) => {
      return req.path === '/api/health' || 
             req.path === '/health' ||
             req.path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf)$/);
    },
    // Custom handler for rate limit exceeded with enhanced logging
    handler: (req, res, next, options) => {
      const clientIP = getRealClientIP(req);
      const userInfo = req.user ? `${req.user.username}(${req.user.role})` : 'anonymous';
      
      console.warn(`⚠️ Rate limit exceeded: ${clientIP} | ${userInfo} | ${req.method} ${req.path}`);
      
      // Log the rate limit violation
      logError(new Error(`Rate limit exceeded: ${req.method} ${req.path}`), req, req.user);
      
      // Send the default rate limit response in English
      res.status(options.statusCode || 429).json(
        options.message || { error: 'Too many requests from this IP, please try again later.' }
      );
    }
  });
};

// Rate limiting configurations with environment variable debugging
const rateLimitWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
const rateLimitMaxRequests = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 1000;
const rateLimitApiMax = parseInt(process.env.RATE_LIMIT_API_MAX) || 100;

console.log(`🔧 Rate Limiting Configuration:`);
console.log(`   Window: ${rateLimitWindowMs}ms (${rateLimitWindowMs / 60000} minutes)`);
console.log(`   General Limit: ${rateLimitMaxRequests} requests`);
console.log(`   API Limit: ${rateLimitApiMax} requests`);
console.log(`   Disabled: ${isRateLimitingDisabled()}`);
console.log(`   Dynamic Enabled: ${rateLimitDynamicEnabled}`);
if (rateLimitDynamicEnabled) {
  console.log(`   Dynamic Sample: ${rateLimitDynamicSampleMs}ms`);
  console.log(`   CPU High/Critical: ${rateLimitCpuHighPct}% / ${rateLimitCpuCriticalPct}%`);
  console.log(`   RAM High/Critical: ${rateLimitRamHighPct}% / ${rateLimitRamCriticalPct}%`);
  console.log(`   Scale High/Critical: ${rateLimitDynamicScaleHigh} / ${rateLimitDynamicScaleCritical} (min ${rateLimitDynamicMinScale})`);
}

const generalLimiter = createProxyAwareRateLimiter({
  windowMs: rateLimitWindowMs,
  limit: rateLimitMaxRequests,
  storePrefix: 'general',
  message: { error: 'Too many requests from this IP, please try again later.' }
});

const apiLimiter = createProxyAwareRateLimiter({
  windowMs: rateLimitWindowMs,
  limit: rateLimitApiMax,
  storePrefix: 'api',
  message: { error: 'Too many API requests from this IP, please try again later.' }
});

const authLimiter = createProxyAwareRateLimiter({
  windowMs: rateLimitWindowMs,
  limit: 5,
  storePrefix: 'auth',
  message: { error: 'Too many login attempts from this IP, please try again later.' }
});

// Additional specialized rate limiters for enhanced security
const deleteLimiter = createProxyAwareRateLimiter({
  windowMs: rateLimitWindowMs,
  limit: 50,
  storePrefix: 'delete',
  message: { error: 'Too many delete requests from this IP, please try again later.' }
});

const createLimiter = createProxyAwareRateLimiter({
  windowMs: rateLimitWindowMs,
  limit: 200,
  storePrefix: 'create',
  message: { error: 'Too many create requests from this IP, please try again later.' }
});

const exportLimiter = createProxyAwareRateLimiter({
  windowMs: rateLimitWindowMs,
  limit: 150,
  storePrefix: 'export',
  message: { error: 'Too many export requests from this IP, please try again later.' }
});

const criticalLimiter = createProxyAwareRateLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  storePrefix: 'critical',
  message: { error: 'Critical operation limit exceeded. Please wait 1 hour before trying again.' }
});

const restoreLimiter = createProxyAwareRateLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 50,
  storePrefix: 'restore',
  message: { error: 'Too many restore requests from this IP, please try again later.' }
});

// User-aware rate limiting (different limits for authenticated users)
const createUserAwareRateLimiter = (anonymousLimit, authenticatedLimit, windowMs = 15 * 60 * 1000, storePrefix = 'smart-api') => {
  return createProxyAwareRateLimiter({
    windowMs: windowMs,
    storePrefix,
    limit: (req) => {
      // Check if user is authenticated and return different limits
      if (req.user && req.user.role === 'admin') {
        return authenticatedLimit * 2; // Admins get double the limit
      } else if (req.user) {
        return authenticatedLimit; // Authenticated users get higher limit
      } else {
        return anonymousLimit; // Anonymous users get base limit
      }
    },
    message: (req) => {
      const isAuth = !!req.user;
      return { 
        error: `Too many requests from this IP. ${isAuth ? 'Authenticated users receive higher limits' : 'Anonymous users are limited'}. Please try again later.`
      };
    }
  });
};

// Apply user-aware rate limiting to API endpoints
const rateLimitAnonymousMax = parseInt(process.env.RATE_LIMIT_ANONYMOUS_MAX) || 50;
const rateLimitAuthenticatedMax = parseInt(process.env.RATE_LIMIT_AUTHENTICATED_MAX) || 200;
const smartApiLimiter = createUserAwareRateLimiter(rateLimitAnonymousMax, rateLimitAuthenticatedMax);

// Apply rate limiting conditionally based on environment
if (process.env.NODE_ENV !== 'development') {
  app.use(generalLimiter)
  app.use('/api', smartApiLimiter) // Use smart user-aware API rate limiting
} else {
  console.log('🚧 Development mode: Rate limiting disabled')
}

// Conditional rate limiter - bypasses in development
const conditionalRateLimit = (limiter) => {
  return (req, res, next) => {
    if (process.env.NODE_ENV === 'development') {
      return next() // Skip rate limiting in development
    }
    return limiter(req, res, next)
  }
}

// CORS configuration with security
const corsOptions = {
  origin: function (origin, callback) {
    // Only log in development mode
    if (process.env.NODE_ENV === 'development') {
      console.log('CORS Origin:', origin)
    }
    
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true)
    
    // Build allowed origins dynamically from environment
    const allowedOrigins = []
    
    // Add configured origins from environment
    if (process.env.ALLOWED_ORIGINS) {
      allowedOrigins.push(...process.env.ALLOWED_ORIGINS.split(','))
    }
    
    // Add dynamic domain from PUBLIC_DOMAIN and BASE_PATH
    if (process.env.PUBLIC_DOMAIN) {
      const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http'
      const basePath = process.env.BASE_PATH || '/'
      const domain = `${protocol}://${process.env.PUBLIC_DOMAIN}`
      allowedOrigins.push(domain)
      
      // Also add www version if it's a main domain
      if (!process.env.PUBLIC_DOMAIN.includes('www.')) {
        allowedOrigins.push(`${protocol}://www.${process.env.PUBLIC_DOMAIN}`)
      }
    }
    
    // Fallback for development
    if (process.env.NODE_ENV === 'development') {
      allowedOrigins.push(
        'http://localhost:3001',
        'http://127.0.0.1:3001',
        'http://localhost:5173', // Vite dev server
        'http://127.0.0.1:5173'
      )
    }
    
    // Allow local network IPs in development
    const localNetworkRegex = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):\d+$/
    
    if (allowedOrigins.includes(origin) || (process.env.NODE_ENV === 'development' && localNetworkRegex.test(origin))) {
      if (process.env.NODE_ENV === 'development') {
        console.log('CORS: Origin allowed:', origin)
      }
      callback(null, true)
    } else {
      if (process.env.NODE_ENV === 'development') {
        console.log('CORS: Origin blocked:', origin)
        console.log('Allowed origins:', allowedOrigins)
      }
      callback(new Error('Not allowed by CORS'))
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
}

app.use(cors(corsOptions))

// Cookie parser middleware for JWT in httpOnly cookies
app.use(cookieParser())

// Enable Brotli + gzip compression for responses larger than 1KB
// Brotli achieves ~15-25% better compression than gzip on text assets
const compressionFilter = (req, res) => {
  if (req.headers['x-no-compression']) {
    return false
  }
  return compression.filter(req, res)
}

app.use((req, res, next) => {
  // Skip compression for tiny responses or opt-out requests
  if (!compressionFilter(req, res)) {
    return next()
  }

  const acceptEncoding = req.headers['accept-encoding'] || ''

  // Prefer Brotli if the client supports it
  if (acceptEncoding.includes('br')) {
    // Manually compress with Brotli for API JSON responses
    const originalJson = res.json.bind(res)
    res.json = (body) => {
      const raw = JSON.stringify(body)
      // Only Brotli-compress responses larger than threshold (1KB)
      if (Buffer.byteLength(raw, 'utf8') < 1024) {
        return originalJson(body)
      }

      zlib.brotliCompress(Buffer.from(raw), {
        params: {
          [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
          [zlib.constants.BROTLI_PARAM_QUALITY]: 4 // Fast compression (1-11, 4 is a good speed/ratio trade-off)
        }
      }, (err, compressed) => {
        if (err || res.headersSent) {
          // Fallback: let gzip middleware handle it
          if (!res.headersSent) return originalJson(body)
          return
        }
        res.setHeader('Content-Encoding', 'br')
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Content-Length', compressed.length)
        res.removeHeader('Transfer-Encoding')
        res.end(compressed)
      })
    }
  }

  next()
})

// Fallback: gzip compression for clients that don't support Brotli
app.use(compression({
  threshold: 1024,
  filter: compressionFilter
}))

// Request timeout middleware (30 seconds default, configurable via env)
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS) || 30000
app.use('/api', createTimeoutMiddleware(REQUEST_TIMEOUT_MS))

// CSRF middleware generator (deprecated - using global protection now)
const generateCSRFMiddleware = () => {
  return (req, res, next) => {
    // Generate secret for this session if not exists
    if (!req.csrfSecret) {
      req.csrfSecret = tokens.secretSync()
    }
    next()
  }
}

// CSRF token validation middleware (deprecated - using global protection now)
const validateCSRF = (req, res, next) => {
  const token = req.get('X-CSRF-Token') || req.body._csrf
  const secret = req.csrfSecret || CSRF_SECRET
  
  if (!token || !tokens.verify(secret, token)) {
    return res.status(403).json({ 
      error: 'Invalid CSRF token',
      csrfRequired: true 
    })
  }
  next()
}

app.use(express.json({ 
  limit: '50mb'  // Increased for large backup files
}))

// Subpath configuration - support both SUBPATH and BASE_PATH env vars
// Use root path for development, tennis subpath for production by default
const SUBPATH = process.env.SUBPATH || process.env.BASE_PATH || (process.env.NODE_ENV === 'production' ? '/tennis' : '/')
const isDevelopment = process.env.NODE_ENV === 'development'

console.log('🎯 Server subpath configuration:', SUBPATH)
console.log('🔧 Environment:', process.env.NODE_ENV)

const getCookiePathsToClear = () => {
  const paths = new Set(['/'])
  const normalizedSubpath = SUBPATH && SUBPATH !== '/' ? SUBPATH : null
  if (normalizedSubpath) {
    const cleanSubpath = normalizedSubpath.endsWith('/') ? normalizedSubpath.slice(0, -1) : normalizedSubpath
    paths.add(cleanSubpath)
    paths.add(`${cleanSubpath}/`)
    paths.add(`${cleanSubpath}/api`)
    paths.add(`${cleanSubpath}/api/`)
  }
  paths.add('/api')
  paths.add('/api/')
  return Array.from(paths)
}

const clearCookieAllPaths = (res, name, extraOptions = {}) => {
  const paths = getCookiePathsToClear()
  paths.forEach((path) => {
    res.clearCookie(name, {
      ...sharedCookieDefaults,
      httpOnly: true, // Explicit for CodeQL static analysis (prevents js/client-exposed-cookie alert)
      path,
      ...extraOptions
    })
  })
}

// Serve static files with subpath support
if (isDevelopment) {
  // In development, Vite handles static files
  console.log('🚧 Development mode: Static files handled by Vite')
} else {
  // In production, serve static files from dist directory
  app.use(SUBPATH, express.static('dist', {
    setHeaders: (res, path) => {
      // Security headers for static files
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('X-Frame-Options', 'DENY')

      const lowerPath = path.toLowerCase()
      const isHTML = lowerPath.endsWith('.html')
      const isImmutableAsset = /\.(?:js|css|mjs|cjs|svg|png|jpg|jpeg|gif|ico|webp|avif|woff|woff2|ttf)$/i.test(lowerPath)

      if (isHTML) {
        // Allow HTML caching for nginx with revalidation (10 minutes)
        res.setHeader('Cache-Control', 'public, max-age=600, must-revalidate')
      } else if (isImmutableAsset) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      } else {
        res.setHeader('Cache-Control', 'public, max-age=86400')
      }
    }
  }))
  console.log(`📁 Static files served from: ${SUBPATH}`)
}

// Add API routing for both subpath and direct access compatibility
if (SUBPATH !== '/' && !isDevelopment) {
  // Log subpath API requests
  app.use(`${SUBPATH}/api`, (req, res, next) => {
    console.log(`🔗 Subpath API: ${req.method} ${SUBPATH}/api${req.path}`)
    next()
  })
  
  // Log direct API requests (for backward compatibility)
  app.use('/api', (req, res, next) => {
    console.log(`🔗 Direct API: ${req.method} /api${req.path}`)
    next()
  })
  
  console.log(`🔀 API routes configured for both ${SUBPATH}/api and /api`)
}

// Normalize API requests when served from a subpath so `/tennis/api/...` hits `/api/...`
if (SUBPATH !== '/' && !isDevelopment) {
  app.use((req, res, next) => {
    if (req.originalUrl?.startsWith(`${SUBPATH}/api`)) {
      const normalized = req.originalUrl.slice(SUBPATH.length)
      req.url = normalized.startsWith('/') ? normalized : `/${normalized}`
    }
    next()
  })
}

// Prevent caching of API responses (dynamic data) but enable conditional requests via ETag
const apiCachePaths = [
  '/api',
  SUBPATH !== '/' && !isDevelopment ? `${SUBPATH}/api` : null
].filter(Boolean)

if (apiCachePaths.length) {
  app.use(apiCachePaths, (req, res, next) => {
    // For GET requests: allow conditional caching with ETag (304 Not Modified)
    // This saves bandwidth when data hasn't changed
    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-cache') // Always revalidate, but allow 304
      res.setHeader('Pragma', 'no-cache')
      
      // Set ETag based on data version for cache-coherent endpoints
      const dataVersion = rankingsCache.getDataVersion()
      if (dataVersion) {
        const etag = `W/"v-${dataVersion}"`
        res.setHeader('ETag', etag)
        
        // Check If-None-Match header for conditional request
        const ifNoneMatch = req.get('If-None-Match')
        if (ifNoneMatch === etag) {
          return res.status(304).end()
        }
      }
    } else {
      // For mutations: never cache
      res.setHeader('Cache-Control', 'no-store, max-age=0')
      res.setHeader('Pragma', 'no-cache')
      res.setHeader('Expires', '0')
    }
    next()
  })
}

// Global CSRF protection middleware (after body parsing)
const matchesApiRoute = (req, route) => {
  if (!route) return false
  const { path, originalUrl } = req
  if (path === route) return true
  const normalized = originalUrl?.split('?')[0]
  if (normalized === route) return true
  return normalized?.endsWith(route)
}

const globalCSRFProtection = (req, res, next) => {
  // Skip CSRF for GET requests (read-only operations)
  if (req.method === 'GET') {
    return next()
  }
  
  // Skip CSRF for login endpoint (needs to issue CSRF token)
  if (matchesApiRoute(req, '/api/auth/login')) {
    return next()
  }
  
  // Skip CSRF for public CSRF token endpoint
  if (matchesApiRoute(req, '/api/csrf-token')) {
    return next()
  }
  
  // Skip CSRF for non-authenticated users on logout
  if (matchesApiRoute(req, '/api/auth/logout') && !req.cookies.authToken) {
    return next()
  }
  
  // Apply CSRF validation for all other state-changing operations
  const token = req.get('X-CSRF-Token') || req.body._csrf
  
  // Get or create session ID for CSRF secret derivation
  let sessionId = req.cookies.csrfSessionId
  if (!sessionId) {
    sessionId = generateSessionId()
    res.cookie('csrfSessionId', sessionId, withCookieDefaults({
      httpOnly: true, // Explicit for CodeQL static analysis (prevents js/client-exposed-cookie alert)
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }))
  }
  
  const secret = deriveCSRFSecret(sessionId)
  
  if (!token || !tokens.verify(secret, token)) {
    return res.status(403).json({ 
      error: 'Invalid CSRF token',
      csrfRequired: true 
    })
  }
  
  next()
}

// Comprehensive access logging middleware (runs early to capture all requests)
app.use((req, res, next) => {
  const startTime = Date.now();
  
  // Capture original res.end to log when response is complete
  const originalEnd = res.end;
  res.end = function(...args) {
    const responseTime = Date.now() - startTime;
    
    // Log the access (with user info if available from auth middleware)
    logAccess(req, res, responseTime, req.user || null);
    
    // Call original end method
    originalEnd.apply(res, args);
  };
  
  next();
});

// Apply global CSRF protection
app.use(globalCSRFProtection)

// Validation middleware
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      error: 'Validation failed', 
      details: errors.array() 
    })
  }
  next()
}

// Authentication middleware
const authenticateToken = (req, res, next) => {
  // Try to get token from httpOnly cookie first, then Authorization header (fallback)
  let token = req.cookies.authToken || (req.headers['authorization'] && req.headers['authorization'].split(' ')[1])

  if (!token) {
    return res.status(401).json({ error: 'Access token required' })
  }

  // Decrypt JWT token if it came from cookie (encrypted) vs Authorization header (plain)
  if (req.cookies.authToken && token === req.cookies.authToken) {
    token = decryptJWT(token)
    if (!token) {
      // Clear invalid encrypted cookie across paths
      clearCookieAllPaths(res, 'authToken')
      return res.status(401).json({ error: 'Invalid encrypted token' })
    }
  }

  jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }, (err, user) => {
    if (err) {
      // Clear invalid cookie
      if (req.cookies.authToken) {
        clearCookieAllPaths(res, 'authToken')
      }
      return res.status(403).json({ error: 'Invalid or expired token' })
    }
    req.user = user
    req.isAuthenticated = true
    next()
  })
}

// Check if user is authenticated (for optional auth)
const checkAuth = (req, res, next) => {
  // Try to get token from httpOnly cookie first, then Authorization header (fallback)
  let token = req.cookies.authToken || (req.headers['authorization'] && req.headers['authorization'].split(' ')[1])

  if (token) {
    // Decrypt JWT token if it came from cookie (encrypted) vs Authorization header (plain)
    if (req.cookies.authToken && token === req.cookies.authToken) {
      token = decryptJWT(token)
      if (!token) {
        // Clear invalid encrypted cookie only if headers not sent
        if (!res.headersSent) {
          res.clearCookie('authToken', withCookieDefaults({
            httpOnly: true // Explicit for CodeQL static analysis (prevents js/client-exposed-cookie alert)
          }))
        }
        req.isAuthenticated = false
        req.csrfSecret = deriveCSRFSecret(generateSessionId())
        return next()
      }
    }
    
    jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }, (err, user) => {
      if (!err) {
        req.user = user
        req.isAuthenticated = true
      } else if (req.cookies.authToken && !res.headersSent) {
        // Clear invalid cookie only if headers not sent
        clearCookieAllPaths(res, 'authToken')
      }
    })
  }
  req.isAuthenticated = req.isAuthenticated || false
  
  // Get or create session ID for CSRF secret derivation
  let sessionId = req.cookies.csrfSessionId
  if (!sessionId) {
    sessionId = generateSessionId()
    // Only set cookie if headers haven't been sent
    if (!res.headersSent) {
      res.cookie('csrfSessionId', sessionId, withCookieDefaults({
        httpOnly: true, // Explicit for CodeQL static analysis (prevents js/client-exposed-cookie alert)
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
      }))
    }
  }
  
  // Derive CSRF secret from session ID (no cleartext storage)
  req.csrfSecret = deriveCSRFSecret(sessionId)
  next()
}

// Permission middleware
const requireRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.isAuthenticated || !req.user) {
      return res.status(401).json({ error: 'Authentication required' })
    }
    
    const userRole = req.user.role
    const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles]
    
    if (!roles.includes(userRole)) {
      return res.status(403).json({ 
        error: 'Insufficient permissions',
        required: roles,
        current: userRole
      })
    }
    
    next()
  }
}

// Specific permission shortcuts
const requireAdmin = requireRole('admin')
const requireEditor = requireRole(['admin', 'editor'])

// Generate JWT token with explicit algorithm (prevents algorithm confusion attacks)
const JWT_ALGORITHM = 'HS256'
const JWT_ACCESS_TOKEN_EXPIRY = process.env.JWT_ACCESS_TOKEN_EXPIRY || '15m'
const JWT_REFRESH_TOKEN_EXPIRY = process.env.JWT_REFRESH_TOKEN_EXPIRY || '7d'

const generateToken = (user) => {
  return jwt.sign(
    { 
      username: user.username, 
      email: user.email,
      role: user.role || 'admin',
      type: 'access'
    }, 
    JWT_SECRET, 
    { expiresIn: JWT_ACCESS_TOKEN_EXPIRY, algorithm: JWT_ALGORITHM }
  )
}

const generateRefreshToken = (user) => {
  return jwt.sign(
    { 
      username: user.username,
      role: user.role || 'admin',
      type: 'refresh'
    }, 
    JWT_SECRET, 
    { expiresIn: JWT_REFRESH_TOKEN_EXPIRY, algorithm: JWT_ALGORITHM }
  )
}

// API Routes

// Authentication Routes

// Get CSRF token endpoint (public)
app.get('/api/csrf-token', checkAuth, (req, res) => {
  const secret = req.csrfSecret
  const token = tokens.create(secret)
  
  // Session ID is already set by checkAuth middleware if needed
  // No need to store secret in cleartext in cookies
  
  res.json({ csrfToken: token })
})

// Login endpoint
app.post('/api/auth/login', 
  authLimiter,
  [
    body('username')
      .isLength({ min: 1, max: 50 })
      .withMessage('Username is required'),
    body('password')
      .isLength({ min: 1, max: 100 })
      .withMessage('Password is required')
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { username, password } = req.body

      let user = null
      let isDbUser = false

      // Step 1: Check database users first
      try {
        const dbUser = await db.getUserByUsername(username)
        if (dbUser && dbUser.is_active) {
          const isValidPassword = await bcrypt.compare(password, dbUser.password_hash)
          if (isValidPassword) {
            user = {
              id: dbUser.id,
              username: dbUser.username,
              email: dbUser.email,
              role: dbUser.role,
              displayName: dbUser.display_name
            }
            isDbUser = true
            // Update last login time
            await db.updateUserLastLogin(dbUser.id)
          }
        }
      } catch (dbError) {
        console.error('Database user lookup error:', dbError)
        // Continue to check env-based users
      }

      // Step 2: Fall back to env-based admin/editor (always available as super users)
      if (!user) {
        if (username === ADMIN_USERNAME) {
          const isValidPassword = await bcrypt.compare(password, hashedAdminPassword)
          if (isValidPassword) {
            user = {
              username: ADMIN_USERNAME,
              email: ADMIN_EMAIL,
              role: 'admin',
              displayName: 'System Admin'
            }
          }
        } else if (username === EDITOR_USERNAME) {
          const isValidPassword = await bcrypt.compare(password, hashedEditorPassword)
          if (isValidPassword) {
            user = {
              username: EDITOR_USERNAME,
              email: EDITOR_EMAIL,
              role: 'editor',
              displayName: 'System Editor'
            }
          }
        }
      }
      
      if (user) {
          const token = generateToken(user)
          const refreshToken = generateRefreshToken(user)
          
          // Encrypt JWT token before storing in httpOnly cookie (addresses CodeQL alert)
          const encryptedToken = encryptJWT(token)
          const encryptedRefreshToken = encryptJWT(refreshToken)
          
          res.cookie('authToken', encryptedToken, withCookieDefaults({
            httpOnly: true, // Explicit for CodeQL static analysis (prevents js/client-exposed-cookie alert)
            maxAge: 15 * 60 * 1000 // 15 minutes (short-lived access token)
          }))
          
          res.cookie('refreshToken', encryptedRefreshToken, withCookieDefaults({
            httpOnly: true,
            maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days (long-lived refresh token)
          }))
          
          // Generate new session ID for CSRF protection
          const sessionId = generateSessionId()
          const csrfSecret = deriveCSRFSecret(sessionId)
          const csrfToken = tokens.create(csrfSecret)
          
          // Set session ID in httpOnly cookie (not the secret itself)
          res.cookie('csrfSessionId', sessionId, withCookieDefaults({
            httpOnly: true, // Explicit for CodeQL static analysis (prevents js/client-exposed-cookie alert)
            maxAge: 24 * 60 * 60 * 1000 // 24 hours
          }))
          
          // Detect client type - API clients should include 'Accept: application/json' header
          // and no 'Accept: text/html' (which browsers send)
          const isAPIClient = !req.headers.accept?.includes('text/html') && 
                             req.headers.accept?.includes('application/json')
          
          const response = {
            success: true,
            message: 'Login successful',
            csrfToken: csrfToken, // Always send CSRF token for form protection
            user: {
              id: user.id,
              username: user.username,
              email: user.email,
              role: user.role,
              displayName: user.displayName,
              isSystemUser: !isDbUser
            }
          }
          
          // Only include JWT token for API clients (security best practice)
          if (isAPIClient) {
            response.token = token
            response.authMethod = 'bearer_token'
          } else {
            response.authMethod = 'httponly_cookie'
          }
          
          res.json(response)
      } else {
        res.status(401).json({ error: 'Invalid credentials' })
      }
    } catch (error) {
      console.error('Login error:', error)
      res.status(500).json({ error: 'Login failed' })
    }
  }
)

// Logout endpoint (requires CSRF protection for authenticated users)
app.post('/api/auth/logout', checkAuth, (req, res) => {
  try {
    // Check if headers have already been sent
    if (res.headersSent) {
      console.warn('⚠️ Headers already sent in logout endpoint')
      return
    }

    // Check if user is authenticated before applying CSRF
    if (req.isAuthenticated) {
      // Apply CSRF validation for authenticated logout
      const token = req.get('X-CSRF-Token') || req.body._csrf
      const secret = req.csrfSecret
      
      if (!token || !tokens.verify(secret, token)) {
        return res.status(403).json({ 
          error: 'Invalid CSRF token',
          csrfRequired: true 
        })
      }
    }
    
    // Clear authentication and CSRF cookies
    clearCookieAllPaths(res, 'authToken')
    clearCookieAllPaths(res, 'refreshToken')
    clearCookieAllPaths(res, 'csrfSessionId')
    
    // Send success response only once
    return res.json({ success: true, message: 'Logged out successfully' })
    
  } catch (error) {
    console.error('Logout error:', error)
    
    // Only send error response if headers haven't been sent
    if (!res.headersSent) {
      return res.status(500).json({ 
        success: false,
        error: 'Logout failed' 
      })
    }
  }
})

// Check authentication status
app.get('/api/auth/status', checkAuth, (req, res) => {
  if (req.isAuthenticated) {
    // Generate new CSRF token for authenticated users
    const secret = req.csrfSecret
    const csrfToken = tokens.create(secret)
    
    res.json({
      authenticated: true,
      user: req.user,
      csrfToken
    })
  } else {
    res.json({
      authenticated: false
    })
  }
})

// CSP violation reporting endpoint
app.post('/api/csp-report', express.json({ type: 'application/csp-report' }), (req, res) => {
  const violation = req.body['csp-report'] || req.body
  if (violation) {
    logError('CSP Violation', {
      blockedUri: violation['blocked-uri'],
      violatedDirective: violation['violated-directive'],
      documentUri: violation['document-uri'],
      sourceFile: violation['source-file'],
      lineNumber: violation['line-number'],
      columnNumber: violation['column-number']
    })
  }
  res.status(204).end()
})

// JWT refresh token endpoint
app.post('/api/auth/refresh', async (req, res) => {
  try {
    const encryptedRefreshToken = req.cookies?.refreshToken
    
    if (!encryptedRefreshToken) {
      return res.status(401).json({ error: 'No refresh token provided' })
    }
    
    // Decrypt and verify refresh token
    let decoded
    try {
      const refreshToken = decryptJWT(encryptedRefreshToken)
      decoded = jwt.verify(refreshToken, JWT_SECRET, { algorithms: [JWT_ALGORITHM] })
      
      if (decoded.type !== 'refresh') {
        return res.status(401).json({ error: 'Invalid token type' })
      }
    } catch (err) {
      return res.status(401).json({ error: 'Invalid refresh token' })
    }
    
    // Generate new access token
    const user = { username: decoded.username, role: decoded.role }
    const newAccessToken = generateToken(user)
    const encryptedAccessToken = encryptJWT(newAccessToken)
    
    res.cookie('authToken', encryptedAccessToken, withCookieDefaults({
      httpOnly: true,
      maxAge: 15 * 60 * 1000 // 15 minutes
    }))
    
    // Generate new CSRF token
    const sessionId = req.cookies?.csrfSessionId || generateSessionId()
    const csrfSecret = deriveCSRFSecret(sessionId)
    const csrfToken = tokens.create(csrfSecret)
    
    res.json({
      success: true,
      csrfToken,
      user: { username: decoded.username, role: decoded.role }
    })
  } catch (error) {
    console.error('Token refresh error:', error)
    res.status(500).json({ error: 'Token refresh failed' })
  }
})

// Database API Routes

app.use('/api/players', createPlayerRouter({
  db,
  checkAuth,
  authenticateToken,
  requireAdmin,
  conditionalRateLimit,
  createLimiter,
  deleteLimiter,
  handleValidationErrors,
  rankingsCache,
  sanitizeResponse
}))

app.use('/api/seasons', createSeasonRouter({
  db,
  checkAuth,
  authenticateToken,
  requireAdmin,
  requireEditor,
  conditionalRateLimit,
  createLimiter,
  deleteLimiter,
  handleValidationErrors,
  rankingsCache,
  sanitizeResponse
}))

app.use('/api/matches', createMatchRouter({
  db,
  checkAuth,
  authenticateToken,
  requireEditor,
  conditionalRateLimit,
  createLimiter,
  deleteLimiter,
  handleValidationErrors,
  rankingsCache,
  sanitizeResponse
}))

app.use('/api/rankings', createRankingRouter({
  db,
  checkAuth,
  rankingsCache
}))

app.use('/api/export-excel', createExportRouter({
  db,
  checkAuth,
  authenticateToken,
  conditionalRateLimit,
  exportLimiter
}))

// User Account Management Routes (admin only)
app.use('/api/auth', createAuthRouter({
  db,
  authenticateToken,
  requireAdmin,
  handleValidationErrors,
  conditionalRateLimit,
  createLimiter,
  sanitizeResponse
}))

// Players Routes
// Legacy player routes migrated to modular router

// Legacy season routes removed — served by modular router (routes/seasons.js)

// Legacy match routes removed — served by modular router (routes/matches.js)

// Play dates Routes (kept as legacy — frontend calls /api/play-dates directly)
app.get('/api/play-dates', checkAuth, async (req, res) => {
  try {
    const { data } = await rankingsCache.getOrSet('playdates', () => db.getPlayDates())
    res.json(data)
  } catch (error) {
    console.error('Error getting play dates:', error)
    res.status(500).json({ error: 'Failed to get play dates' })
  }
})

app.get('/api/play-dates/latest', checkAuth, async (req, res) => {
  try {
    const { data } = await rankingsCache.getOrSet('playdate:latest', () => db.getLatestPlayDate())
    res.json({ playDate: data })
  } catch (error) {
    console.error('Error getting latest play date:', error)
    res.status(500).json({ error: 'Failed to get latest play date' })
  }
})

// Legacy ranking routes removed — served by modular router (routes/rankings.js)

// Excel Export Route
app.get('/api/export-excel', checkAuth, conditionalRateLimit(exportLimiter), async (req, res) => {
  try {
    const [players, seasons, matches, rankings] = await Promise.all([
      db.getPlayers(),
      db.getSeasons(),
      db.getMatches(),
      db.getPlayerStatsLifetime()
    ])
    
    const buffer = await createFullExportBuffer({ players, seasons, matches, rankings })
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="tennis-rankings-${new Date().toISOString().split('T')[0]}.xlsx"`)
    res.send(Buffer.from(buffer))
  } catch (error) {
    console.error('Error exporting to Excel:', error)
    res.status(500).json({ error: 'Failed to export to Excel' })
  }
})

// Export Excel by Date
app.get('/api/export-excel/date/:date', checkAuth, conditionalRateLimit(exportLimiter), async (req, res) => {
  try {
    const { date } = req.params
    
    const [rankings, matches] = await Promise.all([
      db.getPlayerStatsBySpecificDate(date),
      db.getMatchesByDate(date)
    ])
    
    const buffer = await createDateExportBuffer({ date, rankings, matches })
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="tennis-rankings-${date}.xlsx"`)
    res.send(Buffer.from(buffer))
  } catch (error) {
    console.error('Error exporting date data to Excel:', error)
    res.status(500).json({ error: 'Failed to export date data to Excel' })
  }
})

// Export Excel by Season
app.get('/api/export-excel/season/:seasonId', checkAuth, conditionalRateLimit(exportLimiter), async (req, res) => {
  try {
    const { seasonId } = req.params
    
    const [season, rankings, matches] = await Promise.all([
      db.getSeasonById(seasonId),
      db.getPlayerStatsBySeason(seasonId),
      db.getMatchesBySeason(seasonId)
    ])
    
    const seasonName = season ? season.name : `Mùa ${seasonId}`
    const buffer = await createSeasonExportBuffer({ seasonName, rankings, matches })
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="tennis-rankings-season-${seasonId}.xlsx"`)
    res.send(Buffer.from(buffer))
  } catch (error) {
    console.error('Error exporting season data to Excel:', error)
    res.status(500).json({ error: 'Failed to export season data to Excel' })
  }
})

// Export Excel Lifetime
app.get('/api/export-excel/lifetime', checkAuth, conditionalRateLimit(exportLimiter), async (req, res) => {
  try {
    const [players, seasons, matches, rankings] = await Promise.all([
      db.getPlayers(),
      db.getSeasons(),
      db.getMatches(),
      db.getPlayerStatsLifetime()
    ])
    
    const buffer = await createLifetimeExportBuffer({ players, seasons, matches, rankings })
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="tennis-rankings-lifetime.xlsx"`)
    res.send(Buffer.from(buffer))
  } catch (error) {
    console.error('Error exporting lifetime data to Excel:', error)
    res.status(500).json({ error: 'Failed to export lifetime data to Excel' })
  }
})

// Clear All Data Route (DANGEROUS!)
app.delete('/api/clear-all-data', 
  authenticateToken,
  requireAdmin,
  conditionalRateLimit(criticalLimiter),
  async (req, res) => {
    try {
      console.log(`⚠️ CLEAR ALL DATA requested by user: ${req.user.username}`)
      
      // Clear all data from database
      await db.clearAllData()
      
      // Clear all cache after clearing database
      await rankingsCache.clear()
      
      console.log('✅ All data cleared successfully')
      res.json({ 
        success: true, 
        message: 'All data cleared successfully',
        timestamp: formatSecureTimestamp()
      })
    } catch (error) {
      console.error('Error clearing all data:', error)
      res.status(500).json({ error: 'Failed to clear all data' })
    }
  }
)

// Backup Route - Simple JSON backup for admin
app.get('/api/backup', 
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      console.log(`📦 BACKUP requested by user: ${req.user.username}`)
      
      const [players, seasons, matches, users] = await Promise.all([
        db.getPlayers(),
        db.getSeasons(),
        db.getMatches(),
        db.getUsersForBackup() // Use method that includes password_hash
      ])
      
      // Get season players for each season
      const seasonsWithPlayers = await Promise.all(seasons.map(async (season) => {
        const seasonPlayers = await db.getSeasonPlayers(season.id)
        return { ...season, players: seasonPlayers.map(p => p.player_id || p.id) }
      }))
      
      // Remove sensitive data from users but keep password_hash for restore
      const usersForBackup = users.map(user => ({
        id: user.id,
        username: user.username,
        email: user.email,
        password_hash: user.password_hash, // Keep for restore
        role: user.role,
        display_name: user.display_name,
        is_active: user.is_active,
        created_at: user.created_at,
        notes: user.notes
      }))
      
      const backupData = {
        version: '2.1',
        timestamp: new Date().toISOString(),
        exportedBy: req.user.username,
        players,
        seasons: seasonsWithPlayers,
        matches,
        users: usersForBackup
      }
      
      res.json(backupData)
      console.log('✅ Backup created successfully (including users)')
    } catch (error) {
      console.error('Error creating backup:', error)
      res.status(500).json({ error: 'Failed to create backup' })
    }
  }
)

// Restore Route - Full database restore from JSON
app.post('/api/restore', 
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const backupData = req.body
      const currentUserId = req.user.id
      const currentUsername = req.user.username
      console.log(`🔄 RESTORE requested by user: ${currentUsername}`)
      
      // Validate backup structure
      if (!backupData.players || !backupData.seasons || !backupData.matches) {
        return res.status(400).json({ error: 'Invalid backup file structure' })
      }
      
      const hasUsers = backupData.users && backupData.users.length > 0
      console.log(`📊 Restoring: ${backupData.players.length} players, ${backupData.seasons.length} seasons, ${backupData.matches.length} matches${hasUsers ? `, ${backupData.users.length} users` : ''}`)
      
      // Clear existing data first (but preserve current admin user)
      console.log('🗑️ Clearing existing data...')
      await db.clearAllDataForRestore(currentUserId)
      
      // Restore players first
      const playerIdMap = new Map() // old id -> new id
      for (const player of backupData.players) {
        const newPlayerId = await db.addPlayer(player.name)
        // Use Number() to ensure consistent key types
        // Note: addPlayer returns just the ID, not an object
        playerIdMap.set(Number(player.id), newPlayerId)
        console.log(`  👤 Player ${player.id} -> ${newPlayerId} (${player.name})`)
      }
      console.log(`✅ Restored ${backupData.players.length} players`)
      
      // Restore seasons
      const seasonIdMap = new Map() // old id -> new id
      for (const season of backupData.seasons) {
        // createSeason signature: (name, startDate, endDate, autoEnd, description, loseMoneyPerLoss, playerIds)
        const newSeasonId = await db.createSeason(
          season.name,
          season.start_date,
          season.end_date || null,
          season.auto_end !== false,
          season.description || '',
          season.lose_money_per_loss || 20000,
          [] // Players will be added after all players are restored
        )
        // Use Number() to ensure consistent key types
        seasonIdMap.set(Number(season.id), newSeasonId)
        console.log(`  📅 Season ${season.id} -> ${newSeasonId} (${season.name})`)
        
        // If the original season was inactive, deactivate the new one too
        if (season.is_active === false) {
          await db.query('UPDATE seasons SET is_active = false WHERE id = $1', [newSeasonId])
          console.log(`    ⏸️ Set season ${newSeasonId} as inactive`)
        }
        
        // Add season players if any
        if (season.players && season.players.length > 0) {
          const newPlayerIds = season.players.map(oldId => playerIdMap.get(Number(oldId))).filter(Boolean)
          if (newPlayerIds.length > 0) {
            await db.setSeasonPlayers(newSeasonId, newPlayerIds)
          }
        }
      }
      console.log(`✅ Restored ${backupData.seasons.length} seasons`)
      
      // Debug: Log ID mappings
      console.log('🗺️ Player ID Map:', Object.fromEntries(playerIdMap))
      console.log('🗺️ Season ID Map:', Object.fromEntries(seasonIdMap))
      
      // Log first match from backup to debug structure
      if (backupData.matches.length > 0) {
        console.log('📋 First match in backup:', JSON.stringify(backupData.matches[0], null, 2))
      }
      
      // Restore matches
      let matchesRestored = 0
      let matchesSkipped = 0
      for (const match of backupData.matches) {
        // Convert to numbers to ensure proper Map lookup
        const oldSeasonId = Number(match.season_id)
        const oldPlayer1Id = Number(match.player1_id)
        const oldPlayer2Id = match.player2_id ? Number(match.player2_id) : null
        const oldPlayer3Id = Number(match.player3_id)
        const oldPlayer4Id = match.player4_id ? Number(match.player4_id) : null
        
        const newSeasonId = seasonIdMap.get(oldSeasonId)
        const newPlayer1Id = playerIdMap.get(oldPlayer1Id)
        const newPlayer2Id = oldPlayer2Id ? playerIdMap.get(oldPlayer2Id) : null
        const newPlayer3Id = playerIdMap.get(oldPlayer3Id)
        const newPlayer4Id = oldPlayer4Id ? playerIdMap.get(oldPlayer4Id) : null
        
        if (newSeasonId && newPlayer1Id && newPlayer3Id) {
          try {
            // addMatchWithTimestamp preserves original created_at for correct form/phong độ ordering
            await db.addMatchWithTimestamp(
              newSeasonId,
              match.play_date,
              newPlayer1Id,
              newPlayer2Id,
              newPlayer3Id,
              newPlayer4Id,
              match.team1_score,
              match.team2_score,
              match.winning_team,
              match.match_type || 'duo',
              match.created_at || null  // Preserve original timestamp if available
            )
            matchesRestored++
          } catch (matchError) {
            console.error(`❌ Error restoring match:`, matchError.message)
            matchesSkipped++
          }
        } else {
          console.log(`⚠️ Skipping match - missing mapping: seasonId=${oldSeasonId}->${newSeasonId}, p1=${oldPlayer1Id}->${newPlayer1Id}, p3=${oldPlayer3Id}->${newPlayer3Id}`)
          matchesSkipped++
        }
      }
      console.log(`✅ Restored ${matchesRestored} matches (${matchesSkipped} skipped)`)
      
      // Restore users if present in backup
      let usersRestored = 0
      let usersSkipped = 0
      if (hasUsers) {
        for (const user of backupData.users) {
          // Skip if this is the current logged-in user (don't overwrite ourselves)
          if (user.username === currentUsername) {
            console.log(`⏭️ Skipping current user: ${user.username}`)
            usersSkipped++
            continue
          }
          
          // Check if username already exists (shouldn't happen after clear, but safety check)
          const existingByUsername = await db.checkUsernameExists(user.username)
          if (existingByUsername) {
            console.log(`⏭️ Username already exists: ${user.username}`)
            usersSkipped++
            continue
          }
          
          // Check if email already exists (the current user might have the same email)
          const existingByEmail = await db.checkEmailExists(user.email)
          if (existingByEmail) {
            console.log(`⏭️ Email already exists: ${user.email} (skipping user ${user.username})`)
            usersSkipped++
            continue
          }
          
          // Restore user with original password hash
          try {
            await db.restoreUser(
              user.username,
              user.email,
              user.password_hash,
              user.role,
              user.display_name,
              user.is_active,
              user.notes
            )
            usersRestored++
            console.log(`✅ Restored user: ${user.username}`)
          } catch (userError) {
            console.error('Error restoring user %s:', user.username, userError.message)
            usersSkipped++
          }
        }
        console.log(`✅ Restored ${usersRestored} users (${usersSkipped} skipped)`)
      }
      
      // Clear cache
      await rankingsCache.clear()
      
      res.json({ 
        success: true, 
        message: 'Data restored successfully',
        restored: {
          players: backupData.players.length,
          seasons: backupData.seasons.length,
          matches: backupData.matches.length,
          users: usersRestored
        }
      })
      console.log('✅ Restore completed successfully')
    } catch (error) {
      console.error('Error restoring data:', error)
      res.status(500).json({ error: 'Failed to restore data' })
    }
  }
)

// Backup Data Route (exports all data as JSON)
app.get('/api/backup-data', 
  authenticateToken,
  conditionalRateLimit(exportLimiter),
  async (req, res) => {
    try {
      console.log(`📦 BACKUP DATA requested by user: ${req.user.username}`)
      
      // Get all data from database
      const [players, seasons, matches] = await Promise.all([
        db.getPlayers(),
        db.getSeasons(),
        db.getMatches()
      ])
      
      const backupData = {
        version: '1.0',
        timestamp: formatSecureTimestamp(),
        exportedBy: req.user.username,
        data: {
          players,
          seasons,
          matches
        },
        metadata: {
          playersCount: players.length,
          seasonsCount: seasons.length,
          matchesCount: matches.length
        }
      }
      
      const fileName = `tennis-backup-${new Date().toISOString().split('T')[0]}-${Date.now()}.json`
      
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
      res.json(backupData)
      
      console.log('✅ Backup data exported successfully')
    } catch (error) {
      console.error('Error creating backup:', error)
      res.status(500).json({ error: 'Failed to create backup' })
    }
  }
)

// Restore Data Route (imports data from JSON backup)
app.post('/api/restore-data', 
  authenticateToken,
  requireAdmin,
  conditionalRateLimit(restoreLimiter),
  [
    body('backupData')
      .isObject()
      .withMessage('Backup data must be a valid JSON object'),
    body('clearExisting')
      .optional()
      .isBoolean()
      .withMessage('clearExisting must be boolean'),
    body('backupData.version')
      .exists()
      .withMessage('Backup file must have version'),
    body('backupData.data')
      .isObject()
      .withMessage('Backup data must contain data object')
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { backupData, clearExisting = false } = req.body
      
      console.log(`🔄 RESTORE DATA requested by user: ${req.user.username}`)
      console.log(`📊 Backup info: Version ${backupData.version}, Created: ${backupData.timestamp}`)
      
      // Validate backup data structure
      if (!backupData.data || !backupData.data.players || !backupData.data.seasons || !backupData.data.matches) {
        return res.status(400).json({ error: 'Invalid backup file structure' })
      }
      
      // Clear existing data if requested
      if (clearExisting) {
        console.log('🗑️ Clearing existing data before restore...')
        await db.clearAllData()
      }
      
      const { players, seasons, matches } = backupData.data
      const results = {
        playersImported: 0,
        seasonsImported: 0,
        matchesImported: 0,
        errors: []
      }
      
      // Import players
      for (const player of players) {
        try {
          await db.addPlayer(player.name)
          results.playersImported++
        } catch (error) {
          if (!error.message.includes('UNIQUE constraint failed')) {
            results.errors.push(`Player ${player.name}: ${error.message}`)
          }
          // Skip duplicate players silently if not clearing existing data
        }
      }
      
      // Import seasons - first pass: create all seasons
      const seasonMapping = new Map() // To map old season names to new IDs
      
      for (const season of seasons) {
        try {
          const seasonId = await db.createSeason(season.name, season.start_date)
          seasonMapping.set(season.name, seasonId)
          
          // Handle end date (but not active state yet)
          if (season.end_date) {
            await db.endSeason(seasonId, season.end_date)
          }
          
          results.seasonsImported++
        } catch (error) {
          results.errors.push(`Season ${season.name}: ${error.message}`)
        }
      }
      
      // Second pass: Set active states correctly
      // First, ensure no seasons are active
      await db.query('UPDATE seasons SET is_active = false', [])
      
      // Then set the correct active season(s) from backup
      for (const season of seasons) {
        if (season.is_active) {
          const seasonId = seasonMapping.get(season.name)
          if (seasonId) {
            try {
              console.log(`Setting season ${season.name} as active: ${seasonId}`)
              await db.query('UPDATE seasons SET is_active = $1 WHERE id = $2', [true, seasonId])
              
              // If this season was active but had an end date, we need to remove the end date
              // because active seasons shouldn't have end dates
              if (season.end_date) {
                await db.query('UPDATE seasons SET end_date = NULL WHERE id = $1', [seasonId])
              }
            } catch (error) {
              results.errors.push(`Setting season ${season.name} as active: ${error.message}`)
            }
          }
        }
      }
      
      // Import matches (this is more complex as we need to map player names to IDs)
      const currentPlayers = await db.getPlayers()
      
      for (const match of matches) {
        try {
          // Find player IDs by name
          const player1 = currentPlayers.find(p => p.name === match.player1_name)
          const player2 = currentPlayers.find(p => p.name === match.player2_name)
          const player3 = currentPlayers.find(p => p.name === match.player3_name)
          const player4 = currentPlayers.find(p => p.name === match.player4_name)
          
          // Find season ID using our mapping
          const seasonId = seasonMapping.get(match.season_name)
          
          if (!player1 || !player2 || !player3 || !player4 || !seasonId) {
            results.errors.push(`Match ${match.id}: Missing players or season`)
            continue
          }
          
          await db.addMatch(
            seasonId,
            match.play_date,
            player1.id,
            player2.id,
            player3.id,
            player4.id,
            match.team1_score,
            match.team2_score,
            match.winning_team
          )
          results.matchesImported++
        } catch (error) {
          results.errors.push(`Match ${match.id}: ${error.message}`)
        }
      }
      
      console.log('✅ Data restore completed')
      console.log(`📊 Results: ${results.playersImported} players, ${results.seasonsImported} seasons, ${results.matchesImported} matches`)
      
      // Invalidate all cache after data restore
      await rankingsCache.clear()
      
      res.json({
        success: true,
        message: 'Data restored successfully',
        results,
        timestamp: formatSecureTimestamp()
      })
    } catch (error) {
      console.error('Error restoring data:', error)
      res.status(500).json({ error: 'Failed to restore data' })
    }
  }
)

// Cache Stats Route (admin only - for monitoring cache performance)
app.get('/api/cache-stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const stats = rankingsCache.getStats()
    const info = await rankingsCache.getInfo()
    
    res.json({
      success: true,
      cacheStats: {
        ...stats,
        currentEntries: info.currentEntries || 0,
        memoryUsage: info.memoryUsage || 'N/A'
      },
      recommendations: {
        performance: stats.hitRate === '0.00%' ? 'Cache chưa được sử dụng - bình thường cho hệ thống mới' :
                    parseFloat(stats.hitRate) < 50 ? 'Tỷ lệ hit thấp - cần kiểm tra logic invalidation' :
                    parseFloat(stats.hitRate) > 80 ? 'Hiệu suất cache xuất sắc' :
                    'Hiệu suất cache tốt',
        memory: info.memoryUsage && info.memoryUsage !== 'N/A' ? 
                `Đang sử dụng ${info.memoryUsage} bộ nhớ` :
                'Thông tin bộ nhớ không khả dụng',
        info: 'Cache tự động invalidate khi dữ liệu thay đổi'
      },
      serverInfo: {
        uptime: Math.floor(process.uptime()),
        environment: process.env.NODE_ENV || 'development',
        redisConnected: stats.isConnected || false
      }
    })
  } catch (error) {
    console.error('Error getting cache stats:', error)
    res.status(500).json({ error: 'Failed to get cache statistics' })
  }
})

// SSE endpoint — pushes data-version changes to connected clients in real time
// Replaces the need for polling /api/data-version every 2 minutes
const sseClients = new Set()

app.get('/api/events', (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // Disable Nginx buffering for SSE
  res.flushHeaders()

  // Send initial version so client can sync immediately
  const currentVersion = rankingsCache.getDataVersion()
  res.write(`data: ${JSON.stringify({ version: currentVersion })}\n\n`)

  // Keep-alive: send a comment every 30s to prevent proxy/browser timeout
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n')
  }, 30000)

  // Track this client
  sseClients.add(res)

  // Clean up on disconnect
  req.on('close', () => {
    clearInterval(keepAlive)
    sseClients.delete(res)
  })
})

// Push version changes to all SSE clients when cache is invalidated
rankingsCache.on('versionChange', (version) => {
  const payload = `data: ${JSON.stringify({ version })}\n\n`
  for (const client of sseClients) {
    try {
      client.write(payload)
    } catch {
      sseClients.delete(client)
    }
  }
})

// Data version endpoint (public - for client cache sync)
// Clients poll this to check if their cache is stale (fallback when SSE unavailable)
app.get('/api/data-version', (req, res) => {
  res.json({
    version: rankingsCache.getDataVersion(),
    timestamp: formatSecureTimestamp()
  })
})

// Combined init endpoint — single request replaces 4-6 parallel fetches on page load
// Returns: players, seasons, playDates, latestPlayDate, activeSeasons, lifetime rankings, data version
// All data comes from Redis cache (permanent startup keys, stampede-protected)
app.get('/api/init', checkAuth, async (req, res) => {
  try {
    const [
      { data: players },
      { data: seasons },
      { data: playDates },
      { data: latestPlayDate },
      { data: activeSeasons },
      { data: lifetimeRankings }
    ] = await Promise.all([
      rankingsCache.getOrSet('players', () => db.getPlayers()),
      rankingsCache.getOrSet('seasons', () => db.getSeasons()),
      rankingsCache.getOrSet('playdates', () => db.getPlayDates()),
      rankingsCache.getOrSet('playdate:latest', () => db.getLatestPlayDate()),
      rankingsCache.getOrSet('seasons:active', () => db.getActiveSeasons()),
      rankingsCache.getOrSet('rankings:lifetime', () => db.getPlayerStatsWithFormsLifetime(5))
    ])

    // Determine the default view date (latest play date)
    const defaultDate = latestPlayDate || (playDates.length > 0 ? (playDates[0].play_date?.split('T')[0] || playDates[0].play_date) : null)

    // Also fetch date rankings + matches for the latest date if available (likely cache-hit from startup warmup)
    let defaultDateRankings = null
    let defaultDateMatches = null
    if (defaultDate) {
      const dateOnly = defaultDate.split('T')[0]
      const [dateRankingsResult, dateMatchesResult] = await Promise.all([
        rankingsCache.getOrSet(`rankings:date:${dateOnly}`, () => db.getPlayerStatsWithFormsByDate(dateOnly, 5)),
        rankingsCache.getOrSet(`matches:date:${dateOnly}`, () => db.getMatchesByPlayDate(dateOnly))
      ])
      defaultDateRankings = dateRankingsResult.data
      defaultDateMatches = dateMatchesResult.data
    }

    res.json(sanitizeResponse({
      players,
      seasons,
      playDates,
      latestPlayDate,
      activeSeasons,
      lifetimeRankings,
      defaultDate: defaultDate ? defaultDate.split('T')[0] : null,
      defaultDateRankings,
      defaultDateMatches,
      version: rankingsCache.getDataVersion()
    }))
  } catch (error) {
    console.error('Error in /api/init:', error)
    res.status(500).json({ error: 'Failed to load initial data' })
  }
})

// System Health Route (admin only)
app.get('/api/health', authenticateToken, (req, res) => {
  const stats = rankingsCache.getStats()
  const uptime = process.uptime()
  
  res.json({
    status: 'healthy',
    timestamp: formatSecureTimestamp(),
    uptime: {
      seconds: Math.floor(uptime),
      human: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`
    },
    cache: {
      isActive: stats.currentEntries > 0,
      entries: stats.currentEntries,
      efficiency: stats.hitRate,
      totalOperations: stats.hits + stats.misses,
      dataVersion: stats.dataVersion
    },
    database: 'postgresql',
    environment: process.env.NODE_ENV || 'development'
  })
})

// System Performance Route (admin only - development only)
app.get('/api/performance', authenticateToken, async (req, res) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(404).json({ error: 'Endpoint not available in production' })
  }
  
  const stats = rankingsCache.getStats()
  const memUsage = process.memoryUsage()
  
  // Get database pool stats
  let dbStats = { error: 'Database stats not available' }
  try {
    dbStats = {
      totalConnections: db.pool.totalCount,
      idleConnections: db.pool.idleCount,
      waitingClients: db.pool.waitingCount
    }
  } catch (error) {
    console.log('Could not get DB stats:', error.message)
  }
  
  res.json({
    status: 'ok',
    timestamp: formatSecureTimestamp(),
    performance: {
      memory: {
        rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
        heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
        external: `${Math.round(memUsage.external / 1024 / 1024)}MB`
      },
      database: dbStats,
      cache: {
        entries: stats.currentEntries,
        hitRate: stats.hitRate,
        operations: stats.hits + stats.misses
      },
      uptime: Math.floor(process.uptime()),
      recommendations: {
        memory: memUsage.heapUsed < 100 * 1024 * 1024 ? 'Good' : 'Consider monitoring',
        database: dbStats.totalConnections > 15 ? 'High connection usage' : 'Normal',
        cache: parseFloat(stats.hitRate) > 70 ? 'Excellent' : 'Consider optimization'
      }
    }
  })
})

// Access Logs and Analytics Routes (Admin only)

// Get access log statistics
app.get('/api/admin/access-stats', 
  authenticateToken,
  requireAdmin,
  smartApiLimiter,
  [
    query('hours').optional().isInt({ min: 1, max: 720 }).withMessage('Hours must be between 1 and 720')
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const hours = parseInt(req.query.hours) || 24;
      const stats = await getLogStats(hours);
      
      res.json({
        success: true,
        timeframe: `${hours} hours`,
        stats,
        timestamp: formatSecureTimestamp()
      });
    } catch (error) {
      console.error('Error getting access stats:', error);
      res.status(500).json({ error: 'Failed to get access statistics' });
    }
  }
)

// Get recent access logs (last N entries)
app.get('/api/admin/access-logs', 
  authenticateToken,
  requireAdmin,
  smartApiLimiter,
  [
    query('limit').optional().isInt({ min: 1, max: 10000 }).withMessage('Limit must be between 1 and 10000'),
    query('offset').optional().isInt({ min: 0 }).withMessage('Offset must be non-negative'),
    query('ip').optional().isIP().withMessage('Invalid IP address format'),
    query('user').optional().trim().escape().isLength({ max: 100 }).withMessage('User filter too long'),
    query('path').optional().trim().isLength({ max: 500 }).withMessage('Path filter too long')
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 100;
      const offset = parseInt(req.query.offset) || 0;
      const filterIP = req.query.ip;
      const filterUser = req.query.user;
      const filterPath = req.query.path;
      
      // For now, return a message about log file location
      res.json({
        success: true,
        message: 'Access logs are stored in rotating files. Use the log files in /logs directory for detailed analysis.',
        logLocation: '/logs/access.log',
        parameters: {
          limit,
          offset,
          filters: {
            ip: filterIP,
            user: filterUser,
            path: filterPath
          }
        },
        note: 'Real-time log querying from database will be implemented in future version.',
        currentLogFile: 'logs/access.log',
        errorLogFile: 'logs/error.log'
      });
    } catch (error) {
      console.error('Error getting access logs:', error);
      res.status(500).json({ error: 'Failed to get access logs' });
    }
  }
)

// Get IP analysis and potential security threats
app.get('/api/admin/ip-analysis', 
  authenticateToken,
  requireAdmin,
  smartApiLimiter,
  [
    query('ip').optional().isIP().withMessage('Invalid IP address format')
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const clientIP = getRealClientIP(req);
      const targetIP = req.query.ip || clientIP;
      
      // Basic IP analysis (can be enhanced with threat intelligence APIs)
      const analysis = {
        ip: targetIP,
        isLocal: isLocalIP(targetIP),
        timestamp: formatSecureTimestamp(),
        analysis: {
          type: isLocalIP(targetIP) ? 'local/private' : 'public',
          suspicious: false, // Would be determined by threat intelligence
          reputation: 'unknown', // Would come from threat intelligence APIs
          geolocation: 'Available in log files',
          rateLimitStatus: 'Active',
          recentActivity: 'Check log files for detailed activity'
        },
        recommendations: [
          'Monitor access patterns in log files',
          'Check for unusual request patterns',
          'Review geographic location consistency',
          'Verify user agent consistency'
        ]
      };
      
      res.json({
        success: true,
        ipAnalysis: analysis
      });
    } catch (error) {
      console.error('Error analyzing IP:', error);
      res.status(500).json({ error: 'Failed to analyze IP' });
    }
  }
)

// Get current active sessions and IPs
app.get('/api/admin/active-sessions', 
  authenticateToken,
  requireAdmin,
  smartApiLimiter,
  async (req, res) => {
    try {
      // This would typically track active sessions in a session store
      // For now, provide information about current request
      const currentIP = getRealClientIP(req);
      
      res.json({
        success: true,
        activeSessions: {
          current: {
            ip: currentIP,
            user: req.user,
            timestamp: formatSecureTimestamp(),
            userAgent: req.get('User-Agent')
          },
          note: 'Full session tracking would require session store implementation'
        },
        recommendations: [
          'Implement Redis session store for production',
          'Track session duration and activity',
          'Monitor concurrent sessions per user',
          'Implement session invalidation on suspicious activity'
        ]
      });
    } catch (error) {
      console.error('Error getting active sessions:', error);
      res.status(500).json({ error: 'Failed to get active sessions' });
    }
  }
)

// Security monitoring dashboard data
app.get('/api/admin/security-dashboard', 
  authenticateToken,
  requireAdmin,
  smartApiLimiter,
  async (req, res) => {
    try {
      const currentIP = getRealClientIP(req);
      const uptime = process.uptime();
      
      res.json({
        success: true,
        dashboard: {
          system: {
            uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
            nodeEnv: process.env.NODE_ENV,
            trustProxy: app.get('trust proxy') !== false,
            currentTime: formatSecureTimestamp()
          },
          security: {
            rateLimiting: 'Active',
            corsProtection: 'Active',
            csrfProtection: 'Active',
            helmetSecurity: 'Active',
            httpsRedirection: process.env.NODE_ENV === 'production' ? 'Active' : 'Disabled (dev)',
            ipDetection: 'Enhanced (multiple sources)'
          },
          monitoring: {
            accessLogging: 'Active (file-based with rotation)',
            errorLogging: 'Active',
            geoLocation: 'Active',
            botDetection: 'Active',
            suspiciousActivityDetection: 'Basic'
          },
          currentRequest: {
            yourIP: currentIP,
            authenticated: true,
            role: req.user.role,
            timestamp: formatSecureTimestamp()
          }
        },
        logFiles: {
          accessLog: 'logs/access.log (rotated daily)',
          errorLog: 'logs/error.log (rotated daily)',
          retention: '30 days',
          compression: 'gzip for old files'
        }
      });
    } catch (error) {
      console.error('Error getting security dashboard:', error);
      res.status(500).json({ error: 'Failed to get security dashboard' });
    }
  }
)

// API Configuration Diagnostic Endpoint (helps debug subpath issues)
app.get('/api/debug/config', checkAuth, (req, res) => {
  const currentIP = getRealClientIP(req)
  
  res.json({
    success: true,
    serverConfig: {
      subpath: SUBPATH,
      isDevelopment: isDevelopment,
      nodeEnv: process.env.NODE_ENV,
      publicDomain: process.env.PUBLIC_DOMAIN,
      trustProxy: app.get('trust proxy') !== false,
      behindProxy: process.env.BEHIND_PROXY === 'true'
    },
    requestInfo: {
      method: req.method,
      url: req.url,
      originalUrl: req.originalUrl,
      path: req.path,
      baseUrl: req.baseUrl,
      protocol: req.protocol,
      secure: req.secure,
      clientIP: currentIP,
      userAgent: req.get('User-Agent')
    },
    proxyHeaders: {
      host: req.get('Host'),
      xForwardedHost: req.get('X-Forwarded-Host'),
      xForwardedProto: req.get('X-Forwarded-Proto'),
      xForwardedFor: req.get('X-Forwarded-For'),
      xRealIP: req.get('X-Real-IP'),
      cfConnectingIP: req.get('CF-Connecting-IP')
    },
    apiRouting: {
      subpathAPI: `${SUBPATH}/api`,
      directAPI: '/api',
      recommendedFrontendAPIBase: req.get('Host') ? 
        `${req.protocol}://${req.get('Host')}${SUBPATH}/api` : 
        `${req.protocol}://${req.get('X-Forwarded-Host') || 'localhost'}${SUBPATH}/api`
    },
    user: req.user || null,
    timestamp: formatSecureTimestamp()
  })
})

// Add the debug endpoint to subpath as well for compatibility
if (SUBPATH !== '/' && !isDevelopment) {
  app.get(`${SUBPATH}/api/debug/config`, checkAuth, (req, res) => {
    // Redirect to the main debug endpoint to avoid duplication
    res.redirect('/api/debug/config')
  })
}

// Helper function to check if IP is local/private (moved here for access by admin endpoints)
function isLocalIP(ip) {
  if (!ip || ip === 'unknown') return false;
  
  const localPatterns = [
    /^127\./,           // 127.x.x.x (localhost)
    /^192\.168\./,      // 192.168.x.x (private)
    /^10\./,            // 10.x.x.x (private)
    /^172\.(1[6-9]|2\d|3[01])\./,  // 172.16.x.x - 172.31.x.x (private)
    /^::1$/,            // IPv6 localhost
    /^::ffff:127\./     // IPv4-mapped IPv6 localhost
  ];
  
  return localPatterns.some(pattern => pattern.test(ip));
}

// Serve the application with subpath support
if (isDevelopment) {
  // In development, just serve a redirect or simple message
  app.get(SUBPATH, (req, res) => {
    res.send(`
      <html>
        <head><title>Tennis Ranking - Development</title></head>
        <body>
          <h2>Tennis Ranking System</h2>
          <p>Development mode: Please use <a href="http://localhost:5173${SUBPATH}">http://localhost:5173${SUBPATH}</a></p>
        </body>
      </html>
    `)
  })
} else {
  // In production, serve the built application
  app.get(SUBPATH, (req, res) => {
    res.sendFile(join(__dirname, 'dist', 'index.html'))
  })
  
  // Catch all routes within the subpath
  app.get(`${SUBPATH}/*`, (req, res) => {
    res.sendFile(join(__dirname, 'dist', 'index.html'))
  })
}

// Redirect root to subpath (optional)
app.get('/', (req, res) => {
  res.redirect(SUBPATH)
})

// Helper function to check database connectivity
async function checkDatabaseHealth() {
  try {
    const startTime = Date.now()
    // Simple query to test database connectivity
    await db.pool.query('SELECT 1')
    return {
      status: 'healthy',
      responseTimeMs: Date.now() - startTime
    }
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message
    }
  }
}

// Health check endpoint for monitoring (unauthenticated for load balancers)
app.get('/health', async (req, res) => {
  const dbHealth = await checkDatabaseHealth()
  const cacheStats = rankingsCache.getStats()
  const memoryUsage = process.memoryUsage()
  
  const isHealthy = dbHealth.status === 'healthy'
  
  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    domain: process.env.PUBLIC_DOMAIN || 'localhost',
    basePath: process.env.BASE_PATH || '/',
    uptime: process.uptime(),
    checks: {
      database: dbHealth,
      cache: {
        status: 'healthy',
        entries: cacheStats.currentEntries,
        hitRate: cacheStats.hitRate
      },
      memory: {
        heapUsedMB: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(memoryUsage.heapTotal / 1024 / 1024),
        rssMB: Math.round(memoryUsage.rss / 1024 / 1024)
      }
    }
  })
})

// API Health endpoint with proxy information (requires auth - contains sensitive info)
app.get('/api/health', authenticateToken, async (req, res) => {
  const dbHealth = await checkDatabaseHealth()
  const cacheStats = rankingsCache.getStats()
  
  const proxyInfo = {
    status: dbHealth.status === 'healthy' ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    proxyTrust: app.get('trust proxy') !== false,
    clientIP: req.ip,
    forwardedFor: req.get('X-Forwarded-For'),
    realIP: req.get('X-Real-IP'),
    forwardedProto: req.get('X-Forwarded-Proto'),
    forwardedHost: req.get('X-Forwarded-Host'),
    environment: process.env.NODE_ENV || 'development',
    behindProxy: process.env.BEHIND_PROXY === 'true',
    uptime: process.uptime(),
    checks: {
      database: dbHealth,
      cache: {
        entries: cacheStats.currentEntries,
        hitRate: cacheStats.hitRate,
        hits: cacheStats.hits,
        misses: cacheStats.misses
      }
    }
  }
  
  // Log proxy information for debugging
  if (process.env.NODE_ENV === 'development') {
    console.log('🔍 Health check - Proxy Info:', {
      clientIP: proxyInfo.clientIP,
      forwardedFor: proxyInfo.forwardedFor,
      realIP: proxyInfo.realIP,
      trustProxy: proxyInfo.proxyTrust
    })
  }
  
  res.status(dbHealth.status === 'healthy' ? 200 : 503).json(proxyInfo)
})

// Fallback for any other routes (in production)
if (!isDevelopment) {
  app.get('*', (req, res) => {
    res.status(404).json({ error: 'Not found' })
  })
}

app.listen(PORT, () => {
  console.log(`🎾 Tennis Ranking System Server running on http://localhost:${PORT}`)
  console.log(`�️ Using PostgreSQL database for data storage`)
})
