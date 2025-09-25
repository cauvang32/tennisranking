import winston from 'winston'
import { createStream } from 'rotating-file-stream'
import geoip from 'geoip-lite'
import { UAParser } from 'ua-parser-js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Enhanced IP detection utility
export function getRealClientIP(req) {
  // Priority order for IP detection (most reliable first)
  const ipSources = [
    req.get('CF-Connecting-IP'),        // Cloudflare
    req.get('X-Real-IP'),               // Nginx
    req.get('X-Forwarded-For'),         // Standard proxy header
    req.ip,                             // Express.js detected IP
    req.connection.remoteAddress,       // Direct connection
    req.socket.remoteAddress,           // Socket connection
    'unknown'
  ]

  for (const ip of ipSources) {
    if (ip && ip !== 'unknown') {
      // Handle X-Forwarded-For which can contain multiple IPs
      if (ip.includes(',')) {
        // Take the first IP (original client)
        const firstIP = ip.split(',')[0].trim()
        if (isValidIP(firstIP)) {
          return firstIP
        }
      } else if (isValidIP(ip)) {
        return ip
      }
    }
  }
  
  return 'unknown'
}

// Validate IP address format
function isValidIP(ip) {
  if (!ip || ip === 'unknown') return false
  
  // IPv4 validation
  const ipv4Regex = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/
  
  // IPv6 validation (basic)
  const ipv6Regex = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/
  
  return ipv4Regex.test(ip) || ipv6Regex.test(ip) || ip === '::1' || ip === '::ffff:127.0.0.1'
}

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, 'logs')
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true })
}

// Create rotating file stream for access logs
const accessLogStream = createStream('access.log', {
  interval: '1d',        // Rotate daily
  path: logsDir,
  maxFiles: 30,          // Keep 30 days of logs
  compress: 'gzip'       // Compress old logs
})

// Create rotating file stream for error logs
const errorLogStream = createStream('error.log', {
  interval: '1d',        // Rotate daily
  path: logsDir,
  maxFiles: 30,          // Keep 30 days of logs
  compress: 'gzip'       // Compress old logs
})

// Winston logger configuration
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    // Console transport (for development)
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    
    // File transport for general logs
    new winston.transports.Stream({
      stream: accessLogStream,
      level: 'info'
    }),
    
    // File transport for errors
    new winston.transports.Stream({
      stream: errorLogStream,
      level: 'error'
    })
  ]
})

