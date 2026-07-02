import { Router } from 'express'
import { getRealClientIP } from '../access-logger.js'

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

  // ── Admin-only health (sanitized — no internal proxy headers) ──────────────
  // Strips infrastructure details (proxy headers, NODE_ENV, topology) to prevent
  // attackers from understanding the deployment architecture.
  router.get('/api/health', authenticateToken, requireAdmin, async (_req, res) => {
    const dbHealth = await checkDatabaseHealth()
    const cacheStats = rankingsCache.getStats()

    // Check if FCM push sender is configured (firebase-admin)
    const fcmStatus = app?.locals?.pushSender ? 'configured' : 'disabled'
    const aiConfigured = process.env.AI_MODEL ? 'configured' : 'disabled'

    res.status(dbHealth.status === 'healthy' ? 200 : 503).json({
      status: dbHealth.status === 'healthy' ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      checks: {
        database: dbHealth,
        cache: {
          status: cacheStats.isConnected ? 'healthy' : 'degraded',
          entries: cacheStats.currentEntries || 0,
          hitRate: cacheStats.hitRate,
          hits: cacheStats.hits,
          misses: cacheStats.misses
        },
        push: { status: fcmStatus },
        ai: { status: aiConfigured }
      }
    })
  })

  // ── FCM / AI connectivity check (admin-only) ───────────────────────────
  // Verifies that Firebase Cloud Messaging and AI API endpoints are reachable.
  router.get('/api/health/services', authenticateToken, requireAdmin, async (_req, res) => {
    const checks = {
      fcm: { status: 'unknown', message: 'Not configured' },
      ai: { status: 'unknown', message: 'Not configured' }
    }

    // Check FCM: probe connectivity without sending real push notifications.
    // Only sends a test push if at least one valid device token exists in the DB.
    try {
      const pushSender = app?.locals?.pushSender
      if (pushSender && pushSender.messaging) {
        // Check if any registered devices exist first (avoid 1440 API calls/day)
        const deviceCount = await db.getDeviceCount()
        if (deviceCount > 0) {
          // Quick connectivity probe: send to a known-invalid token
          await pushSender.messaging.send({
            token: 'test_invalid_token_for_health_check',
            notification: { title: 'health', body: 'test' }
          })
          checks.fcm.status = 'healthy'
          checks.fcm.message = 'FCM endpoint reachable'
        } else {
          checks.fcm.status = 'healthy'
          checks.fcm.message = 'FCM configured but no registered devices (skipping test push)'
        }
      } else {
        checks.fcm.status = 'disabled'
        checks.fcm.message = 'FCM not configured (no FIREBASE_SERVICE_ACCOUNT_PATH)'
      }
    } catch (error) {
      // Even a failed send to invalid token means the endpoint is reachable
      if (error.code === 'messaging/invalid-registration-token' ||
          error.code === 'messaging/too-many-registration-tokens' ||
          error.code === 'unavailable') {
        checks.fcm.status = 'healthy'
        checks.fcm.message = 'FCM endpoint reachable (token rejected as expected)'
      } else {
        checks.fcm.status = 'unhealthy'
        checks.fcm.message = error.message
      }
    }

    // Check AI API: simple HEAD request to the base URL
    if (process.env.AI_MODEL) {
      try {
        const response = await fetch(`${config.ai.baseUrl}/models`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${config.ai.apiKey}` }
        })
        if (response.ok) {
          checks.ai.status = 'healthy'
          checks.ai.message = 'AI API endpoint reachable'
        } else {
          checks.ai.status = response.status >= 500 ? 'unhealthy' : 'degraded'
          checks.ai.message = `AI API returned ${response.status}`
        }
      } catch (error) {
        checks.ai.status = 'unhealthy'
        checks.ai.message = error.message
      }
    }

    const allHealthy = Object.values(checks).every(c => c.status === 'healthy' || c.status === 'disabled' || c.status === 'unknown')
    res.status(allHealthy ? 200 : 503).json({ services: checks })
  })

  // ── Performance metrics (sanitized — no PID or process details) ────────────
  // Strips PID and sensitive process details to prevent DoS calibration.
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
        cpu: { user: cpuUsage.user, system: cpuUsage.system }
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

    // M4: Do not leak NODE_ENV — it reveals deployment architecture to any admin user
    const serverInfo = {
      uptime: process.uptime(),
      redisConnected: stats.isConnected
    }

    res.json({ success: true, cacheStats: stats, recommendations, serverInfo })
  })

  // ── Prometheus metrics endpoint ────────────────────────────────────────────
  // Exports application-level metrics in Prometheus format for monitoring.
  // Restricted to localhost — Prometheus scrapers typically run on the same host.
  router.get('/metrics', (req, res) => {
    const clientIP = getRealClientIP(req)
    if (clientIP !== '127.0.0.1' && clientIP !== '::1' && clientIP !== 'localhost') {
      return res.status(403).json({ error: 'Metrics endpoint restricted to localhost' })
    }
    const cacheStats = rankingsCache.getStats()
    const info = rankingsCache.isConnected ? { currentEntries: cacheStats.currentEntries, memoryUsage: 'ok' } : { currentEntries: 0, memoryUsage: 'disconnected' }

    const lines = [
      '# HELP tennis_cache_hits Total cache hits',
      '# TYPE tennis_cache_hits counter',
      `tennis_cache_hits ${cacheStats.hits}`,
      '# HELP tennis_cache_misses Total cache misses',
      '# TYPE tennis_cache_misses counter',
      `tennis_cache_misses ${cacheStats.misses}`,
      '# HELP tennis_cache_set_total Total cache sets',
      '# TYPE tennis_cache_set_total counter',
      `tennis_cache_set_total ${cacheStats.sets}`,
      '# HELP tennis_cache_invalidations Total cache invalidations',
      '# TYPE tennis_cache_invalidations counter',
      `tennis_cache_invalidations ${cacheStats.invalidations}`,
      '# HELP tennis_cache_keys Tracked number of cached keys',
      '# TYPE tennis_cache_keys gauge',
      `tennis_cache_keys ${cacheStats.keyCount || 0}`,
      '# HELP tennis_cache_hit_rate_percent Cache hit rate percentage',
      '# TYPE tennis_cache_hit_rate_percent gauge',
      `tennis_cache_hit_rate_percent ${parseFloat(cacheStats.hitRate) || 0}`,
      '# HELP tennis_cache_is_connected Whether Redis is connected',
      '# TYPE tennis_cache_is_connected gauge',
      `tennis_cache_is_connected ${cacheStats.isConnected ? 1 : 0}`,
      '# HELP tennis_uptime_seconds Server uptime in seconds',
      '# TYPE tennis_uptime_seconds gauge',
      `tennis_uptime_seconds ${Math.round(process.uptime())}`,
      '# HELP tennis_nodejs_memory_heap_used_bytes Heap used in bytes',
      '# TYPE tennis_nodejs_memory_heap_used_bytes gauge',
      `tennis_nodejs_memory_heap_used_bytes ${Math.round(process.memoryUsage().heapUsed)}`,
      '# HELP tennis_nodejs_memory_rss_bytes Resident set size in bytes',
      '# TYPE tennis_nodejs_memory_rss_bytes gauge',
      `tennis_nodejs_memory_rss_bytes ${Math.round(process.memoryUsage().rss)}`
    ]

    res.set('Content-Type', 'text/plain; charset=utf-8')
    res.end(lines.join('\n') + '\n')
  })

  return router
}
