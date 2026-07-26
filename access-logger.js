import winston from 'winston'
import { createStream } from 'rotating-file-stream'
import crypto from 'crypto'

import { UAParser } from 'ua-parser-js'
import fs from 'fs'
import fsPromises from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const LOG_RETENTION_DAYS = Math.min(30, Math.max(1, parseInt(process.env.LOG_RETENTION_DAYS, 10) || 14))
const SENSITIVE_QUERY_KEYS = /^(token|access_token|refresh_token|password|secret|key|api_key|authorization|csrf|_csrf)$/i

function redactQuery(query = {}) {
  return Object.fromEntries(Object.entries(query).map(([key, value]) => [
    key,
    SENSITIVE_QUERY_KEYS.test(key)
      ? '[REDACTED]'
      : String(value).slice(0, 256)
  ]))
}

// Enhanced IP detection utility
// SECURITY: Prioritizes req.ip which respects Express's 'trust proxy' setting.
// When trust proxy is enabled (production), req.ip correctly resolves to the
// last trusted hop's client IP. Raw proxy headers are only used as fallback
// when trust proxy is off (development) or for Cloudflare's CF-Connecting-IP.
//
// IMPORTANT: Do NOT trust X-Real-IP or X-Forwarded-For unconditionally —
// they can be spoofed by attackers when the app is directly accessible
// (no reverse proxy). Only use them as last-resort fallbacks.
export function getRealClientIP(req) {
  // req.ip is the safest source — it respects app.set('trust proxy', ...) and
  // strips untrusted hops from X-Forwarded-For automatically.
  if (req.ip && isValidIP(req.ip)) {
    return req.ip
  }

  // Fallback sources (only reached if req.ip is unavailable/invalid)
  const fallbackSources = [
    req.get('CF-Connecting-IP'),        // Cloudflare (if behind CF)
    req.get('X-Real-IP'),               // Nginx
    req.get('X-Forwarded-For'),         // Standard proxy header
    req.connection?.remoteAddress,      // Direct connection
    req.socket?.remoteAddress,          // Socket connection
    'unknown'
  ]

  for (const ip of fallbackSources) {
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

  if (ipv4Regex.test(ip)) return true

  // IPv6 validation — handle full, compressed (::), and IPv4-mapped forms.
  // Full 8-group: 2001:0db8:85a3:0000:0000:8a2e:0370:7334
  // Compressed (:: at start/middle/end): 2001:db8::1, ::1, fe80::1, 2001:db8::
  // IPv4-mapped: ::ffff:192.0.2.1
  if (ip.includes('::')) {
    // :: can only appear once in a valid IPv6 address
    if (ip.split('::').length - 1 > 1) return false
    const [left, right] = ip.split('::')
    // Handle IPv4-mapped form (::ffff:192.0.2.1)
    if (right && right.includes('.')) {
      const ipv4Match = right.match(/^(.*?):(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
      if (!ipv4Match) return false
      const hexSuffix = ipv4Match[1] // e.g. "ffff" (before the IPv4 part)
      const ipv4Part = ipv4Match[2]  // e.g. "192.0.2.1"
      if (!ipv4Regex.test(ipv4Part)) return false
      const hexGroups = hexSuffix ? hexSuffix.split(':').length : 0
      const totalGroups = (left ? left.split(':').length : 0) + hexGroups
      if (totalGroups >= 8) return false
      const hexGroup = /^[0-9a-fA-F]{1,4}$/
      if (left) for (const g of left.split(':')) if (!hexGroup.test(g)) return false
      if (hexSuffix) for (const g of hexSuffix.split(':')) if (!hexGroup.test(g)) return false
      return true
    }
    const leftGroups = left ? left.split(':').length : 0
    const rightGroups = right ? right.split(':').length : 0
    // Total explicit groups must be < 8 (the :: represents at least one omitted group)
    if (leftGroups + rightGroups >= 8) return false
    // Each group must be 1-4 hex digits
    const hexGroup = /^[0-9a-fA-F]{1,4}$/
    if (left) for (const g of left.split(':')) if (!hexGroup.test(g)) return false
    if (right) for (const g of right.split(':')) if (!hexGroup.test(g)) return false
    return true
  }

  // Full 8-group form (no compression)
  const ipv6Regex = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/
  return ipv6Regex.test(ip)
}

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, 'logs')
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true, mode: 0o750 })
}
try { fs.chmodSync(logsDir, 0o750) } catch { /* managed mounts may reject chmod */ }

