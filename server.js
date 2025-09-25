import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { body, param, validationResult } from 'express-validator'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import cookieParser from 'cookie-parser'
import dotenv from 'dotenv'
import TennisDatabase from './database-postgresql.js'
import ExcelJS from 'exceljs'
import csrf from 'csrf'
import crypto from 'crypto'
import { getRealClientIP, logAccess, logError, getLogStats } from './access-logger.js'

// Load environment variables
dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3001

// Initialize CSRF protection
const tokens = new csrf()

// Enhanced in-memory cache for rankings with better hit rates and TTL
class RankingsCache {
  constructor() {
    this.cache = new Map()
    this.defaultTTL = 5 * 60 * 1000 // 5 minutes default TTL
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0,
      preloads: 0,
      expired: 0
    }
  }

  set(key, data, ttl = this.defaultTTL) {
    const expiresAt = Date.now() + ttl
    this.cache.set(key, { 
      data, 
      createdAt: Date.now(),
      expiresAt,
      accessCount: 0,
      lastAccessed: Date.now()
    })
    this.stats.sets++
    
    // Log cache activity in development
    if (process.env.NODE_ENV === 'development') {
      console.log(`📦 Cache SET: ${key} (TTL: ${ttl}ms)`)
    }
  }

  get(key) {
    const item = this.cache.get(key)
    if (!item) {
      this.stats.misses++
      // Log misses to understand patterns
      if (process.env.NODE_ENV === 'development') {
        console.log(`❌ Cache MISS: ${key}`)
      }
      return null
    }
    
    // Check if item has expired
    if (Date.now() > item.expiresAt) {
      this.cache.delete(key)
      this.stats.expired++
      this.stats.misses++
      
      if (process.env.NODE_ENV === 'development') {
        console.log(`⏰ Cache EXPIRED: ${key}`)
      }
      return null
    }
    
    // Update access stats
    item.accessCount++
    item.lastAccessed = Date.now()
    this.stats.hits++
    
    if (process.env.NODE_ENV === 'development') {
      const timeLeft = Math.round((item.expiresAt - Date.now()) / 1000)
      console.log(`🎯 Cache HIT: ${key} (accessed ${item.accessCount} times, expires in ${timeLeft}s)`)
    }
    
    return item.data
  }

  // Preload commonly accessed data
  async preloadCommonData(db) {
    try {
      // Preload lifetime rankings (most common request) with longer TTL
      if (!this.cache.has('rankings:lifetime') || this.isExpired('rankings:lifetime')) {
        const rankings = await db.getPlayerStatsLifetime()
        const enhancedRankings = await Promise.all(rankings.map(async (player) => {
          const form = await db.getPlayerForm(player.id, 5)
          return { ...player, form }
        }))
        this.set('rankings:lifetime', enhancedRankings, 10 * 60 * 1000) // 10 minutes for lifetime data
        this.stats.preloads++
        
        if (process.env.NODE_ENV === 'development') {
          console.log('🚀 Cache PRELOAD: rankings:lifetime (10min TTL)')
        }
      }

      // Preload active season rankings
      const activeSeason = await db.getActiveSeason()
      if (activeSeason && (!this.cache.has(`rankings:season:${activeSeason.id}`) || this.isExpired(`rankings:season:${activeSeason.id}`))) {
        const seasonRankings = await db.getPlayerStatsBySeason(activeSeason.id)
        const enhancedSeasonRankings = await Promise.all(seasonRankings.map(async (player) => {
          const form = await db.getPlayerFormBySeason(player.id, activeSeason.id, 5)
          return { ...player, form }
        }))
        this.set(`rankings:season:${activeSeason.id}`, enhancedSeasonRankings, 3 * 60 * 1000) // 3 minutes for season data
        this.stats.preloads++
        
        if (process.env.NODE_ENV === 'development') {
          console.log(`🚀 Cache PRELOAD: rankings:season:${activeSeason.id} (3min TTL)`)
        }
      }
    } catch (error) {
      console.log('Cache preload error (non-critical):', error.message)
    }
  }

  // Check if a cache entry has expired
  isExpired(key) {
    const item = this.cache.get(key)
    if (!item) return true
    return Date.now() > item.expiresAt
  }

  // Clean up expired entries manually
  cleanupExpired() {
    let cleanedCount = 0
    for (const [key, item] of this.cache.entries()) {
      if (Date.now() > item.expiresAt) {
        this.cache.delete(key)
        cleanedCount++
      }
    }
    
    if (cleanedCount > 0) {
      this.stats.expired += cleanedCount
      if (process.env.NODE_ENV === 'development') {
        console.log(`🧹 Cache CLEANUP: ${cleanedCount} expired entries removed`)
      }
    }
    
    return cleanedCount
  }

  invalidate(pattern = null) {
    let invalidated = 0
    
    if (pattern) {
      // Invalidate keys matching pattern
      for (const key of this.cache.keys()) {
        if (key.includes(pattern)) {
          this.cache.delete(key)
          invalidated++
        }
      }
    } else {
      // Clear all cache
      invalidated = this.cache.size
      this.cache.clear()
    }
    
    this.stats.invalidations += invalidated
    
    if (process.env.NODE_ENV === 'development') {
      console.log(`🗑️ Cache INVALIDATE: ${invalidated} entries (pattern: ${pattern || 'all'})`)
    }
  }

  clear() {
    const size = this.cache.size
    this.cache.clear()
    this.stats.invalidations += size
    
    if (process.env.NODE_ENV === 'development') {
      console.log(`🧹 Cache CLEAR: ${size} entries removed`)
    }
  }

  // Get cache statistics
  getStats() {
    const hitRate = this.stats.hits + this.stats.misses > 0 
      ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2)
      : 0
    
    // Count expired entries
    let expiredCount = 0
    for (const [key, item] of this.cache.entries()) {
      if (Date.now() > item.expiresAt) {
        expiredCount++
      }
    }
    
    return {
      ...this.stats,
      hitRate: `${hitRate}%`,
      currentEntries: this.cache.size,
      expiredEntries: expiredCount,
      memoryUsage: JSON.stringify([...this.cache.entries()]).length
    }
  }
  
  // Reset statistics
  resetStats() {
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0,
      preloads: 0,
      expired: 0
    }
  }
}

