import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import fs from 'fs/promises'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { body, param, validationResult } from 'express-validator'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import session from 'express-session'
import dotenv from 'dotenv'
import TennisDatabase from './database.js'
import ExcelJS from 'exceljs'

// Load environment variables
dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3001
const DATA_DIR = join(__dirname, 'data')

// Admin credentials from environment
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'tennis2024!'
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@tennis.local'
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key'
const SESSION_SECRET = process.env.SESSION_SECRET || 'fallback-session-secret'

// Hash the admin password on startup
const hashedAdminPassword = await bcrypt.hash(ADMIN_PASSWORD, 10)

// Initialize database
const db = new TennisDatabase()
await db.init()
console.log('✅ Database initialized successfully')

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
      frameSrc: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
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

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 uploads per windowMs
  message: 'Too many upload requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
})

app.use(generalLimiter)
app.use('/api', apiLimiter)

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

// Session middleware
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // Only send over HTTPS in production
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}))

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

// File name sanitization
const sanitizeFileName = (fileName) => {
  return fileName
    .replace(/[^a-zA-Z0-9\-_\.]/g, '_') // Replace invalid chars with underscore
    .replace(/\.{2,}/g, '.') // Replace multiple dots with single dot
    .replace(/^\.+|\.+$/g, '') // Remove leading/trailing dots
    .substring(0, 100) // Limit length
}

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]

  if (!token) {
    return res.status(401).json({ error: 'Access token required' })
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' })
    }
    req.user = user
    next()
  })
}

// Check if user is authenticated (for optional auth)
const checkAuth = (req, res, next) => {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]

  if (token) {
    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (!err) {
        req.user = user
        req.isAuthenticated = true
      }
    })
  }
  req.isAuthenticated = req.isAuthenticated || false
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

// Ensure data directory exists with proper permissions
try {
  await fs.access(DATA_DIR)
} catch {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o755 })
}

// API Routes

// Authentication Routes

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
          
          // Store user in session
          req.session.user = user
          
          res.json({
            success: true,
            message: 'Login successful',
            token,
            user: {
              username: user.username,
              email: user.email,
              role: user.role
            }
          })
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

// Logout endpoint
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err)
      return res.status(500).json({ error: 'Logout failed' })
    }
    res.json({ success: true, message: 'Logged out successfully' })
  })
})

// Check authentication status
app.get('/api/auth/status', checkAuth, (req, res) => {
  if (req.isAuthenticated) {
    res.json({
      authenticated: true,
      user: req.user
    })
  } else {
    res.json({
      authenticated: false
    })
  }
})

// Data Routes (Read-only routes don't require authentication)

// Get list of Excel files (public)
app.get('/api/files', checkAuth, async (req, res) => {
  try {
    const files = await fs.readdir(DATA_DIR)
    const excelFiles = files
      .filter(file => file.endsWith('.xlsx'))
      .map(file => {
        return {
          name: file,
          path: join(DATA_DIR, file)
        }
      })
    
    // Get file stats for each file
    const filesWithStats = await Promise.all(
      excelFiles.map(async (file) => {
        try {
          const stats = await fs.stat(file.path)
          return {
            name: file.name,
            size: stats.size,
            modified: stats.mtime,
            created: stats.birthtime
          }
        } catch (error) {
          return {
            name: file.name,
            size: 0,
            modified: new Date(),
            created: new Date(),
            error: 'Could not read file stats'
          }
        }
      })
    )

    res.json(filesWithStats.sort((a, b) => b.modified - a.modified))
  } catch (error) {
    console.error('Error reading data directory:', error)
    res.status(500).json({ error: 'Failed to read data files' })
  }
})

