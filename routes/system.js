import { Router } from 'express'
import config from '../config/env.js'
import { deriveCSRFSecretFromUser, createReusableToken } from '../middleware/csrf.js'
import { getRealClientIP } from '../access-logger.js'

/**
 * System routes: SSE, CSRF tokens, data version, init endpoint, debug config, CSP report.
 */
export const createSystemRouter = ({
  db,
  app,
  checkAuth,
  authenticateToken,
  requireAdmin,
  initLimiter,
  cspReportLimiter,
  rankingsCache,
  sseClients,
  formatSecureTimestamp,
  sanitizeResponse
}) => {
  const router = Router()
  const SUBPATH = config.subpath
  // O8: Per-IP SSE limit — allow up to 20% of total capacity per IP,
  // minimum 5 (enough for mobile + desktop + tablet), maximum 50.
  // With 200 total slots: 40 per IP → ~5 concurrent IPs at max, or
  // 20+ IPs at lower usage. Prevents a single client from monopolizing.
  const MAX_SSE_PER_IP = Math.max(5, Math.min(50, Math.floor(config.maxSseClients / 5)))

  // ── CSRF token endpoint ───────────────────────────────────────────────────
  router.get('/api/csrf-token', (req, res) => {
    const csrfSecret = deriveCSRFSecretFromUser(req.user || { id: 'anonymous' })
    const csrfToken = createReusableToken(csrfSecret)
    res.json({ csrfToken })
  })

  router.post('/api/csrf-token', (req, res) => {
    const csrfSecret = deriveCSRFSecretFromUser(req.user || { id: 'anonymous' })
    const csrfToken = createReusableToken(csrfSecret)
    res.json({ csrfToken })
  })

  // ── Data version (for client cache sync) ──────────────────────────────────
  router.get('/api/data-version', checkAuth, (_req, res) => {
    res.json({ version: rankingsCache.getDataVersion() })
  })

  // ── Init endpoint (bootstrap data for frontend) ──────────────────────────
  router.get('/api/init', initLimiter, checkAuth, async (req, res) => {
    try {
      // Fetch startup data in parallel — 6 Redis round-trips pipelined
      // instead of 6 sequential awaits.
      const [rankingsR, playersR, seasonsR, activeSeasonsR, playDatesR, activeSeasonR] = await Promise.all([
        rankingsCache.getOrSet('rankings:lifetime', () => db.getPlayerStatsWithFormsLifetime(5)),
        rankingsCache.getOrSet('players', () => db.getPlayers()),
        rankingsCache.getOrSet('seasons', () => db.getSeasons()),
        rankingsCache.getOrSet('seasons:active', () => db.getActiveSeasons()),
        rankingsCache.getOrSet('playdates', () => db.getPlayDates()),
        rankingsCache.getOrSet('season:active', () => db.getActiveSeason())
      ])

      const rankings = rankingsR.data
      const players = playersR.data
      const seasons = seasonsR.data
      const activeSeasons = activeSeasonsR.data
      const playDates = playDatesR.data
      const activeSeason = activeSeasonR.data
      const rankingsHit = rankingsR.hit
      const playersHit = playersR.hit
      const seasonsHit = seasonsR.hit
      const activeSeasonsHit = activeSeasonsR.hit
      const playDatesHit = playDatesR.hit
      const activeSeasonHit = activeSeasonR.hit

      const latestPlayDate = playDates?.[0]?.play_date?.split('T')[0] || null

      // Fetch default date rankings + matches so the frontend doesn't need extra fetches
      let defaultDateRankings = null
      let defaultDateMatches = null
      if (latestPlayDate) {
        const [ddr, ddm] = await Promise.all([
          rankingsCache.getOrSet(`rankings:date:${latestPlayDate}`, () => db.getPlayerStatsWithFormsByDate(latestPlayDate, 5)),
          rankingsCache.getOrSet(`matches:date:${latestPlayDate}`, () => db.getMatchesByPlayDate(latestPlayDate))
        ])
        defaultDateRankings = sanitizeResponse(ddr.data)
        defaultDateMatches = sanitizeResponse(ddm.data)
      }

      const initData = {
        // Field names match what the frontend expects (src/main.js L790-826)
        lifetimeRankings: sanitizeResponse(rankings),
        players: sanitizeResponse(players),
        seasons: sanitizeResponse(seasons),
        activeSeasons: sanitizeResponse(activeSeasons),
        playDates,
        activeSeason,
        defaultDate: latestPlayDate,
        defaultDateRankings,
        defaultDateMatches,
        version: rankingsCache.getDataVersion(),
        isAuthenticated: req.isAuthenticated || false,
        user: req.user || null,
        timestamp: formatSecureTimestamp()
      }

      // CSP-safe: set CSRF token for all sessions
      initData.csrfToken = createReusableToken(deriveCSRFSecretFromUser(req.user || { id: 'anonymous' }))

      const hitCount = [rankingsHit, playersHit, seasonsHit, activeSeasonsHit, playDatesHit, activeSeasonHit].filter(Boolean).length
      // L7: Only expose Redis-Cache diagnostic header in development
      if (!config.isProduction) res.set('Redis-Cache', `${hitCount}/6`)
      res.json(initData)
    } catch (error) {
      console.error('Error in init endpoint:', error)
      res.status(500).json({ error: 'Failed to initialize application data' })
    }
  })

  // ── SSE — Server-Sent Events for real-time updates ────────────────────────
  // Per-IP connection limits prevent a single client from opening all slots.
  // Anonymous connections are allowed — the data version broadcast is public.
  const ipConnections = new Map() // IP -> Set of responses

  // Periodic cleanup of stale IP entries (every 5 minutes)
  const sseCleanupInterval = setInterval(() => {
    for (const [ip, conns] of ipConnections) {
      if (conns.size === 0) ipConnections.delete(ip)
    }
  }, 5 * 60 * 1000)
  sseCleanupInterval.unref?.()

  router.get('/api/events', (req, res) => {
    const clientIP = getRealClientIP(req)
    let ipConns = ipConnections.get(clientIP)
    if (!ipConns) {
      ipConns = new Set()
      ipConnections.set(clientIP, ipConns)
    }
    if (ipConns.size >= MAX_SSE_PER_IP) {
      return res.status(429).json({ error: 'Too many SSE connections from this IP' })
    }
    if (sseClients.size >= config.maxSseClients) {
      return res.status(503).json({ error: 'Too many SSE connections' })
    }

    // Disable request timeout for SSE (otherwise middleware timeout kills it)
    // Use socket-level timeout (Express 4/5 compatible, no deprecated API)
    req.socket.setTimeout(0)

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('Content-Encoding', 'identity') // Bypass compression buffer
    res.setHeader('X-Accel-Buffering', 'no') // Nginx: don't buffer SSE
    try { res.flushHeaders() } catch { /* client may have disconnected */ }

    // Send initial version — flush immediately so Nginx/proxies see activity
    res.write(`data: ${JSON.stringify({ type: 'version', version: rankingsCache.getDataVersion() })}\n\n`)
    if (typeof res.flush === 'function') res.flush()

    sseClients.add(res)
    ipConns.add(res)

    // Keepalive every 20s — flush so proxies don't consider the connection idle
    const keepAlive = setInterval(() => {
      res.write(': keepalive\n\n')
      if (typeof res.flush === 'function') res.flush()
    }, 20000)

    req.on('close', () => {
      clearInterval(keepAlive)
      sseClients.delete(res)
      ipConns.delete(res)
      if (ipConns.size === 0) ipConnections.delete(clientIP)
    })
  })

  // R4: CSP violation report endpoint — rate limited to prevent log flooding.
  // Accepts CSP violation reports from browsers. Body is limited to 1KB
  // (enforced app-level in server.js BEFORE the global parser — a parser here
  // would be a no-op) to prevent log flooding. Only logs valid JSON objects.
  router.post('/api/csp-report', cspReportLimiter, (req, res) => {
    const report = req.body?.['csp-report'] || req.body
    if (report && typeof report === 'object') {
      console.warn('⚠️ CSP Violation:', JSON.stringify(report, null, 2))
    }
    res.status(204).end()
  })

  // ── Debug config (subpath / proxy debugging) — admin only ─────────────────
  // DISABLED in production: exposes subpath, NODE_ENV, proxy headers, topology.
  router.get('/api/debug/config', authenticateToken, requireAdmin, (req, res) => {
    if (config.isProduction) {
      return res.status(404).json({ error: 'Debug endpoint disabled in production' })
    }
    const currentIP = getRealClientIP(req)
    res.json({
      success: true,
      serverConfig: {
        subpath: SUBPATH,
        isDevelopment: config.isDevelopment,
        nodeEnv: config.nodeEnv,
        publicDomain: config.publicDomain,
        trustProxy: app.get('trust proxy') !== false,
        behindProxy: process.env.BEHIND_PROXY === 'true'
      },
      requestInfo: {
        method: req.method, url: req.url, originalUrl: req.originalUrl,
        path: req.path, baseUrl: req.baseUrl, protocol: req.protocol,
        secure: req.secure, clientIP: currentIP, userAgent: req.get('User-Agent')
      },
      proxyHeaders: {
        host: req.get('Host'), xForwardedHost: req.get('X-Forwarded-Host'),
        xForwardedProto: req.get('X-Forwarded-Proto'), xForwardedFor: req.get('X-Forwarded-For'),
        xRealIP: req.get('X-Real-IP'), cfConnectingIP: req.get('CF-Connecting-IP')
      },
      apiRouting: {
        subpathAPI: `${SUBPATH}/api`, directAPI: '/api',
        recommendedFrontendAPIBase: req.get('Host')
          ? `${req.protocol}://${req.get('Host')}${SUBPATH}/api`
          : `${req.protocol}://${req.get('X-Forwarded-Host') || 'localhost'}${SUBPATH}/api`
      },
      user: req.user || null,
      timestamp: formatSecureTimestamp()
    })
  })

  // Export interval for graceful shutdown (clears stale SSE references).
  Object.defineProperty(router, 'sseCleanupInterval', {
    value: sseCleanupInterval,
    enumerable: false
  })
  return router
}