const rankingsCache = new RankingsCache()

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
    
    const sanitized = { ...data }
    
    // Convert Unix timestamps to ISO strings
    if (sanitized.created_at && typeof sanitized.created_at === 'number') {
      sanitized.created_at = new Date(sanitized.created_at * 1000).toISOString()
    }
    if (sanitized.updated_at && typeof sanitized.updated_at === 'number') {
      sanitized.updated_at = new Date(sanitized.updated_at * 1000).toISOString()
    }
    if (sanitized.timestamp && typeof sanitized.timestamp === 'number') {
      sanitized.timestamp = new Date(sanitized.timestamp * 1000).toISOString()
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

// JWT token encryption/decryption for secure cookie storage
function encryptJWT(token) {
  const algorithm = 'aes-256-cbc'
  const key = crypto.scryptSync(JWT_SECRET, 'jwt-salt', 32)
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv(algorithm, key, iv)
  
  let encrypted = cipher.update(token, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  
  // Combine iv + encrypted data
  return iv.toString('hex') + ':' + encrypted
}

function decryptJWT(encryptedToken) {
  try {
    const algorithm = 'aes-256-cbc'
    const key = crypto.scryptSync(JWT_SECRET, 'jwt-salt', 32)
    const parts = encryptedToken.split(':')
    
    if (parts.length !== 2) {
      throw new Error('Invalid encrypted token format')
    }
    
    const iv = Buffer.from(parts[0], 'hex')
    const encrypted = parts[1]
    
    const decipher = crypto.createDecipheriv(algorithm, key, iv)
    
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

// Hash the passwords on startup
const hashedAdminPassword = await bcrypt.hash(ADMIN_PASSWORD, 10)
const hashedEditorPassword = await bcrypt.hash(EDITOR_PASSWORD, 10)

// Initialize database
const db = new TennisDatabase()
await db.init()

// Preload common cache data for better hit rates
setTimeout(async () => {
  console.log('🚀 Preloading cache with common data...')
  await rankingsCache.preloadCommonData(db)
  console.log('✅ Cache preload completed')
}, 2000) // Wait 2 seconds after startup

// Periodic cache stats logging and cleanup (every 15 minutes)
setInterval(() => {
  // Clean up expired entries
  const cleanedCount = rankingsCache.cleanupExpired()
  
  // Log stats
  const stats = rankingsCache.getStats()
  if (stats.hits + stats.misses > 0) {
    console.log(`📊 Cache Stats: ${stats.currentEntries} entries (${stats.expiredEntries} expired), ${stats.hitRate} hit rate, ${stats.hits + stats.misses} total operations, ${cleanedCount} cleaned`)
  }
}, 15 * 60 * 1000) // 15 minutes

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
      styleSrc: ["'self'"], // No inline styles needed anymore
  scriptSrc: ["'self'", "https://static.cloudflareinsights.com"],
      imgSrc: ["'self'", "data:"], // Remove wildcard https:
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
      baseUri: ["'self'"],
      fontSrc: ["'self'", "data:"], // Remove wildcard https:
      formAction: ["'self'"],
      frameAncestors: ["'none'"], // Changed from 'self' to 'none' for better security
      scriptSrcAttr: ["'none'"],
      upgradeInsecureRequests: [],
      workerSrc: ["'none'"],
      manifestSrc: ["'self'"],
      childSrc: ["'none'"]
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
const createProxyAwareRateLimiter = (options) => {
  // Check if rate limiting is disabled
  if (process.env.DISABLE_RATE_LIMITING === 'true') {
    console.log('🚫 Rate limiting is disabled via environment variable');
    return (req, res, next) => next();
  }

  return rateLimit({
    ...options,
    standardHeaders: 'draft-8', // Use the latest IETF draft standard
    legacyHeaders: false,
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
console.log(`   Disabled: ${process.env.DISABLE_RATE_LIMITING === 'true'}`);

const generalLimiter = createProxyAwareRateLimiter({
  windowMs: rateLimitWindowMs,
  limit: rateLimitMaxRequests,
  message: { error: 'Too many requests from this IP, please try again later.' }
});

const apiLimiter = createProxyAwareRateLimiter({
  windowMs: rateLimitWindowMs, // Use same window as general limiter
  limit: rateLimitApiMax,
  message: { error: 'Too many API requests from this IP, please try again later.' }
});

const authLimiter = createProxyAwareRateLimiter({
  windowMs: rateLimitWindowMs, // Use same window as general limiter
  limit: 5, // Keep strict limit for auth attempts
  message: { error: 'Too many login attempts from this IP, please try again later.' }
});

// Additional specialized rate limiters for enhanced security
const deleteLimiter = createProxyAwareRateLimiter({
  windowMs: rateLimitWindowMs, // Use same window as general limiter
  limit: 50, // More lenient for delete operations
  message: { error: 'Too many delete requests from this IP, please try again later.' }
});

const createLimiter = createProxyAwareRateLimiter({
  windowMs: rateLimitWindowMs, // Use same window as general limiter
  limit: 200, // More lenient for create operations
  message: { error: 'Too many create requests from this IP, please try again later.' }
});

const exportLimiter = createProxyAwareRateLimiter({
  windowMs: rateLimitWindowMs, // Use same window as general limiter
  limit: 150, // More lenient for export operations
  message: { error: 'Too many export requests from this IP, please try again later.' }
});

const criticalLimiter = createProxyAwareRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour for critical operations
  limit: 10, // More lenient for critical operations
  message: { error: 'Critical operation limit exceeded. Please wait 1 hour before trying again.' }
});

const restoreLimiter = createProxyAwareRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour for restore operations
  limit: 50, // More lenient for restore operations
  message: { error: 'Too many restore requests from this IP, please try again later.' }
});

// User-aware rate limiting (different limits for authenticated users)
const createUserAwareRateLimiter = (anonymousLimit, authenticatedLimit, windowMs = 15 * 60 * 1000) => {
  return createProxyAwareRateLimiter({
    windowMs: windowMs,
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
    keyGenerator: (req) => {
      const baseIP = getRealClientIP(req);
      // Add user context to the key for authenticated users
      if (req.user) {
        return `${baseIP}:${req.user.username}`;
      }
      return baseIP;
    },
    message: (req) => {
      const isAuth = !!req.user;
      return { 
        error: `Too many requests from this ${isAuth ? 'account' : 'IP'}. ${isAuth ? 'Authenticated users' : 'Anonymous users'} are limited. Please try again later.`
      };
    }
  });
};

// Apply user-aware rate limiting to API endpoints
const smartApiLimiter = createUserAwareRateLimiter(50, 200); // Anonymous: 50/15min, Auth: 200/15min

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
  limit: '10mb',
  verify: (req, res, buf) => {
    try {
      JSON.parse(buf)
    } catch (e) {
      res.status(400).json({ error: 'Invalid JSON' })
      return
    }
  }
}))