// Access log entry creator
export function createAccessLogEntry(req, res, responseTime, user = null) {
  const realIP = getRealClientIP(req)
  const userAgent = req.get('User-Agent') || 'unknown'
  const parser = new UAParser(userAgent)
  const parsedUA = parser.getResult()
  
  // Get geographic information (optional - can be disabled for privacy)
  let geoInfo = null
  try {
    if (realIP && realIP !== 'unknown' && !isLocalIP(realIP)) {
      const geo = geoip.lookup(realIP)
      if (geo) {
        geoInfo = {
          country: geo.country,
          region: geo.region,
          city: geo.city,
          timezone: geo.timezone,
          ll: geo.ll // latitude, longitude
        }
      }
    }
  } catch (error) {
    // Silently fail geo lookup to avoid breaking requests
  }

  const logEntry = {
    timestamp: new Date().toISOString(),
    
    // Request information
    method: req.method,
    url: req.originalUrl || req.url,
    path: req.path,
    query: Object.keys(req.query).length > 0 ? req.query : undefined,
    
    // IP and network information
    clientIP: realIP,
    clientIPFormatted: formatIPForDisplay(realIP),
    ipDetectionSources: {
      cfConnectingIP: req.get('CF-Connecting-IP') || null,
      xRealIP: req.get('X-Real-IP') || null,
      xForwardedFor: req.get('X-Forwarded-For') || null,
      expressIP: req.ip || null,
      connectionRemoteAddress: req.connection?.remoteAddress || null,
      socketRemoteAddress: req.socket?.remoteAddress || null
    },
    // Legacy fields for backward compatibility
    forwardedFor: req.get('X-Forwarded-For'),
    realIP: req.get('X-Real-IP'),
    cfConnectingIP: req.get('CF-Connecting-IP'),
    
    // User information
    user: user ? {
      username: user.username,
      role: user.role,
      email: user.email
    } : null,
    
    // Session information
    sessionId: req.cookies?.csrfSessionId || 'none',
    isAuthenticated: !!user,
    
    // Browser and device information
    userAgent: userAgent,
    browser: parsedUA.browser ? {
      name: parsedUA.browser.name,
      version: parsedUA.browser.version
    } : undefined,
    os: parsedUA.os ? {
      name: parsedUA.os.name,
      version: parsedUA.os.version
    } : undefined,
    device: parsedUA.device ? {
      type: parsedUA.device.type,
      model: parsedUA.device.model
    } : undefined,
    
    // Geographic information (optional)
    geo: geoInfo,
    
    // Request metadata
    referer: req.get('Referer'),
    acceptLanguage: req.get('Accept-Language'),
    contentType: req.get('Content-Type'),
    
    // Response information
    statusCode: res.statusCode,
    responseTime: responseTime,
    contentLength: res.get('Content-Length'),
    
    // Proxy information (for debugging)
    proxyHeaders: {
      xForwardedProto: req.get('X-Forwarded-Proto'),
      xForwardedHost: req.get('X-Forwarded-Host'),
      xForwardedPort: req.get('X-Forwarded-Port'),
      host: req.get('Host'),
      origin: req.get('Origin')
    },
    
    // Security flags
    isBot: isBot(userAgent),
    isSuspicious: isSuspiciousRequest(req, realIP),
    
    // Request type classification
    requestType: classifyRequest(req.path, req.method),
    
    // Additional metadata
    httpVersion: req.httpVersion,
    secure: req.secure,
    xhr: req.xhr
  }

  return logEntry
}

// Check if IP is local/private
function isLocalIP(ip) {
  if (!ip || ip === 'unknown') return false
  
  const localPatterns = [
    /^127\./,           // 127.x.x.x (localhost)
    /^192\.168\./,      // 192.168.x.x (private)
    /^10\./,            // 10.x.x.x (private)
    /^172\.(1[6-9]|2\d|3[01])\./,  // 172.16.x.x - 172.31.x.x (private)
    /^::1$/,            // IPv6 localhost
    /^::ffff:127\./     // IPv4-mapped IPv6 localhost
  ]
  
  return localPatterns.some(pattern => pattern.test(ip))
}

// Format IP for human-readable display
function formatIPForDisplay(ip) {
  if (!ip || ip === 'unknown') return 'Unknown IP'
  
  // Convert IPv6 localhost to readable format
  if (ip === '::1') return 'localhost (IPv6)'
  if (ip === '127.0.0.1') return 'localhost (IPv4)'
  if (ip.startsWith('::ffff:127.')) return 'localhost (IPv4-mapped IPv6)'
  
  // Check if it's a private IP
  if (ip.startsWith('192.168.')) return `${ip} (private network)`
  if (ip.startsWith('10.')) return `${ip} (private network)`
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return `${ip} (private network)`
  
  // Public IP
  return `${ip} (public)`
}

// Bot detection
function isBot(userAgent) {
  if (!userAgent) return false
  
  const botPatterns = [
    /bot/i, /crawl/i, /spider/i, /scrape/i,
    /google/i, /bing/i, /yahoo/i, /baidu/i,
    /facebook/i, /twitter/i, /linkedin/i,
    /curl/i, /wget/i, /python/i, /node/i,
    /postman/i, /insomnia/i
  ]
  
  return botPatterns.some(pattern => pattern.test(userAgent))
}

