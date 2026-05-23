import { Router } from 'express'
import config from '../config/env.js'
import { deriveCSRFSecret, ensureCSRFCookie, tokens } from '../middleware/csrf.js'
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
  rankingsCache,
  sseClients,
  formatSecureTimestamp,
  sanitizeResponse
}) => {
  const router = Router()
  const SUBPATH = config.subpath

  // ── CSRF token endpoint ───────────────────────────────────────────────────
  router.get('/api/csrf-token', (req, res) => {
    const sessionId = ensureCSRFCookie(req, res)
    const csrfSecret = deriveCSRFSecret(sessionId)
    const csrfToken = tokens.create(csrfSecret)
    res.json({ csrfToken })
  })

  router.post('/api/csrf-token', (req, res) => {
    const sessionId = ensureCSRFCookie(req, res)
    const csrfSecret = deriveCSRFSecret(sessionId)
    const csrfToken = tokens.create(csrfSecret)
    res.json({ csrfToken })
  })

  // ── Data version (for client cache sync) ──────────────────────────────────
  router.get('/api/data-version', checkAuth, (_req, res) => {
    res.json({ version: rankingsCache.getDataVersion() })
  })

  // ── Init endpoint (bootstrap data for frontend) ──────────────────────────
  router.get('/api/init', checkAuth, async (req, res) => {
    try {
      const { data: rankings, hit: rankingsHit } = await rankingsCache.getOrSet(
        'rankings:lifetime', () => db.getPlayerStatsWithFormsLifetime(5)
      )
      const { data: players, hit: playersHit } = await rankingsCache.getOrSet(
        'players', () => db.getPlayers()
      )
      const { data: seasons, hit: seasonsHit } = await rankingsCache.getOrSet(
        'seasons', () => db.getSeasons()
      )
      const { data: activeSeasons, hit: activeSeasonsHit } = await rankingsCache.getOrSet(
        'seasons:active', () => db.getActiveSeasons()
      )
      const { data: playDates, hit: playDatesHit } = await rankingsCache.getOrSet(
        'playdates', () => db.getPlayDates()
      )
      const { data: activeSeason, hit: activeSeasonHit } = await rankingsCache.getOrSet(
        'season:active', () => db.getActiveSeason()
      )

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
      const sessionId = ensureCSRFCookie(req, res)
      initData.csrfToken = tokens.create(deriveCSRFSecret(sessionId))

      const hitCount = [rankingsHit, playersHit, seasonsHit, activeSeasonsHit, playDatesHit, activeSeasonHit].filter(Boolean).length
      res.set('Redis-Cache', `${hitCount}/6`)
      res.json(initData)
    } catch (error) {
      console.error('Error in init endpoint:', error)
      res.status(500).json({ error: 'Failed to initialize application data' })
    }
  })

  // ── SSE — Server-Sent Events for real-time updates ────────────────────────
  // Open to all users (authenticated or not) — only broadcasts version numbers
  router.get('/api/events', checkAuth, (req, res) => {
    if (sseClients.size >= config.maxSseClients) {
      return res.status(503).json({ error: 'Too many SSE connections' })
    }

    // Disable request timeout for SSE (otherwise middleware timeout kills it)
    if (req.setTimeout) req.setTimeout(0)
    if (res.setTimeout) res.setTimeout(0)

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no') // Nginx: don't buffer SSE
    res.flushHeaders()

    // Send initial version
    res.write(`data: ${JSON.stringify({ type: 'version', version: rankingsCache.getDataVersion() })}\n\n`)

    sseClients.add(res)

    // Keepalive every 20s (must be less than any proxy idle timeout, typically 30-60s)
    const keepAlive = setInterval(() => { res.write(': keepalive\n\n') }, 20000)

    req.on('close', () => {
      clearInterval(keepAlive)
      sseClients.delete(res)
    })
  })

  // ── CSP violation report endpoint ─────────────────────────────────────────
  router.post('/api/csp-report', (req, res) => {
    const report = req.body?.['csp-report'] || req.body
    if (report) {
      console.warn('⚠️ CSP Violation:', JSON.stringify(report, null, 2))
    }
    res.status(204).end()
  })

  // ── Debug config (subpath / proxy debugging) — admin only ─────────────────
  router.get('/api/debug/config', authenticateToken, requireAdmin, (req, res) => {
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

  return router
}