// Subpath configuration - support both SUBPATH and BASE_PATH env vars
// Use root path for development, tennis subpath for production by default
const SUBPATH = process.env.SUBPATH || process.env.BASE_PATH || (process.env.NODE_ENV === 'production' ? '/tennis' : '/')
const isDevelopment = process.env.NODE_ENV === 'development'

console.log('🎯 Server subpath configuration:', SUBPATH)
console.log('🔧 Environment:', process.env.NODE_ENV)

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
      res.setHeader('X-XSS-Protection', '1; mode=block')
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

// Global CSRF protection middleware (after body parsing)
const globalCSRFProtection = (req, res, next) => {
  // Skip CSRF for GET requests (read-only operations)
  if (req.method === 'GET') {
    return next()
  }
  
  // Skip CSRF for login endpoint (needs to issue CSRF token)
  if (req.path === '/api/auth/login') {
    return next()
  }
  
  // Skip CSRF for public CSRF token endpoint
  if (req.path === '/api/csrf-token') {
    return next()
  }
  
  // Skip CSRF for non-authenticated users on logout
  if (req.path === '/api/auth/logout' && !req.cookies.authToken) {
    return next()
  }
  
  // Apply CSRF validation for all other state-changing operations
  const token = req.get('X-CSRF-Token') || req.body._csrf
  
  // Get or create session ID for CSRF secret derivation
  let sessionId = req.cookies.csrfSessionId
  if (!sessionId) {
    sessionId = generateSessionId()
    res.cookie('csrfSessionId', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    })
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
      // Clear invalid encrypted cookie
      res.clearCookie('authToken', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax'
      })
      return res.status(401).json({ error: 'Invalid encrypted token' })
    }
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      // Clear invalid cookie
      if (req.cookies.authToken) {
        res.clearCookie('authToken', {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax'
        })
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
          res.clearCookie('authToken', {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax'
          })
        }
        req.isAuthenticated = false
        req.csrfSecret = deriveCSRFSecret(generateSessionId())
        return next()
      }
    }
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (!err) {
        req.user = user
        req.isAuthenticated = true
      } else if (req.cookies.authToken && !res.headersSent) {
        // Clear invalid cookie only if headers not sent
        res.clearCookie('authToken', {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax'
        })
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
      res.cookie('csrfSessionId', sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
      })
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

// Generate JWT token
const generateToken = (user) => {
  return jwt.sign(
    { 
      username: user.username, 
      email: user.email,
      role: user.role || 'admin'
    }, 
    JWT_SECRET, 
    { expiresIn: '24h' }
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

      // Check if credentials match admin account
      let user = null
      if (username === ADMIN_USERNAME) {
        const isValidPassword = await bcrypt.compare(password, hashedAdminPassword)
        
        if (isValidPassword) {
          user = {
            username: ADMIN_USERNAME,
            email: ADMIN_EMAIL,
            role: 'admin'
          }
        }
      } else if (username === EDITOR_USERNAME) {
        const isValidPassword = await bcrypt.compare(password, hashedEditorPassword)
        
        if (isValidPassword) {
          user = {
            username: EDITOR_USERNAME,
            email: EDITOR_EMAIL,
            role: 'editor'
          }
        }
      }
      
      if (user) {
          const token = generateToken(user)
          
          // Encrypt JWT token before storing in httpOnly cookie (addresses CodeQL alert)
          const encryptedToken = encryptJWT(token)
          res.cookie('authToken', encryptedToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
            maxAge: 24 * 60 * 60 * 1000 // 24 hours
          })
          
          // Generate new session ID for CSRF protection
          const sessionId = generateSessionId()
          const csrfSecret = deriveCSRFSecret(sessionId)
          const csrfToken = tokens.create(csrfSecret)
          
          // Set session ID in httpOnly cookie (not the secret itself)
          res.cookie('csrfSessionId', sessionId, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
            maxAge: 24 * 60 * 60 * 1000 // 24 hours
          })
          
          // Detect client type - API clients should include 'Accept: application/json' header
          // and no 'Accept: text/html' (which browsers send)
          const isAPIClient = !req.headers.accept?.includes('text/html') && 
                             req.headers.accept?.includes('application/json')
          
          const response = {
            success: true,
            message: 'Login successful',
            csrfToken: csrfToken, // Always send CSRF token for form protection
            user: {
              username: user.username,
              email: user.email,
              role: user.role
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
    res.clearCookie('authToken', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax'
    })
    
    res.clearCookie('csrfSessionId', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax'
    })
    
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

// Database API Routes

// Players Routes
app.get('/api/players', checkAuth, async (req, res) => {
  try {
    const players = await db.getPlayers()
    res.json(sanitizeResponse(players))
  } catch (error) {
    console.error('Error getting players:', error)
    res.status(500).json({ error: 'Failed to get players' })
  }
})

app.post('/api/players', 
  authenticateToken,
  requireAdmin,
  requireAdmin,
  conditionalRateLimit(createLimiter),
  [
    body('name')
      .isLength({ min: 1, max: 100 })
      .withMessage('Player name is required')
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { name } = req.body
      const playerId = await db.addPlayer(name)
      
      // Invalidate all cache when players change
      rankingsCache.clear()
      
      // Preload common data for better hit rates
      setTimeout(() => rankingsCache.preloadCommonData(db), 100)
      
      res.json({ success: true, id: playerId, name })
    } catch (error) {
      if (error.message.includes('UNIQUE constraint failed')) {
        res.status(400).json({ error: 'Player name already exists' })
      } else {
        console.error('Error adding player:', error)
        res.status(500).json({ error: 'Failed to add player' })
      }
    }
  }
)

