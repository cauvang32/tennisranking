import { Router } from 'express'
import { body, param } from 'express-validator'
import config from '../config/env.js'
import { asyncHandler } from '../utils/async-handler.js'

export const createPlayerRouter = ({
  db,
  checkAuth,
  authenticateToken,
  requireAdmin,
  conditionalRateLimit,
  createLimiter,
  deleteLimiter,
  handleValidationErrors,
  rankingsCache,
  sanitizeResponse
}) => {
  const router = Router()

  router.get('/', checkAuth, asyncHandler(async (req, res) => {
    const { data: players, hit: cacheHit } = await rankingsCache.getOrSet(
      'players',
      () => db.getPlayers(100)
    )
    // Only expose Redis-Cache headers in development for debugging
    if (!config.isProduction) res.set('Redis-Cache', cacheHit ? 'HIT' : 'MISS')
    res.json(sanitizeResponse(players))
  }))

  router.post(
    '/',
    authenticateToken,
    requireAdmin,
    conditionalRateLimit(createLimiter),
    [
      body('name')
        .trim()
        .isLength({ min: 1, max: 100 }).withMessage('Player name is required')
        // C3: Use space + name chars only (not \s which matches \n/\r/\t \u2014 log injection vector)
        // L5: Allow hyphens, apostrophes, periods for names like "O'Connor", "Mary-Jane", "Dr. Smith"
        .matches(/^[ a-zA-Z0-9\u00C0-\uFFFF\-.']+$/).withMessage('Player name contains invalid characters')
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const { name } = req.body
      try {
        const playerId = await db.addPlayer(name)
        await rankingsCache.invalidateOnPlayerChange()
        res.json({ success: true, id: playerId, name })
      } catch (error) {
        if (error.message.includes('UNIQUE constraint failed') || error.code === '23505') {
          res.status(409).json({ error: 'Tên người chơi đã tồn tại' })
          return
        }
        throw error
      }
    })
  )

  router.delete(
    '/:id',
    authenticateToken,
    requireAdmin,
    conditionalRateLimit(deleteLimiter),
    [param('id').isInt().withMessage('Invalid player ID')],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const playerId = parseInt(req.params.id)
      await db.removePlayer(playerId)
      try { await rankingsCache.invalidateOnPlayerChange() } catch (err) {
        console.error('Cache invalidation failed after player delete:', err.message)
      }
      try { await rankingsCache.invalidateOnMatchChange() } catch (err) {
        console.error('Cache invalidation failed after player delete:', err.message)
      }
      res.json({ success: true, message: 'Player removed successfully' })
    })
  )

  return router
}
