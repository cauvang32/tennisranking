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
    const players = await db.getPlayers()
    res.json(sanitizeResponse(players))
  }))

  router.post(
    '/',
    authenticateToken,
    requireAdmin,
    conditionalRateLimit(createLimiter),
    [
      body('name').isLength({ min: 1, max: 100 }).withMessage('Player name is required')
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const { name } = req.body
      try {
        const playerId = await db.addPlayer(name)
        rankingsCache.clear()
        setTimeout(() => rankingsCache.preloadCommonData(db), 100)
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
      rankingsCache.clear()
      setTimeout(() => rankingsCache.preloadCommonData(db), 100)
      res.json({ success: true, message: 'Player removed successfully' })
    })
  )

  return router
}