app.delete('/api/players/:id', 
  authenticateToken,
  requireAdmin,
  conditionalRateLimit(deleteLimiter),
  [
    param('id').isInt().withMessage('Invalid player ID')
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const playerId = parseInt(req.params.id)
      await db.removePlayer(playerId)
      
      // Invalidate all cache when players are removed
      rankingsCache.clear()
      
      // Preload common data for better hit rates
      setTimeout(() => rankingsCache.preloadCommonData(db), 100)
      
      res.json({ success: true, message: 'Player removed successfully' })
    } catch (error) {
      console.error('Error removing player:', error)
      res.status(500).json({ error: 'Failed to remove player' })
    }
  }
)

// Seasons Routes
app.get('/api/seasons', checkAuth, async (req, res) => {
  try {
    const seasons = await db.getSeasons()
    res.json(sanitizeResponse(seasons))
  } catch (error) {
    console.error('Error getting seasons:', error)
    res.status(500).json({ error: 'Failed to get seasons' })
  }
})

app.get('/api/seasons/active', checkAuth, async (req, res) => {
  try {
    const activeSeason = await db.getActiveSeason()
    res.json(activeSeason)
  } catch (error) {
    console.error('Error getting active season:', error)
    res.status(500).json({ error: 'Failed to get active season' })
  }
})

app.post('/api/seasons', 
  authenticateToken,
  requireAdmin,
  conditionalRateLimit(createLimiter),
  [
    body('name').isLength({ min: 1, max: 100 }).withMessage('Season name is required'),
    body('startDate').isISO8601().withMessage('Valid start date is required'),
    body('autoEndPrevious').optional().isBoolean().withMessage('autoEndPrevious must be boolean')
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { name, startDate, autoEndPrevious } = req.body
      
      // If autoEndPrevious is true, end the current active season
      if (autoEndPrevious) {
        const activeSeason = await db.getActiveSeason()
        if (activeSeason) {
          // Calculate end date as one day before new season starts
          const newSeasonDate = new Date(startDate)
          const endDate = new Date(newSeasonDate)
          endDate.setDate(endDate.getDate() - 1)
          const endDateString = endDate.toISOString().split('T')[0]
          
          await db.endSeason(activeSeason.id, endDateString)
        }
      }
      
      const seasonId = await db.createSeason(name, startDate)
      
      // Invalidate all cache when seasons change
      rankingsCache.clear()
      
      // Preload common data for better hit rates
      setTimeout(() => rankingsCache.preloadCommonData(db), 100)
      
      res.json({ success: true, id: seasonId, name, startDate })
    } catch (error) {
      console.error('Error creating season:', error)
      res.status(500).json({ error: 'Failed to create season' })
    }
  }
)

app.put('/api/seasons/:id', 
  authenticateToken,
  requireAdmin,
  [
    param('id').isInt().withMessage('Invalid season ID'),
    body('name').isLength({ min: 1, max: 100 }).withMessage('Season name is required'),
    body('startDate').isISO8601().withMessage('Valid start date is required'),
    body('endDate').optional().isISO8601().withMessage('Valid end date is required')
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const seasonId = parseInt(req.params.id)
      const { name, startDate, endDate } = req.body
      await db.updateSeason(seasonId, name, startDate, endDate)
      
      // Invalidate all cache when seasons are updated
      rankingsCache.clear()
      
      // Preload common data for better hit rates
      setTimeout(() => rankingsCache.preloadCommonData(db), 100)
      
      res.json({ success: true, message: 'Season updated successfully' })
    } catch (error) {
      console.error('Error updating season:', error)
      res.status(500).json({ error: 'Failed to update season' })
    }
  }
)

app.post('/api/seasons/:id/end', 
  authenticateToken,
  requireAdmin,
  [
    param('id').isInt().withMessage('Invalid season ID'),
    body('endDate').isISO8601().withMessage('Valid end date is required')
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const seasonId = parseInt(req.params.id)
      const { endDate } = req.body
      await db.endSeason(seasonId, endDate)
      
      // Invalidate all cache when seasons are ended
      rankingsCache.clear()
      
      // Preload common data for better hit rates
      setTimeout(() => rankingsCache.preloadCommonData(db), 100)
      
      res.json({ success: true, message: 'Season ended successfully' })
    } catch (error) {
      console.error('Error ending season:', error)
      res.status(500).json({ error: 'Failed to end season' })
    }
  }
)

app.delete('/api/seasons/:id', 
  authenticateToken,
  requireAdmin,
  conditionalRateLimit(deleteLimiter),
  [
    param('id').isInt().withMessage('Invalid season ID')
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const seasonId = parseInt(req.params.id)
      
      // Check if season exists and is not active
      const season = await db.getSeasonById(seasonId)
      if (!season) {
        return res.status(404).json({ error: 'Season not found' })
      }
      
      if (season.is_active) {
        return res.status(400).json({ error: 'Cannot delete active season. Please end the season first.' })
      }
      
      await db.deleteSeason(seasonId)
      
      // Invalidate all cache when seasons are deleted
      rankingsCache.clear()
      
      // Preload common data for better hit rates
      setTimeout(() => rankingsCache.preloadCommonData(db), 100)
      
      res.json({ success: true, message: 'Season deleted successfully' })
    } catch (error) {
      console.error('Error deleting season:', error)
      res.status(500).json({ error: 'Failed to delete season' })
    }
  }
)