// Save Excel file to data folder (requires authentication)
app.post('/api/save-excel', 
  authenticateToken,
  uploadLimiter,
  [
    body('fileName')
      .isLength({ min: 1, max: 100 })
      .matches(/^[a-zA-Z0-9\-_\.]+$/)
      .withMessage('Invalid file name'),
    body('data')
      .isBase64()
      .isLength({ min: 1, max: 50 * 1024 * 1024 }) // Max 50MB
      .withMessage('Invalid or too large file data')
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { fileName, data } = req.body
      
      // Additional security: validate file size after decoding
      const buffer = Buffer.from(data, 'base64')
      if (buffer.length > 50 * 1024 * 1024) { // 50MB limit
        return res.status(413).json({ error: 'File too large' })
      }
      
      // Sanitize filename
      const safeFileName = sanitizeFileName(fileName)
      const fullFileName = safeFileName.endsWith('.xlsx') ? safeFileName : `${safeFileName}.xlsx`
      const filePath = join(DATA_DIR, fullFileName)
      
      // Ensure we're not writing outside the data directory
      if (!filePath.startsWith(DATA_DIR)) {
        return res.status(400).json({ error: 'Invalid file path' })
      }

      await fs.writeFile(filePath, buffer, { mode: 0o644 })

      res.json({ 
        success: true, 
        message: `File saved to ${fullFileName}`,
        fileName: fullFileName,
        size: buffer.length
      })
    } catch (error) {
      console.error('Error saving Excel file:', error)
      res.status(500).json({ error: 'Failed to save Excel file' })
    }
  }
)

// Load Excel file from data folder (public)
app.get('/api/load-excel/:fileName', 
  checkAuth,
  [
    param('fileName')
      .isLength({ min: 1, max: 100 })
      .matches(/^[a-zA-Z0-9\-_\.]+\.xlsx$/)
      .withMessage('Invalid file name')
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { fileName } = req.params
      const sanitizedFileName = sanitizeFileName(fileName)
      const filePath = join(DATA_DIR, sanitizedFileName)

      // Ensure we're not reading outside the data directory
      if (!filePath.startsWith(DATA_DIR)) {
        return res.status(400).json({ error: 'Invalid file path' })
      }

      // Check if file exists
      try {
        const stats = await fs.stat(filePath)
        if (!stats.isFile()) {
          return res.status(404).json({ error: 'File not found' })
        }
      } catch {
        return res.status(404).json({ error: 'File not found' })
      }

      // Read and return file as base64
      const buffer = await fs.readFile(filePath)
      const base64Data = buffer.toString('base64')

      res.json({
        success: true,
        fileName: sanitizedFileName,
        data: base64Data,
        size: buffer.length
      })
    } catch (error) {
      console.error('Error loading Excel file:', error)
      res.status(500).json({ error: 'Failed to load Excel file' })
    }
  }
)

// Delete Excel file (requires authentication)
app.delete('/api/delete-excel/:fileName', 
  authenticateToken,
  [
    param('fileName')
      .isLength({ min: 1, max: 100 })
      .matches(/^[a-zA-Z0-9\-_\.]+\.xlsx$/)
      .withMessage('Invalid file name')
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { fileName } = req.params
      const sanitizedFileName = sanitizeFileName(fileName)
      const filePath = join(DATA_DIR, sanitizedFileName)

      // Ensure we're not deleting outside the data directory
      if (!filePath.startsWith(DATA_DIR)) {
        return res.status(400).json({ error: 'Invalid file path' })
      }

      // Check if file exists
      try {
        const stats = await fs.stat(filePath)
        if (!stats.isFile()) {
          return res.status(404).json({ error: 'File not found' })
        }
      } catch {
        return res.status(404).json({ error: 'File not found' })
      }

      await fs.unlink(filePath)
      res.json({ success: true, message: `File ${sanitizedFileName} deleted successfully` })
    } catch (error) {
      console.error('Error deleting Excel file:', error)
      res.status(500).json({ error: 'Failed to delete Excel file' })
    }
  }
)