// Create rotating file stream for access logs
const accessLogStream = createStream('access.log', {
  interval: '1d',        // Rotate daily
  path: logsDir,
  maxFiles: LOG_RETENTION_DAYS,
  compress: 'gzip',
  mode: 0o640
})

// Create rotating file stream for error logs
const errorLogStream = createStream('error.log', {
  interval: '1d',        // Rotate daily
  path: logsDir,
  maxFiles: LOG_RETENTION_DAYS,
  compress: 'gzip',
  mode: 0o640
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

// LRU cache for parsed User-Agent strings (avoids re-parsing the same UA
// on every request). Map iteration order is insertion order, so on hit we
// delete + re-insert to move the entry to the most-recently-used position;
// eviction then removes the first key (the actual least-recently-used).
// Guaranteed to never return null/undefined: any UAParser throw (e.g. weird
// proxy UA strings) or partial-result edge case falls back to {} so callers
// can safely use `parsedUA?.browser` without crashing the log pipeline.
const UA_CACHE_MAX = 500
const uaCache = new Map()

function parseCachedUA(userAgent) {
  if (uaCache.has(userAgent)) {
    const value = uaCache.get(userAgent)
    // Promote to most-recently-used
    uaCache.delete(userAgent)
    uaCache.set(userAgent, value)
    return value || {}
  }
  let result
  try {
    result = new UAParser(userAgent || '').getResult() || {}
  } catch {
    // Defensive: ua-parser-js can throw on unusual inputs (e.g. binary blobs).
    // Never let a UA-parse failure kill the request.
    result = {}
  }
  // Evict least-recently-used entry when cache is full
  if (uaCache.size >= UA_CACHE_MAX) {
    const oldest = uaCache.keys().next().value
    uaCache.delete(oldest)
  }
  uaCache.set(userAgent, result)
  return result
}

// Access log entry creator
export function createAccessLogEntry(req, res, responseTime, user = null) {
  const realIP = getRealClientIP(req)
  const userAgent = req.get('User-Agent') || 'unknown'
  const requestPath = req.path || req.url || ''
  
  // Performance: skip expensive UA parsing and geoIP for static files and health checks
  const isStaticOrHealth = /\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|map|webp|avif)$/.test(requestPath)
    || requestPath === '/health'
    || requestPath.startsWith('/health')
  
  let parsedUA = null
  if (!isStaticOrHealth) {
    parsedUA = parseCachedUA(userAgent)
  }
  


  const logEntry = {
    timestamp: new Date().toISOString(),
    
    // Request information
    method: req.method,
    url: req.path,
    path: req.path,
    query: Object.keys(req.query).length > 0 ? redactQuery(req.query) : undefined,
    
    // IP and network information
    clientIP: realIP,
    clientIPFormatted: formatIPForDisplay(realIP),
    expressIP: req.ip || null,
    
    // User information
    // SECURITY: PII (email) is gated behind LOG_PII env flag to prevent
    // accidental PII leakage in rotated log files retained for 30 days.
    user: user ? {
      role: user.role,
      ...(process.env.LOG_PII === 'true'
        ? { username: user.username, email: user.email }
        : {})
    } : null,
    
    // Session information
    sessionId: req.user?.id?.toString() || 'anonymous',
    isAuthenticated: !!user,
    
    // Browser and device information
    userAgent: userAgent.slice(0, 512),
    browser: parsedUA?.browser ? {
      name: parsedUA.browser.name,
      version: parsedUA.browser.version
    } : undefined,
    os: parsedUA?.os ? {
      name: parsedUA.os.name,
      version: parsedUA.os.version
    } : undefined,
    device: parsedUA?.device ? {
      type: parsedUA.device.type,
      model: parsedUA.device.model
    } : undefined,
    
    // Request metadata
    referer: req.get('Referer')?.split('?')[0]?.slice(0, 512),
    acceptLanguage: req.get('Accept-Language')?.slice(0, 128),
    contentType: req.get('Content-Type'),
    
    // Response information
    statusCode: res.statusCode,
    responseTime: responseTime,
    contentLength: res.get('Content-Length'),
    
    origin: req.get('Origin')?.slice(0, 256),
    
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
function isSuspiciousRequest(req, _realIP) {
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
  
  // Check URL patterns (with length limit to prevent ReDoS)
  const safeUrl = url.length > 1000 ? url.substring(0, 1000) : url
  if (suspiciousPatterns.some(pattern => pattern.test(safeUrl))) {
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
function classifyRequest(path, _method) {
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
    const ipInfo = logEntry.clientIPFormatted || logEntry.clientIP
    console.log(`🌐 ${logEntry.method} ${logEntry.path} | ${ipInfo} | ${userInfo} | ${logEntry.statusCode} | ${responseTime}ms`)
    
    // Log detailed IP detection info occasionally for debugging (~10% of requests)
    if (crypto.randomInt(100) < 10) {
      console.log(`🔍 IP Detection Details:`, {
        detected: logEntry.clientIP,
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
      url: req.path,
      clientIP: getRealClientIP(req),
      userAgent: req.get('User-Agent')
    } : null,
    
    // User context if available
    user: user ? {
      role: user.role,
      ...(process.env.LOG_PII === 'true' ? { username: user.username } : {})
    } : null
  }
  
  logger.error('ERROR', errorEntry)
  return errorEntry
}

// Get log statistics (for admin dashboard)
// S6: Use async file reading to avoid blocking the event loop.
// With 30 days of rotated logs, sync read could block for hundreds of ms.
export async function getLogStats(hours = 24) {
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
        statusCodes: {}
      }
    }

    // S6: Async read — non-blocking. Limit to last 100KB to cap memory usage.
    const stat = await fsPromises.stat(logFile)
    const start = Math.max(0, stat.size - 102400) // last 100KB
    const fd = await fsPromises.open(logFile, 'r')
    const buffer = Buffer.alloc(stat.size - start)
    await fd.read(buffer, 0, buffer.length, start)
    await fd.close()

    const lines = buffer.toString('utf8').split('\n').filter(Boolean)
    const cutoff = Date.now() - hours * 60 * 60 * 1000

    // Parse log entries for the time window; skip malformed or out-of-window lines.
    const recentLines = []
    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        if (entry.timestamp && new Date(entry.timestamp).getTime() > cutoff) {
          recentLines.push(entry)
        }
      } catch { /* skip malformed */ }
    }

    const ipCount = {}
    const pathCount = {}
    const statusCodes = {}
    let userRequests = 0
    let anonymousRequests = 0

    for (const entry of recentLines) {
      const method = entry.method || ''
      const path = entry.path || ''
      const ip = entry.ip || entry.clientIp || ''
      const status = entry.statusCode || entry.status || 0

      if (method) ipCount[ip] = (ipCount[ip] || 0) + 1
      if (path) pathCount[path] = (pathCount[path] || 0) + 1
      if (status) statusCodes[status] = (statusCodes[status] || 0) + 1

      if (entry.isAuthenticated || entry.user) {
        userRequests++
      } else {
        anonymousRequests++
      }
    }

    const topIPs = Object.entries(ipCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([ip, count]) => ({ ip, count }))

    const topPaths = Object.entries(pathCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([path, count]) => ({ path, count }))

    return {
      totalRequests: recentLines.length,
      uniqueIPs: Object.keys(ipCount).length,
      topIPs,
      topPaths,
      userRequests,
      anonymousRequests,
      statusCodes
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