// Matches Routes
app.get('/api/matches', checkAuth, async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit) : null
    const matches = await db.getMatches(limit)
    res.json(sanitizeResponse(matches))
  } catch (error) {
    console.error('Error getting matches:', error)
    res.status(500).json({ error: 'Failed to get matches' })
  }
})

app.get('/api/matches/by-date/:date', checkAuth, async (req, res) => {
  try {
    const { date } = req.params
    const matches = await db.getMatchesByPlayDate(date)
    res.json(matches)
  } catch (error) {
    console.error('Error getting matches by date:', error)
    res.status(500).json({ error: 'Failed to get matches by date' })
  }
})

app.get('/api/matches/by-season/:seasonId', checkAuth, async (req, res) => {
  try {
    const seasonId = parseInt(req.params.seasonId)
    const matches = await db.getMatchesBySeason(seasonId)
    res.json(matches)
  } catch (error) {
    console.error('Error getting matches by season:', error)
    res.status(500).json({ error: 'Failed to get matches by season' })
  }
})

app.post('/api/matches', 
  authenticateToken,
  requireEditor,
  conditionalRateLimit(createLimiter),
  [
    body('seasonId').isInt().withMessage('Valid season ID is required'),
    body('playDate').isISO8601().withMessage('Valid play date is required'),
    body('player1Id').isInt().withMessage('Valid player 1 ID is required'),
    body('player2Id').isInt().withMessage('Valid player 2 ID is required'),
    body('player3Id').isInt().withMessage('Valid player 3 ID is required'),
    body('player4Id').isInt().withMessage('Valid player 4 ID is required'),
    body('team1Score').isInt({ min: 0 }).withMessage('Valid team 1 score is required'),
    body('team2Score').isInt({ min: 0 }).withMessage('Valid team 2 score is required'),
    body('winningTeam').isInt({ min: 1, max: 2 }).withMessage('Winning team must be 1 or 2')
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam } = req.body
      
      // Validate that all players are different
      const playerIds = [player1Id, player2Id, player3Id, player4Id]
      const uniquePlayerIds = [...new Set(playerIds)]
      if (uniquePlayerIds.length !== 4) {
        return res.status(400).json({ error: 'All players must be different' })
      }
      
      const matchId = await db.addMatch(seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam)
      
      // Invalidate all cache after adding match
      rankingsCache.clear()
      
      // Preload common data for better hit rates
      setTimeout(() => rankingsCache.preloadCommonData(db), 100)
      
      res.json({ success: true, id: matchId })
    } catch (error) {
      console.error('Error adding match:', error)
      res.status(500).json({ error: 'Failed to add match' })
    }
  }
)

// Get a specific match by ID
app.get('/api/matches/:id', 
  checkAuth,
  [
    param('id').isInt().withMessage('Invalid match ID')
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const matchId = parseInt(req.params.id)
      const match = await db.getMatchById(matchId)
      
      if (!match) {
        return res.status(404).json({ error: 'Match not found' })
      }
      
      res.json(match)
    } catch (error) {
      console.error('Error getting match:', error)
      res.status(500).json({ error: 'Failed to get match' })
    }
  }
)

// Update a match (admin only)
app.put('/api/matches/:id', 
  authenticateToken,
  requireEditor,
  [
    param('id').isInt().withMessage('Invalid match ID'),
    body('seasonId').isInt().withMessage('Valid season ID is required'),
    body('playDate').isISO8601().withMessage('Valid play date is required'),
    body('player1Id').isInt().withMessage('Valid player 1 ID is required'),
    body('player2Id').isInt().withMessage('Valid player 2 ID is required'),
    body('player3Id').isInt().withMessage('Valid player 3 ID is required'),
    body('player4Id').isInt().withMessage('Valid player 4 ID is required'),
    body('team1Score').isInt({ min: 0 }).withMessage('Valid team 1 score is required'),
    body('team2Score').isInt({ min: 0 }).withMessage('Valid team 2 score is required'),
    body('winningTeam').isInt({ min: 1, max: 2 }).withMessage('Winning team must be 1 or 2')
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const matchId = parseInt(req.params.id)
      const { seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam } = req.body

      // Validate that all players are different
      const playerIds = [player1Id, player2Id, player3Id, player4Id]
      const uniquePlayerIds = [...new Set(playerIds)]
      if (uniquePlayerIds.length !== 4) {
        return res.status(400).json({ error: 'All players must be different' })
      }

      // Check if match exists
      const existingMatch = await db.getMatchById(matchId)
      if (!existingMatch) {
        return res.status(404).json({ error: 'Match not found' })
      }

      await db.updateMatch(matchId, seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam)
      
      // Invalidate all cache after updating match
      rankingsCache.clear()
      
      // Preload common data for better hit rates
      setTimeout(() => rankingsCache.preloadCommonData(db), 100)
      
      res.json({ success: true, message: 'Match updated successfully' })
    } catch (error) {
      console.error('Error updating match:', error)
      res.status(500).json({ error: 'Failed to update match' })
    }
  }
)

// Delete a match (admin or editor)
app.delete('/api/matches/:id', 
  authenticateToken,
  requireEditor,
  conditionalRateLimit(deleteLimiter),
  [
    param('id').isInt().withMessage('Invalid match ID')
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const matchId = parseInt(req.params.id)
      
      // Check if match exists
      const existingMatch = await db.getMatchById(matchId)
      if (!existingMatch) {
        return res.status(404).json({ error: 'Match not found' })
      }
      
      await db.deleteMatch(matchId)
      
      // Invalidate all cache after deleting match
      rankingsCache.clear()
      
      // Preload common data for better hit rates
      setTimeout(() => rankingsCache.preloadCommonData(db), 100)
      
      res.json({ success: true, message: 'Match deleted successfully' })
    } catch (error) {
      console.error('Error deleting match:', error)
      res.status(500).json({ error: 'Failed to delete match' })
    }
  }
)

