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

// Load environment variables
dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3001

// Initialize CSRF protection
const tokens = new csrf()

// Enhanced in-memory cache for rankings with better hit rates
class RankingsCache {
  constructor() {
    this.cache = new Map()
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0,
      preloads: 0
    }
  }

  set(key, data) {
    this.cache.set(key, { 
      data, 
      createdAt: Date.now(),
      accessCount: 0,
      lastAccessed: Date.now()
    })
    this.stats.sets++
    
    // Log cache activity in development
    if (process.env.NODE_ENV === 'development') {
      console.log(`📦 Cache SET: ${key}`)
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
    
    // Update access stats
    item.accessCount++
    item.lastAccessed = Date.now()
    this.stats.hits++
    
    if (process.env.NODE_ENV === 'development') {
      console.log(`🎯 Cache HIT: ${key} (accessed ${item.accessCount} times)`)
    }
    
    return item.data
  }

  // Preload commonly accessed data
  async preloadCommonData(db) {
    try {
      // Preload lifetime rankings (most common request)
      if (!this.cache.has('rankings:lifetime')) {
        const rankings = await db.getPlayerStatsLifetime()
        const enhancedRankings = await Promise.all(rankings.map(async (player) => {
          const form = await db.getPlayerForm(player.id, 5)
          return { ...player, form }
        }))
        this.set('rankings:lifetime', enhancedRankings)
        this.stats.preloads++
        
        if (process.env.NODE_ENV === 'development') {
          console.log('🚀 Cache PRELOAD: rankings:lifetime')
        }
      }

      // Preload active season rankings
      const activeSeason = await db.getActiveSeason()
      if (activeSeason && !this.cache.has(`rankings:season:${activeSeason.id}`)) {
        const seasonRankings = await db.getPlayerStatsBySeason(activeSeason.id)
        const enhancedSeasonRankings = await Promise.all(seasonRankings.map(async (player) => {
          const form = await db.getPlayerFormBySeason(player.id, activeSeason.id, 5)
          return { ...player, form }
        }))
        this.set(`rankings:season:${activeSeason.id}`, enhancedSeasonRankings)
        this.stats.preloads++
        
        if (process.env.NODE_ENV === 'development') {
          console.log(`🚀 Cache PRELOAD: rankings:season:${activeSeason.id}`)
        }
      }
    } catch (error) {
      console.log('Cache preload error (non-critical):', error.message)
    }
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
    
    return {
      ...this.stats,
      hitRate: `${hitRate}%`,
      currentEntries: this.cache.size,
      memoryUsage: JSON.stringify([...this.cache.entries()]).length
    }
  }
  
  // Reset statistics
  resetStats() {
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0
    }
  }
}

const rankingsCache = new RankingsCache()

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

// Admin credentials from environment
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'tennis2024!'
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@tennis.local'
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key'
const CSRF_SECRET = process.env.CSRF_SECRET || 'fallback-csrf-secret'

// Hash the admin password on startup
const hashedAdminPassword = await bcrypt.hash(ADMIN_PASSWORD, 10)

// Initialize database
const db = new TennisDatabase()
await db.init()

// Preload common cache data for better hit rates
setTimeout(async () => {
  console.log('🚀 Preloading cache with common data...')
  await rankingsCache.preloadCommonData(db)
  console.log('✅ Cache preload completed')
}, 2000) // Wait 2 seconds after startup

// Periodic cache stats logging (every 30 minutes)
setInterval(() => {
  const stats = rankingsCache.getStats()
  if (stats.totalOperations > 0) {
    console.log(`📊 Cache Stats: ${stats.currentEntries} entries, ${stats.hitRate} hit rate, ${stats.hits + stats.misses} total operations`)
  }
}, 30 * 60 * 1000) // 30 minutes

// Trust proxy (required for Cloudflare and other reverse proxies)
app.set('trust proxy', true)

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
      baseUri: ["'self'"],
      fontSrc: ["'self'", "https:", "data:"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      scriptSrcAttr: ["'none'"],
      upgradeInsecureRequests: []
    }
  },
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}))

// Rate limiting
const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 1000, // Limit each IP to 1000 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
})

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_API_MAX) || 100, // Limit each IP to 100 API requests per windowMs
  message: 'Too many API requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
})

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 login attempts per windowMs
  message: 'Too many login attempts from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
})

// Additional specialized rate limiters for enhanced security
const deleteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 delete operations per windowMs
  message: 'Too many delete requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
})

const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit each IP to 20 create operations per windowMs
  message: 'Too many create requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
})

const exportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // Limit each IP to 15 export operations per windowMs
  message: 'Too many export requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
})

const criticalLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 1, // Limit each IP to 1 critical operation per hour
  message: 'Critical operation limit exceeded. Please wait 1 hour before trying again.',
  standardHeaders: true,
  legacyHeaders: false,
})

const restoreLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Limit each IP to 5 restore operations per hour
  message: 'Too many restore requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
})

