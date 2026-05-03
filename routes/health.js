import { Router } from 'express'

/**
 * Health check and performance monitoring routes.
 *
 * - GET /health          — unauthenticated (for load balancers / Docker HEALTHCHECK)
 * - GET /api/health      — admin only (includes proxy/internal info)
 * - GET /api/performance — admin only (process & OS metrics)
 * - GET /api/cache-stats — admin only (Redis cache statistics)
 */
export const createHealthRouter = ({
  db,
  app,
  authenticateToken,
  requireAdmin,
  rankingsCache
}) => {
  const router = Router()

  async function checkDatabaseHealth() {
    try {
      const startTime = Date.now()
      if (!db?.query) {
        return { status: 'unhealthy', error: 'Database connection unavailable' }
      }

      await db.query('SELECT 1')
      return { status: 'healthy', responseTimeMs: Date.now() - startTime }
    } catch (error) {
      console.error('Database health check failed:', error.message)
      return { status: 'unhealthy', error: 'Database connection failed' }
    }
  }

  // ── Public health (load balancer / Docker HEALTHCHECK) ────────────────────
  // Lightweight liveness probe — no DB query to prevent spam-induced DB load.
  // For full diagnostics (DB, cache, proxy info), use admin-only /api/health.
  router.get('/health', (_req, res) => {
    const cacheStats = rankingsCache.getStats()
    const cacheStatus = cacheStats.isConnected ? 'healthy' : 'degraded'

    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      checks: {
        cache: { status: cacheStatus }
      }
    })
  })

  // ── Admin-only health (includes proxy headers & internal info) ─────────────
  router.get('/api/health', authenticateToken, requireAdmin, async (req, res) => {
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
        cache: { status: cacheStats.isConnected ? 'healthy' : 'degraded', entries: cacheStats.currentEntries || 0, hitRate: cacheStats.hitRate, hits: cacheStats.hits, misses: cacheStats.misses }
      }
    }

    if (process.env.NODE_ENV === 'development') {
      console.log('🔍 Health check - Proxy Info:', {
        clientIP: proxyInfo.clientIP, forwardedFor: proxyInfo.forwardedFor,
        realIP: proxyInfo.realIP, trustProxy: proxyInfo.proxyTrust
      })
    }

    res.status(dbHealth.status === 'healthy' ? 200 : 503).json(proxyInfo)
  })

  // ── Performance metrics ───────────────────────────────────────────────────
  router.get('/api/performance', authenticateToken, requireAdmin, (_req, res) => {
    const mem = process.memoryUsage()
    const cpuUsage = process.cpuUsage()
    res.json({
      success: true,
      performance: {
        uptime: process.uptime(),
        memory: {
          heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
          externalMB: Math.round(mem.external / 1024 / 1024),
          rssMB: Math.round(mem.rss / 1024 / 1024)
        },
        cpu: { user: cpuUsage.user, system: cpuUsage.system },
        pid: process.pid
      }
    })
  })

  // ── Cache statistics ──────────────────────────────────────────────────────
  router.get('/api/cache-stats', authenticateToken, requireAdmin, async (_req, res) => {
    const stats = await rankingsCache.getInfo()
    
    // Generate simple recommendations based on stats
    const hitRateNum = parseFloat(stats.hitRate) || 0
    const recommendations = {
      performance: hitRateNum < 50 ? 'Cân nhắc tăng TTL hoặc kiểm tra logic invalidation' : 'Tỷ lệ hit tốt',
      memory: stats.memoryUsage === 'unknown' ? 'Không thể đọc bộ nhớ sử dụng' : 'Bộ nhớ trong giới hạn cho phép',
      info: 'Bộ đệm đang hoạt động ổn định'
    }

    const serverInfo = {
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'production',
      redisConnected: stats.isConnected
    }

    res.json({ success: true, cacheStats: stats, recommendations, serverInfo })
  })

  return router
}
