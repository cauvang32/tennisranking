import { Router } from 'express'
import { query } from 'express-validator'
import { getRealClientIP, logError, getLogStats } from '../access-logger.js'

/**
 * Admin analytics routes (admin-only).
 * Extracted from server.js for modularity.
 */
export const createAdminRouter = ({
  authenticateToken,
  requireAdmin,
  smartApiLimiter,
  handleValidationErrors,
  formatSecureTimestamp
}) => {
  const router = Router()

  // Helper for local IP detection
  const isLocalIP = (ip) => {
    if (!ip || ip === 'unknown') return false
    const localPatterns = [
      /^127\./, /^192\.168\./, /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^::1$/, /^::ffff:127\./
    ]
    return localPatterns.some(p => p.test(ip))
  }

  // Access log statistics
  router.get('/access-stats',
    authenticateToken, requireAdmin, smartApiLimiter,
    [query('hours').optional().isInt({ min: 1, max: 720 }).withMessage('Hours must be between 1 and 720')],
    handleValidationErrors,
    async (req, res) => {
      try {
        const hours = parseInt(req.query.hours) || 24
        const stats = await getLogStats(hours)
        res.json({ success: true, timeframe: `${hours} hours`, stats, timestamp: formatSecureTimestamp() })
      } catch (error) {
        console.error('Error getting access stats:', error)
        res.status(500).json({ error: 'Failed to get access statistics' })
      }
    }
  )

  // Access logs
  router.get('/access-logs',
    authenticateToken, requireAdmin, smartApiLimiter,
    [
      query('limit').optional().isInt({ min: 1, max: 10000 }),
      query('offset').optional().isInt({ min: 0 }),
      query('ip').optional().isIP(),
      query('user').optional().trim().escape().isLength({ max: 100 }),
      query('path').optional().trim().isLength({ max: 500 })
    ],
    handleValidationErrors,
    async (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 100
        const offset = parseInt(req.query.offset) || 0
        res.json({
          success: true,
          message: 'Access logs are stored in rotating files. Use the log files in /logs directory for detailed analysis.',
          logLocation: '/logs/access.log',
          parameters: { limit, offset, filters: { ip: req.query.ip, user: req.query.user, path: req.query.path } },
          note: 'Real-time log querying from database will be implemented in future version.',
          currentLogFile: 'logs/access.log',
          errorLogFile: 'logs/error.log'
        })
      } catch (error) {
        console.error('Error getting access logs:', error)
        res.status(500).json({ error: 'Failed to get access logs' })
      }
    }
  )

  // IP analysis
  router.get('/ip-analysis',
    authenticateToken, requireAdmin, smartApiLimiter,
    [query('ip').optional().isIP()],
    handleValidationErrors,
    async (req, res) => {
      try {
        const clientIP = getRealClientIP(req)
        const targetIP = req.query.ip || clientIP
        res.json({
          success: true,
          ipAnalysis: {
            ip: targetIP,
            isLocal: isLocalIP(targetIP),
            timestamp: formatSecureTimestamp(),
            analysis: {
              type: isLocalIP(targetIP) ? 'local/private' : 'public',
              suspicious: false,
              reputation: 'unknown',
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
          }
        })
      } catch (error) {
        console.error('Error analyzing IP:', error)
        res.status(500).json({ error: 'Failed to analyze IP' })
      }
    }
  )

  // Active sessions
  router.get('/active-sessions',
    authenticateToken, requireAdmin, smartApiLimiter,
    async (req, res) => {
      try {
        res.json({
          success: true,
          activeSessions: {
            current: {
              ip: getRealClientIP(req),
              user: req.user,
              timestamp: formatSecureTimestamp(),
              userAgent: req.get('User-Agent')
            },
            note: 'Full session tracking would require session store implementation'
          }
        })
      } catch (error) {
        console.error('Error getting active sessions:', error)
        res.status(500).json({ error: 'Failed to get active sessions' })
      }
    }
  )

  // Security dashboard
  router.get('/security-dashboard',
    authenticateToken, requireAdmin, smartApiLimiter,
    async (req, res) => {
      try {
        const uptime = process.uptime()
        res.json({
          success: true,
          dashboard: {
            system: {
              uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
              nodeEnv: process.env.NODE_ENV,
              currentTime: formatSecureTimestamp()
            },
            security: {
              rateLimiting: 'Active', corsProtection: 'Active', csrfProtection: 'Active',
              helmetSecurity: 'Active',
              httpsRedirection: process.env.NODE_ENV === 'production' ? 'Active' : 'Disabled (dev)',
              ipDetection: 'Enhanced (multiple sources)'
            },
            monitoring: {
              accessLogging: 'Active (file-based with rotation)', errorLogging: 'Active',
              geoLocation: 'Active', botDetection: 'Active', suspiciousActivityDetection: 'Basic'
            },
            currentRequest: {
              yourIP: getRealClientIP(req), authenticated: true, role: req.user.role,
              timestamp: formatSecureTimestamp()
            }
          },
          logFiles: {
            accessLog: 'logs/access.log (rotated daily)', errorLog: 'logs/error.log (rotated daily)',
            retention: '30 days', compression: 'gzip for old files'
          }
        })
      } catch (error) {
        console.error('Error getting security dashboard:', error)
        res.status(500).json({ error: 'Failed to get security dashboard' })
      }
    }
  )

  return router
}