// Apply rate limiting conditionally based on environment
if (process.env.NODE_ENV !== 'development') {
  app.use(generalLimiter)
  app.use('/api', apiLimiter)
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
    console.log('CORS Origin:', origin) // Debug logging
    
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true)
    
    // Get allowed origins from environment or use defaults
    const allowedOrigins = process.env.ALLOWED_ORIGINS ? 
      process.env.ALLOWED_ORIGINS.split(',') : 
      [
        'http://localhost:3001',
        'http://127.0.0.1:3001',
        'https://tennis.quocanh.shop'
      ]
    
    // Allow local network IPs (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
    const localNetworkRegex = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):\d+$/
    
    if (allowedOrigins.includes(origin) || localNetworkRegex.test(origin)) {
      console.log('CORS: Origin allowed:', origin)
      callback(null, true)
    } else {
      console.log('CORS: Origin blocked:', origin)
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
app.use(express.static('dist', {
  setHeaders: (res, path) => {
    // Security headers for static files
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('X-XSS-Protection', '1; mode=block')
  }
}))

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
        // Clear invalid encrypted cookie
        res.clearCookie('authToken', {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax'
        })
        req.isAuthenticated = false
        req.csrfSecret = deriveCSRFSecret(generateSessionId())
        return next()
      }
    }
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (!err) {
        req.user = user
        req.isAuthenticated = true
      } else if (req.cookies.authToken) {
        // Clear invalid cookie
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
    res.cookie('csrfSessionId', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    })
  }
  
  // Derive CSRF secret from session ID (no cleartext storage)
  req.csrfSecret = deriveCSRFSecret(sessionId)
  next()
}

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
      if (username === ADMIN_USERNAME) {
        const isValidPassword = await bcrypt.compare(password, hashedAdminPassword)
        
        if (isValidPassword) {
          const user = {
            username: ADMIN_USERNAME,
            email: ADMIN_EMAIL,
            role: 'admin'
          }
          
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
  
  res.json({ success: true, message: 'Logged out successfully' })
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
    res.json(players)
  } catch (error) {
    console.error('Error getting players:', error)
    res.status(500).json({ error: 'Failed to get players' })
  }
})

app.post('/api/players', 
  authenticateToken,
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
  conditionalRateLimit(deleteLimiter),
  [
    param('id').isInt().withMessage('Invalid player ID')
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const playerId = parseInt(req.params.id)
      await db.removePlayer(playerId)
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
    res.json(seasons)
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
      res.json({ success: true, id: seasonId, name, startDate })
    } catch (error) {
      console.error('Error creating season:', error)
      res.status(500).json({ error: 'Failed to create season' })
    }
  }
)

app.put('/api/seasons/:id', 
  authenticateToken,
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
      res.json({ success: true, message: 'Season updated successfully' })
    } catch (error) {
      console.error('Error updating season:', error)
      res.status(500).json({ error: 'Failed to update season' })
    }
  }
)

app.post('/api/seasons/:id/end', 
  authenticateToken,
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
      res.json({ success: true, message: 'Season ended successfully' })
    } catch (error) {
      console.error('Error ending season:', error)
      res.status(500).json({ error: 'Failed to end season' })
    }
  }
)

app.delete('/api/seasons/:id', 
  authenticateToken,
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
    res.json(matches)
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
      
      // Invalidate rankings cache after adding match
      rankingsCache.invalidate('rankings')
      
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
      
      // Invalidate rankings cache after updating match
      rankingsCache.invalidate('rankings')
      
      // Preload common data for better hit rates
      setTimeout(() => rankingsCache.preloadCommonData(db), 100)
      
      res.json({ success: true, message: 'Match updated successfully' })
    } catch (error) {
      console.error('Error updating match:', error)
      res.status(500).json({ error: 'Failed to update match' })
    }
  }
)

// Delete a match (admin only)
app.delete('/api/matches/:id', 
  authenticateToken,
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
      
      // Invalidate rankings cache after deleting match
      rankingsCache.invalidate('rankings')
      
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
      
      rankingsCache.set(cacheKey, rankings)
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
      
      rankingsCache.set(cacheKey, rankings)
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
      
      rankingsCache.set(cacheKey, rankings)
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
  conditionalRateLimit(criticalLimiter),
  async (req, res) => {
    try {
      console.log(`⚠️ CLEAR ALL DATA requested by user: ${req.user.username}`)
      
      // Clear all data from database
      await db.clearAllData()
      
      console.log('✅ All data cleared successfully')
      res.json({ 
        success: true, 
        message: 'All data cleared successfully',
        timestamp: new Date().toISOString()
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
        timestamp: new Date().toISOString(),
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
      
      res.json({
        success: true,
        message: 'Data restored successfully',
        results,
        timestamp: new Date().toISOString()
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
    timestamp: new Date().toISOString(),
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
    timestamp: new Date().toISOString(),
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

// Serve the application
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`🎾 Tennis Ranking System Server running on http://localhost:${PORT}`)
  console.log(`�️ Using PostgreSQL database for data storage`)
})
