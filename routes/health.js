import { Router } from 'express'

/**
 * Health check and performance monitoring routes.
 *
 * - GET /health          — unauthenticated (for load balancers / Docker HEALTHCHECK)
 * - GET /api/health      — authenticated (includes proxy/internal info)
 * - GET /api/performance — authenticated (process & OS metrics)
 * - GET /api/cache-stats — authenticated (Redis cache statistics)
 */
export const createHealthRouter = ({
  db,
  app,
  authenticateToken,
  rankingsCache
}) => {
  const router = Router()

  async function checkDatabaseHealth() {
    try {
      const startTime = Date.now()
      await db.pool.query('SELECT 1')
      return { status: 'healthy', responseTimeMs: Date.now() - startTime }
    } catch (error) {
      console.error('Database health check failed:', error.message)
      return { status: 'unhealthy', error: 'Database connection failed' }
    }
  }

  // ── Public health (load balancer / Docker HEALTHCHECK) ────────────────────
  router.get('/health', async (_req, res) => {
    const dbHealth = await checkDatabaseHealth()
    const cacheStats = rankingsCache.getStats()
    const mem = process.memoryUsage()
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
        cache: { status: 'healthy', entries: cacheStats.currentEntries, hitRate: cacheStats.hitRate },
        memory: {
          heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
          rssMB: Math.round(mem.rss / 1024 / 1024)
        }
      }
    })
  })

  // ── Authenticated health (includes proxy headers) ─────────────────────────
  router.get('/api/health', authenticateToken, async (req, res) => {
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
        cache: { entries: cacheStats.currentEntries, hitRate: cacheStats.hitRate, hits: cacheStats.hits, misses: cacheStats.misses }
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
  router.get('/api/performance', authenticateToken, (_req, res) => {
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
  router.get('/api/cache-stats', authenticateToken, async (_req, res) => {
    const stats = await rankingsCache.getInfo()
    res.json({ success: true, cache: stats })
  })

  return router
}