// Play dates Routes
app.get('/api/play-dates', checkAuth, async (req, res) => {
  try {
    const playDates = await db.getPlayDates()
    res.json(playDates)
  } catch (error) {
    console.error('Error getting play dates:', error)
    res.status(500).json({ error: 'Failed to get play dates' })
  }
})

app.get('/api/play-dates/latest', checkAuth, async (req, res) => {
  try {
    const latestDate = await db.getLatestPlayDate()
    res.json({ playDate: latestDate })
  } catch (error) {
    console.error('Error getting latest play date:', error)
    res.status(500).json({ error: 'Failed to get latest play date' })
  }
})

// Rankings Routes
app.get('/api/rankings/lifetime', checkAuth, async (req, res) => {
  try {
    const cacheKey = 'rankings:lifetime'
    let rankings = rankingsCache.get(cacheKey)
    let cacheHit = true
    
    if (!rankings) {
      cacheHit = false
      rankings = await db.getPlayerStatsLifetime()
      
      // Add form for each player
      rankings = await Promise.all(rankings.map(async (player) => {
        const form = await db.getPlayerForm(player.id, 5)
        return { ...player, form }
      }))
      
      // Lifetime data changes less frequently, use longer TTL
      rankingsCache.set(cacheKey, rankings, 10 * 60 * 1000) // 10 minutes
    }
    
    // Add cache info to response headers
    res.set('X-Cache', cacheHit ? 'HIT' : 'MISS')
    res.set('X-Cache-Key', cacheKey)
    
    res.json(rankings)
  } catch (error) {
    console.error('Error getting lifetime rankings:', error)
    res.status(500).json({ error: 'Failed to get lifetime rankings' })
  }
})

app.get('/api/rankings/season/:seasonId', checkAuth, async (req, res) => {
  try {
    const seasonId = parseInt(req.params.seasonId)
    const cacheKey = `rankings:season:${seasonId}`
    let rankings = rankingsCache.get(cacheKey)
    let cacheHit = true
    
    if (!rankings) {
      cacheHit = false
      rankings = await db.getPlayerStatsBySeason(seasonId)
      
      // Add form for each player (last 5 matches in this season)
      rankings = await Promise.all(rankings.map(async (player) => {
        const form = await db.getPlayerFormBySeason(player.id, seasonId, 5)
        return { ...player, form }
      }))
      
      // Season data changes more frequently during active season, shorter TTL
      rankingsCache.set(cacheKey, rankings, 3 * 60 * 1000) // 3 minutes
    }
    
    // Add cache info to response headers
    res.set('X-Cache', cacheHit ? 'HIT' : 'MISS')
    res.set('X-Cache-Key', cacheKey)
    
    res.json(rankings)
  } catch (error) {
    console.error('Error getting season rankings:', error)
    res.status(500).json({ error: 'Failed to get season rankings' })
  }
})

app.get('/api/rankings/date/:date', checkAuth, async (req, res) => {
  try {
    const { date } = req.params
    const cacheKey = `rankings:date:${date}`
    let rankings = rankingsCache.get(cacheKey)
    let cacheHit = true
    
    if (!rankings) {
      cacheHit = false
      rankings = await db.getPlayerStatsBySpecificDate(date)
      
      // Add form for each player (matches on this specific date only)
      rankings = await Promise.all(rankings.map(async (player) => {
        const form = await db.getPlayerFormBySpecificDate(player.id, date, 5)
        return { ...player, form }
      }))
      
      // Date-specific data is historical and rarely changes, longer TTL
      rankingsCache.set(cacheKey, rankings, 15 * 60 * 1000) // 15 minutes
    }
    
    // Add cache info to response headers
    res.set('X-Cache', cacheHit ? 'HIT' : 'MISS')
    res.set('X-Cache-Key', cacheKey)
    
    res.json(rankings)
  } catch (error) {
    console.error('Error getting date rankings:', error)
    res.status(500).json({ error: 'Failed to get date rankings' })
  }
})

