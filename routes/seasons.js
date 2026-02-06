import { Router } from 'express'
import { body, param } from 'express-validator'
import { asyncHandler } from '../utils/async-handler.js'

export const createSeasonRouter = ({
  db,
  checkAuth,
  authenticateToken,
  requireAdmin,
  requireEditor,
  conditionalRateLimit,
  createLimiter,
  deleteLimiter,
  handleValidationErrors,
  rankingsCache
}) => {
  const router = Router()

  router.get('/', checkAuth, asyncHandler(async (req, res) => {
    const { data: seasons, hit: cacheHit } = await rankingsCache.getOrSet(
      'seasons',
      () => db.getSeasons()
    )
    res.set('Redis-Cache', cacheHit ? 'HIT' : 'MISS')
    res.json(seasons)
  }))

  router.get('/active', checkAuth, asyncHandler(async (req, res) => {
    const { data: seasons, hit: cacheHit } = await rankingsCache.getOrSet(
      'seasons:active',
      () => db.getActiveSeasons()
    )
    res.set('Redis-Cache', cacheHit ? 'HIT' : 'MISS')
    res.json(seasons)
  }))

  router.get('/active-one', checkAuth, asyncHandler(async (req, res) => {
    const { data: activeSeason, hit: cacheHit } = await rankingsCache.getOrSet(
      'season:active',
      () => db.getActiveSeason()
    )
    res.set('Redis-Cache', cacheHit ? 'HIT' : 'MISS')
    res.json(activeSeason)
  }))

  // Get players assigned to a specific season
  router.get('/:id/players', checkAuth, [
    param('id').isInt().withMessage('Invalid season ID')
  ], handleValidationErrors, asyncHandler(async (req, res) => {
    const seasonId = parseInt(req.params.id)
    const cacheKey = `season:${seasonId}:players`
    const { data: players, hit: cacheHit } = await rankingsCache.getOrSet(
      cacheKey,
      () => db.getSeasonPlayers(seasonId)
    )
    res.set('Redis-Cache', cacheHit ? 'HIT' : 'MISS')
    res.json(players)
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
        .isLength({ min: 1, max: 100 }).withMessage('Season name is required')
        .matches(/^[a-zA-Z0-9\s\u0080-\uFFFF.,-]+$/).withMessage('Season name contains invalid characters'),
      body('startDate').isISO8601().withMessage('Valid start date is required'),
      body('endDate').optional({ nullable: true, checkFalsy: true }).isISO8601().withMessage('Valid end date is required'),
      body('autoEnd').optional().isBoolean().withMessage('autoEnd must be boolean'),
      body('description').optional({ nullable: true, checkFalsy: true }).isString().withMessage('Description must be string'),
      body('loseMoneyPerLoss').optional().isInt({ min: 0 }).withMessage('Lose money must be a non-negative integer'),
      body('playerIds').optional().isArray().withMessage('Player IDs must be an array'),
      body('playerIds.*').optional().isInt().withMessage('Player ID must be an integer')
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      let { name, startDate, endDate, autoEnd = false, description = '', loseMoneyPerLoss = 20000, playerIds = [] } = req.body
      endDate = endDate || null
      description = description || ''

      if (autoEnd && !endDate) {
        res.status(400).json({ success: false, error: 'Auto-end requires an end date to be set' })
        return
      }

      const expiredSeasons = await db.checkAndEndExpiredSeasons()
      if (expiredSeasons.length > 0) {
        console.log(`🏁 Auto-ended ${expiredSeasons.length} expired season(s)`)
      }

      const seasonId = await db.createSeason(name, startDate, endDate, autoEnd, description, loseMoneyPerLoss, playerIds)
      await rankingsCache.invalidateOnSeasonChange()

      res.json({ success: true, id: seasonId, name, startDate, endDate, autoEnd, description, loseMoneyPerLoss, playerIds })
    })
  )

  router.put(
    '/:id',
    authenticateToken,
    requireAdmin,
    [
      param('id').isInt().withMessage('Invalid season ID'),
      body('name').isLength({ min: 1, max: 100 }).withMessage('Season name is required'),
      body('startDate').isISO8601().withMessage('Valid start date is required'),
      body('endDate').optional({ nullable: true, checkFalsy: true }).isISO8601().withMessage('Valid end date is required'),
      body('autoEnd').optional().isBoolean().withMessage('autoEnd must be boolean'),
      body('description').optional({ nullable: true, checkFalsy: true }).isString().withMessage('Description must be string'),
      body('loseMoneyPerLoss').optional().isInt({ min: 0 }).withMessage('Lose money must be a non-negative integer')
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const seasonId = parseInt(req.params.id)
      let { name, startDate, endDate, autoEnd = false, description = '', loseMoneyPerLoss = null } = req.body
      endDate = endDate || null
      description = description || ''

      if (autoEnd && !endDate) {
        res.status(400).json({ success: false, error: 'Auto-end requires an end date to be set' })
        return
      }

      await db.updateSeason(seasonId, name, startDate, endDate, autoEnd, description, loseMoneyPerLoss)
      await rankingsCache.invalidateOnSeasonChange()
      res.json({ success: true, message: 'Season updated successfully' })
    })
  )

  // Add players to a season
  router.post(
    '/:id/players',
    authenticateToken,
    requireEditor,
    [
      param('id').isInt().withMessage('Invalid season ID'),
      body('playerIds').isArray({ min: 1 }).withMessage('Player IDs must be a non-empty array'),
      body('playerIds.*').isInt().withMessage('Player ID must be an integer')
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const seasonId = parseInt(req.params.id)
      const { playerIds } = req.body
      const addedBy = req.user?.username || 'admin'

      const season = await db.getSeasonById(seasonId)
      if (!season) {
        res.status(404).json({ success: false, error: 'Season not found' })
        return
      }

      await db.setSeasonPlayers(seasonId, playerIds, addedBy)
      await rankingsCache.invalidateOnSeasonChange()
      res.json({ success: true, message: 'Season players updated successfully' })
    })
  )

  // Add single player to a season
  router.post(
    '/:id/players/:playerId',
    authenticateToken,
    requireEditor,
    [
      param('id').isInt().withMessage('Invalid season ID'),
      param('playerId').isInt().withMessage('Invalid player ID')
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const seasonId = parseInt(req.params.id)
      const playerId = parseInt(req.params.playerId)
      const addedBy = req.user?.username || 'admin'

      const season = await db.getSeasonById(seasonId)
      if (!season) {
        res.status(404).json({ success: false, error: 'Season not found' })
        return
      }

      await db.addPlayerToSeason(seasonId, playerId, addedBy)
      await rankingsCache.invalidateOnSeasonChange()
      res.json({ success: true, message: 'Player added to season successfully' })
    })
  )

  // Remove player from a season
  router.delete(
    '/:id/players/:playerId',
    authenticateToken,
    requireEditor,
    [
      param('id').isInt().withMessage('Invalid season ID'),
      param('playerId').isInt().withMessage('Invalid player ID')
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const seasonId = parseInt(req.params.id)
      const playerId = parseInt(req.params.playerId)

      await db.removePlayerFromSeason(seasonId, playerId)
      await rankingsCache.invalidateOnSeasonChange()
      res.json({ success: true, message: 'Player removed from season successfully' })
    })
  )

  router.post(
    '/:id/end',
    authenticateToken,
    requireEditor,
    [
      param('id').isInt().withMessage('Invalid season ID'),
      body('endDate').optional().isISO8601().withMessage('Valid end date is required')
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const seasonId = parseInt(req.params.id)
      const endDate = req.body.endDate || new Date().toISOString().split('T')[0]
      const endedBy = req.user.username
      await db.endSeason(seasonId, endDate, endedBy)
      await rankingsCache.invalidateOnSeasonChange()
      res.json({ success: true, message: 'Season ended successfully' })
    })
  )

  router.post(
    '/:id/reactivate',
    authenticateToken,
    requireEditor,
    [param('id').isInt().withMessage('Invalid season ID')],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const seasonId = parseInt(req.params.id)
      const username = req.user?.username || 'unknown'
      const season = await db.getSeasonById(seasonId)
      if (!season) {
        res.status(404).json({ success: false, error: 'Season not found' })
        return
      }
      if (season.is_active) {
        res.status(400).json({ success: false, error: 'Season is already active' })
        return
      }
      await db.reactivateSeason(seasonId)
      await rankingsCache.invalidateOnSeasonChange()
      console.log(`✅ Season ${seasonId} reactivated by ${username}`)
      res.json({ success: true, message: 'Season reactivated successfully' })
    })
  )

  router.delete(
    '/:id',
    authenticateToken,
    requireAdmin,
    conditionalRateLimit(deleteLimiter),
    [param('id').isInt().withMessage('Invalid season ID')],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const seasonId = parseInt(req.params.id)
      const season = await db.getSeasonById(seasonId)
      if (!season) {
        res.status(404).json({ error: 'Season not found' })
        return
      }
      if (season.is_active) {
        res.status(400).json({ error: 'Cannot delete active season. Please end the season first.' })
        return
      }
      await db.deleteSeason(seasonId)
      await rankingsCache.invalidateOnSeasonChange()
      res.json({ success: true, message: 'Season deleted successfully' })
    })
  )

  router.post(
    '/check-expired',
    authenticateToken,
    requireEditor,
    asyncHandler(async (req, res) => {
      const expiredSeasons = await db.checkAndEndExpiredSeasons()
      if (expiredSeasons.length > 0) {
        await rankingsCache.invalidateOnSeasonChange()
      }
      res.json({ success: true, ended: expiredSeasons.length, seasons: expiredSeasons })
    })
  )

  return router
}