// Get current data file (latest or specified) (public)
app.get('/api/current-data/:fileName?', 
  checkAuth,
  [
    param('fileName')
      .optional()
      .isLength({ min: 1, max: 100 })
      .matches(/^[a-zA-Z0-9\-_\.]+\.xlsx$/)
      .withMessage('Invalid file name')
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      let fileName = req.params.fileName

      if (!fileName) {
        // Get the most recent Excel file
        const files = await fs.readdir(DATA_DIR)
        const excelFiles = files.filter(file => 
          file.endsWith('.xlsx') && 
          /^[a-zA-Z0-9\-_\.]+\.xlsx$/.test(file) // Additional safety check
        )
        
        if (excelFiles.length === 0) {
          return res.json({ success: false, message: 'No data files found' })
        }

        // Get the most recently modified file
        const filesWithStats = await Promise.all(
          excelFiles.map(async (file) => {
            try {
              const stats = await fs.stat(join(DATA_DIR, file))
              return { name: file, modified: stats.mtime }
            } catch {
              return null
            }
          })
        )
        
        const validFiles = filesWithStats.filter(f => f !== null)
        if (validFiles.length === 0) {
          return res.json({ success: false, message: 'No valid data files found' })
        }
        
        fileName = validFiles.sort((a, b) => b.modified - a.modified)[0].name
      }

      const sanitizedFileName = sanitizeFileName(fileName)
      const filePath = join(DATA_DIR, sanitizedFileName)
      
      // Ensure we're not reading outside the data directory
      if (!filePath.startsWith(DATA_DIR)) {
        return res.status(400).json({ error: 'Invalid file path' })
      }
      
      const buffer = await fs.readFile(filePath)
      const base64Data = buffer.toString('base64')

      res.json({
        success: true,
        fileName: sanitizedFileName,
        data: base64Data,
        size: buffer.length
      })
    } catch (error) {
      console.error('Error getting current data:', error)
      res.status(500).json({ error: 'Failed to get current data' })
    }
  }
)

// New Database API Routes

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
      res.json({ success: true, id: matchId })
    } catch (error) {
      console.error('Error adding match:', error)
      res.status(500).json({ error: 'Failed to add match' })
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
    const rankings = await db.getPlayerStatsLifetime()
    
    // Add form for each player
    const rankingsWithForm = await Promise.all(rankings.map(async (player) => {
      const form = await db.getPlayerForm(player.id, 5)
      return { ...player, form }
    }))
    
    res.json(rankingsWithForm)
  } catch (error) {
    console.error('Error getting lifetime rankings:', error)
    res.status(500).json({ error: 'Failed to get lifetime rankings' })
  }
})

app.get('/api/rankings/season/:seasonId', checkAuth, async (req, res) => {
  try {
    const seasonId = parseInt(req.params.seasonId)
    const rankings = await db.getPlayerStatsBySeason(seasonId)
    
    // Add form for each player (last 5 matches in this season)
    const rankingsWithForm = await Promise.all(rankings.map(async (player) => {
      const form = await db.getPlayerForm(player.id, 5)
      return { ...player, form }
    }))
    
    res.json(rankingsWithForm)
  } catch (error) {
    console.error('Error getting season rankings:', error)
    res.status(500).json({ error: 'Failed to get season rankings' })
  }
})

app.get('/api/rankings/date/:date', checkAuth, async (req, res) => {
  try {
    const { date } = req.params
    const rankings = await db.getPlayerStatsByPlayDate(date)
    
    // Add form for each player (last 5 matches up to this date)
    const rankingsWithForm = await Promise.all(rankings.map(async (player) => {
      const form = await db.getPlayerForm(player.id, 5)
      return { ...player, form }
    }))
    
    res.json(rankingsWithForm)
  } catch (error) {
    console.error('Error getting date rankings:', error)
    res.status(500).json({ error: 'Failed to get date rankings' })
  }
})

// Excel Export Route
app.get('/api/export-excel', checkAuth, async (req, res) => {
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

// Clear All Data Route (DANGEROUS!)
app.delete('/api/clear-all-data', 
  authenticateToken,
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

// Serve the application
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`🎾 Tennis Ranking System Server running on http://localhost:${PORT}`)
  console.log(`📁 Data files stored in: ${DATA_DIR}`)
})