// Excel Export Route
app.get('/api/export-excel', checkAuth, conditionalRateLimit(exportLimiter), async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook()
    
    // Players sheet
    const playersSheet = workbook.addWorksheet('Người chơi')
    playersSheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Tên', key: 'name', width: 30 },
      { header: 'Ngày tạo', key: 'created_at', width: 20 }
    ]
    
    const players = await db.getPlayers()
    playersSheet.addRows(players)
    
    // Seasons sheet
    const seasonsSheet = workbook.addWorksheet('Mùa giải')
    seasonsSheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Tên mùa giải', key: 'name', width: 30 },
      { header: 'Ngày bắt đầu', key: 'start_date', width: 15 },
      { header: 'Ngày kết thúc', key: 'end_date', width: 15 },
      { header: 'Đang hoạt động', key: 'is_active', width: 15 },
      { header: 'Ngày tạo', key: 'created_at', width: 20 }
    ]
    
    const seasons = await db.getSeasons()
    seasonsSheet.addRows(seasons)
    
    // Matches sheet
    const matchesSheet = workbook.addWorksheet('Kết quả thi đấu')
    matchesSheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Mùa giải', key: 'season_name', width: 20 },
      { header: 'Ngày đánh', key: 'play_date', width: 15 },
      { header: 'Người chơi 1', key: 'player1_name', width: 20 },
      { header: 'Người chơi 2', key: 'player2_name', width: 20 },
      { header: 'Người chơi 3', key: 'player3_name', width: 20 },
      { header: 'Người chơi 4', key: 'player4_name', width: 20 },
      { header: 'Điểm đội 1', key: 'team1_score', width: 15 },
      { header: 'Điểm đội 2', key: 'team2_score', width: 15 },
      { header: 'Đội thắng', key: 'winning_team', width: 15 },
      { header: 'Ngày tạo', key: 'created_at', width: 20 }
    ]
    
    const matches = await db.getMatches()
    matchesSheet.addRows(matches)
    
    // Rankings sheet
    const rankingsSheet = workbook.addWorksheet('Bảng xếp hạng tổng')
    rankingsSheet.columns = [
      { header: 'Tên', key: 'name', width: 30 },
      { header: 'Thắng', key: 'wins', width: 10 },
      { header: 'Thua', key: 'losses', width: 10 },
      { header: 'Tổng trận', key: 'total_matches', width: 15 },
      { header: 'Điểm', key: 'points', width: 10 },
      { header: 'Tỷ lệ thắng (%)', key: 'win_percentage', width: 15 },
      { header: 'Tiền thua (VND)', key: 'money_lost', width: 20 }
    ]
    
    const rankings = await db.getPlayerStatsLifetime()
    rankingsSheet.addRows(rankings)
    
    // Generate Excel buffer
    const buffer = await workbook.xlsx.writeBuffer()
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="tennis-rankings-${new Date().toISOString().split('T')[0]}.xlsx"`)
    res.send(buffer)
  } catch (error) {
    console.error('Error exporting to Excel:', error)
    res.status(500).json({ error: 'Failed to export to Excel' })
  }
})

// Export Excel by Date
app.get('/api/export-excel/date/:date', checkAuth, conditionalRateLimit(exportLimiter), async (req, res) => {
  try {
    const { date } = req.params
    const workbook = new ExcelJS.Workbook()
    
    // Rankings sheet for specific date
    const rankingsSheet = workbook.addWorksheet(`Bảng xếp hạng - ${date}`)
    rankingsSheet.columns = [
      { header: 'Hạng', key: 'rank', width: 10 },
      { header: 'Tên', key: 'name', width: 30 },
      { header: 'Thắng', key: 'wins', width: 10 },
      { header: 'Thua', key: 'losses', width: 10 },
      { header: 'Tổng trận', key: 'total_matches', width: 15 },
      { header: 'Điểm', key: 'points', width: 10 },
      { header: 'Tỷ lệ thắng (%)', key: 'win_percentage', width: 15 },
      { header: 'Tiền thua (VND)', key: 'money_lost', width: 20 },
      { header: 'Phong độ gần đây', key: 'form_text', width: 30 }
    ]
    
    const rankings = await db.getPlayerStatsByPlayDate(date)
    const rankedData = rankings.map((player, index) => ({
      rank: index + 1,
      ...player,
      form_text: player.form ? player.form.map(f => f.result === 'win' ? 'T' : 'B').join(' ') : ''
    }))
    rankingsSheet.addRows(rankedData)
    
    // Matches for this date
    const matchesSheet = workbook.addWorksheet(`Trận đấu - ${date}`)
    matchesSheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Mùa giải', key: 'season_name', width: 20 },
      { header: 'Người chơi 1', key: 'player1_name', width: 20 },
      { header: 'Người chơi 2', key: 'player2_name', width: 20 },
      { header: 'Người chơi 3', key: 'player3_name', width: 20 },
      { header: 'Người chơi 4', key: 'player4_name', width: 20 },
      { header: 'Điểm đội 1', key: 'team1_score', width: 15 },
      { header: 'Điểm đội 2', key: 'team2_score', width: 15 },
      { header: 'Đội thắng', key: 'winning_team', width: 15 }
    ]
    
    const matches = await db.getMatchesByDate(date)
    matchesSheet.addRows(matches)
    
    // Generate Excel buffer
    const buffer = await workbook.xlsx.writeBuffer()
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="tennis-rankings-${date}.xlsx"`)
    res.send(buffer)
  } catch (error) {
    console.error('Error exporting date data to Excel:', error)
    res.status(500).json({ error: 'Failed to export date data to Excel' })
  }
})

