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

// Serve the application
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`🎾 Tennis Ranking System Server running on http://localhost:${PORT}`)
  console.log(`📁 Data files stored in: ${DATA_DIR}`)
})