// Suspicious request detection
function isSuspiciousRequest(req, realIP) {
  const suspiciousPatterns = [
    // Common attack patterns
    /\.\./,                    // Directory traversal
    /<script/i,                // XSS attempts
    /union.*select/i,          // SQL injection
    /eval\(/i,                 // Code injection
    /cmd\.|system\(/i,         // Command injection
    /\/admin/i,                // Admin panel probing (if not legitimate)
    /\.php$/i,                 // PHP file requests on non-PHP site
    /\.asp$/i,                 // ASP file requests
    /wp-admin/i,               // WordPress admin (if not WordPress site)
    /wp-login/i                // WordPress login (if not WordPress site)
  ]
  
  const url = req.originalUrl || req.url
  const userAgent = req.get('User-Agent') || ''
  
  // Check URL patterns
  if (suspiciousPatterns.some(pattern => pattern.test(url))) {
    return true
  }
  
  // Check for missing User-Agent (suspicious for browsers)
  if (!userAgent && req.method === 'GET') {
    return true
  }
  
  // Check for rapid requests from same IP (basic)
  // This could be enhanced with a more sophisticated rate tracking
  
  return false
}

// Request type classification
function classifyRequest(path, method) {
  if (path.startsWith('/api/')) {
    if (path.includes('/auth/')) return 'auth'
    if (path.includes('/players')) return 'players'
    if (path.includes('/matches')) return 'matches'
    if (path.includes('/seasons')) return 'seasons'
    if (path.includes('/rankings')) return 'rankings'
    if (path.includes('/export')) return 'export'
    return 'api'
  }
  
  if (path === '/' || path === '/tennis' || path.startsWith('/tennis/')) return 'page'
  if (path.startsWith('/health')) return 'health'
  if (path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf)$/)) return 'static'
  
  return 'other'
}

// Log access entry
export function logAccess(req, res, responseTime, user = null) {
  const logEntry = createAccessLogEntry(req, res, responseTime, user)
  
  // Log to Winston (which handles file rotation)
  logger.info('ACCESS', logEntry)
  
  // Also log to console in development mode with simplified format
  if (process.env.NODE_ENV === 'development') {
    const userInfo = user ? `${user.username}(${user.role})` : 'anonymous'
    const geoInfo = logEntry.geo ? `${logEntry.geo.country}/${logEntry.geo.city}` : 'local'
    const ipInfo = logEntry.clientIPFormatted || logEntry.clientIP
    console.log(`🌐 ${logEntry.method} ${logEntry.path} | ${ipInfo} (${geoInfo}) | ${userInfo} | ${logEntry.statusCode} | ${responseTime}ms`)
    
    // Log detailed IP detection info occasionally for debugging
    if (Math.random() < 0.1) { // 10% of requests
      console.log(`🔍 IP Detection Details:`, {
        detected: logEntry.clientIP,
        sources: logEntry.ipDetectionSources,
        formatted: logEntry.clientIPFormatted
      })
    }
  }
  
  return logEntry
}

// Log error
export function logError(error, req = null, user = null) {
  const errorEntry = {
    timestamp: new Date().toISOString(),
    level: 'error',
    message: error.message,
    stack: error.stack,
    
    // Request context if available
    request: req ? {
      method: req.method,
      url: req.originalUrl || req.url,
      clientIP: getRealClientIP(req),
      userAgent: req.get('User-Agent')
    } : null,
    
    // User context if available
    user: user ? {
      username: user.username,
      role: user.role
    } : null
  }
  
  logger.error('ERROR', errorEntry)
  return errorEntry
}

// Get log statistics (for admin dashboard)
export async function getLogStats(hours = 24) {
  // This is a simplified version - in production you might want to use a database
  // or more sophisticated log analysis
  
  try {
    const logFile = path.join(logsDir, 'access.log')
    if (!fs.existsSync(logFile)) {
      return {
        totalRequests: 0,
        uniqueIPs: 0,
        topIPs: [],
        topPaths: [],
        userRequests: 0,
        anonymousRequests: 0,
        statusCodes: {},
        browsers: {},
        countries: {}
      }
    }
    
    // For demo purposes, return mock stats
    // In production, you'd parse the actual log file or use a database
    return {
      totalRequests: 0,
      uniqueIPs: 0,
      topIPs: [],
      topPaths: [],
      userRequests: 0,
      anonymousRequests: 0,
      statusCodes: {},
      browsers: {},
      countries: {},
      note: 'Real-time log analysis not implemented yet - use log files in /logs directory'
    }
  } catch (error) {
    logError(error)
    throw error
  }
}

export default {
  getRealClientIP,
  createAccessLogEntry,
  logAccess,
  logError,
  getLogStats,
  logger
}