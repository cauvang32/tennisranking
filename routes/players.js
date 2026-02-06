import { Router } from 'express'
import { body, param } from 'express-validator'
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
      () => db.getPlayers()
    )
    res.set('X-Cache', cacheHit ? 'HIT' : 'MISS')
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
        .escape() // Escape HTML entities to prevent XSS
        .isLength({ min: 1, max: 100 }).withMessage('Player name is required')
        .matches(/^[a-zA-Z0-9\s\u0080-\uFFFF]+$/).withMessage('Player name contains invalid characters')
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const { name } = req.body
      try {
        const playerId = await db.addPlayer(name)
        await rankingsCache.invalidateOnPlayerChange()
        res.json({ success: true, id: playerId, name })
      } catch (error) {
        if (error.message.includes('UNIQUE constraint failed')) {
          res.status(400).json({ error: 'Player name already exists' })
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
      await rankingsCache.invalidateOnPlayerChange()
      res.json({ success: true, message: 'Player removed successfully' })
    })
  )

  return router
}