// Export Excel by Season
app.get('/api/export-excel/season/:seasonId', checkAuth, conditionalRateLimit(exportLimiter), async (req, res) => {
  try {
    const { seasonId } = req.params
    const workbook = new ExcelJS.Workbook()
    
    // Get season info
    const season = await db.getSeasonById(seasonId)
    const seasonName = season ? season.name : `Mùa ${seasonId}`
    
    // Rankings sheet for specific season
    const rankingsSheet = workbook.addWorksheet(`Bảng xếp hạng - ${seasonName}`)
    rankingsSheet.columns = [
      { header: 'Hạng', key: 'rank', width: 10 },
      { header: 'Tên', key: 'name', width: 30 },
      { header: 'Thắng', key: 'wins', width: 10 },
      { header: 'Thua', key: 'losses', width: 10 },
      { header: 'Tổng trận', key: 'total_matches', width: 15 },
      { header: 'Điểm', key: 'points', width: 10 },
      { header: 'Tỷ lệ thắng (%)', key: 'win_percentage', width: 15 },
      { header: 'Tiền thua (VND)', key: 'money_lost', width: 20 },
      { header: 'Phong độ gần đây', key: 'form_text', width: 30 }
    ]
    
    const rankings = await db.getPlayerStatsBySeason(seasonId)
    const rankedData = rankings.map((player, index) => ({
      rank: index + 1,
      ...player,
      form_text: player.form ? player.form.map(f => f.result === 'win' ? 'T' : 'B').join(' ') : ''
    }))
    rankingsSheet.addRows(rankedData)
    
    // Matches for this season
    const matchesSheet = workbook.addWorksheet(`Trận đấu - ${seasonName}`)
    matchesSheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Ngày đánh', key: 'play_date', width: 15 },
      { header: 'Người chơi 1', key: 'player1_name', width: 20 },
      { header: 'Người chơi 2', key: 'player2_name', width: 20 },
      { header: 'Người chơi 3', key: 'player3_name', width: 20 },
      { header: 'Người chơi 4', key: 'player4_name', width: 20 },
      { header: 'Điểm đội 1', key: 'team1_score', width: 15 },
      { header: 'Điểm đội 2', key: 'team2_score', width: 15 },
      { header: 'Đội thắng', key: 'winning_team', width: 15 }
    ]
    
    const matches = await db.getMatchesBySeason(seasonId)
    matchesSheet.addRows(matches)
    
    // Generate Excel buffer
    const buffer = await workbook.xlsx.writeBuffer()
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="tennis-rankings-season-${seasonId}.xlsx"`)
    res.send(buffer)
  } catch (error) {
    console.error('Error exporting season data to Excel:', error)
    res.status(500).json({ error: 'Failed to export season data to Excel' })
  }
})

// Export Excel Lifetime
app.get('/api/export-excel/lifetime', checkAuth, conditionalRateLimit(exportLimiter), async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook()
    
    // Rankings sheet for lifetime
    const rankingsSheet = workbook.addWorksheet('Bảng xếp hạng - Toàn thời gian')
    rankingsSheet.columns = [
      { header: 'Hạng', key: 'rank', width: 10 },
      { header: 'Tên', key: 'name', width: 30 },
      { header: 'Thắng', key: 'wins', width: 10 },
      { header: 'Thua', key: 'losses', width: 10 },
      { header: 'Tổng trận', key: 'total_matches', width: 15 },
      { header: 'Điểm', key: 'points', width: 10 },
      { header: 'Tỷ lệ thắng (%)', key: 'win_percentage', width: 15 },
      { header: 'Tiền thua (VND)', key: 'money_lost', width: 20 },
      { header: 'Phong độ gần đây', key: 'form_text', width: 30 }
    ]
    
    const rankings = await db.getPlayerStatsLifetime()
    const rankedData = rankings.map((player, index) => ({
      rank: index + 1,
      ...player,
      form_text: player.form ? player.form.map(f => f.result === 'win' ? 'T' : 'B').join(' ') : ''
    }))
    rankingsSheet.addRows(rankedData)
    
    // All Players sheet
    const playersSheet = workbook.addWorksheet('Tất cả người chơi')
    playersSheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Tên', key: 'name', width: 30 },
      { header: 'Ngày tạo', key: 'created_at', width: 20 }
    ]
    
    const players = await db.getPlayers()
    playersSheet.addRows(players)
    
    // All Seasons sheet
    const seasonsSheet = workbook.addWorksheet('Tất cả mùa giải')
    seasonsSheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Tên mùa giải', key: 'name', width: 30 },
      { header: 'Ngày bắt đầu', key: 'start_date', width: 15 },
      { header: 'Ngày kết thúc', key: 'end_date', width: 15 },
      { header: 'Đang hoạt động', key: 'is_active', width: 15 },
      { header: 'Ngày tạo', key: 'created_at', width: 20 }
    ]
    
    const seasons = await db.getSeasons()
    seasonsSheet.addRows(seasons)
    
    // All Matches sheet
    const matchesSheet = workbook.addWorksheet('Tất cả trận đấu')
    matchesSheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Mùa giải', key: 'season_name', width: 20 },
      { header: 'Ngày đánh', key: 'play_date', width: 15 },
      { header: 'Người chơi 1', key: 'player1_name', width: 20 },
      { header: 'Người chơi 2', key: 'player2_name', width: 20 },
      { header: 'Người chơi 3', key: 'player3_name', width: 20 },
      { header: 'Người chơi 4', key: 'player4_name', width: 20 },
      { header: 'Điểm đội 1', key: 'team1_score', width: 15 },
      { header: 'Điểm đội 2', key: 'team2_score', width: 15 },
      { header: 'Đội thắng', key: 'winning_team', width: 15 },
      { header: 'Ngày tạo', key: 'created_at', width: 20 }
    ]
    
    const matches = await db.getMatches()
    matchesSheet.addRows(matches)
    
    // Generate Excel buffer
    const buffer = await workbook.xlsx.writeBuffer()
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="tennis-rankings-lifetime.xlsx"`)
    res.send(buffer)
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
      rankingsCache.clear()
      
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
      rankingsCache.clear()
      
      // Preload common data for better hit rates
      setTimeout(() => rankingsCache.preloadCommonData(db), 100)
      
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

// Cache Stats Route (development only)
app.get('/api/cache-stats', checkAuth, (req, res) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(404).json({ error: 'Endpoint not available in production' })
  }
  
  const stats = rankingsCache.getStats()
  res.json({
    success: true,
    cacheStats: stats,
    recommendations: {
      performance: stats.hitRate === '0.00%' ? 'Cache not used yet - normal for new system' :
                  parseFloat(stats.hitRate) < 50 ? 'Low hit rate - check invalidation logic' :
                  parseFloat(stats.hitRate) > 80 ? 'Excellent cache performance' :
                  'Good cache performance',
      memory: stats.memoryUsage > 1000000 ? 'High memory usage - consider Redis for scaling' :
              'Memory usage within normal range',
      info: 'Cache invalidates automatically on data changes and server restart'
    }
  })
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
      totalOperations: stats.hits + stats.misses
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

// Health check endpoint for monitoring (unauthenticated for load balancers)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    domain: process.env.PUBLIC_DOMAIN || 'localhost',
    basePath: process.env.BASE_PATH || '/',
    uptime: process.uptime()
  })
})

// API Health endpoint with proxy information (for testing)
app.get('/api/health', (req, res) => {
  const proxyInfo = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    proxyTrust: app.get('trust proxy') !== false,
    clientIP: req.ip,
    forwardedFor: req.get('X-Forwarded-For'),
    realIP: req.get('X-Real-IP'),
    forwardedProto: req.get('X-Forwarded-Proto'),
    forwardedHost: req.get('X-Forwarded-Host'),
    environment: process.env.NODE_ENV || 'development',
    behindProxy: process.env.BEHIND_PROXY === 'true',
    uptime: process.uptime()
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
  
  res.status(200).json(proxyInfo)
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
