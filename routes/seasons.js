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
    const seasons = await db.getSeasons()
    res.json(seasons)
  }))

  router.get('/active', checkAuth, asyncHandler(async (req, res) => {
    const seasons = await db.getActiveSeasons()
    res.json(seasons)
  }))

  router.get('/active-one', checkAuth, asyncHandler(async (req, res) => {
    const activeSeason = await db.getActiveSeason()
    res.json(activeSeason)
  }))

  router.post(
    '/',
    authenticateToken,
    requireAdmin,
    conditionalRateLimit(createLimiter),
    [
      body('name').isLength({ min: 1, max: 100 }).withMessage('Season name is required'),
      body('startDate').isISO8601().withMessage('Valid start date is required'),
      body('endDate').optional({ nullable: true, checkFalsy: true }).isISO8601().withMessage('Valid end date is required'),
      body('autoEnd').optional().isBoolean().withMessage('autoEnd must be boolean'),
      body('description').optional({ nullable: true, checkFalsy: true }).isString().withMessage('Description must be string')
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      let { name, startDate, endDate, autoEnd = false, description = '' } = req.body
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

      const seasonId = await db.createSeason(name, startDate, endDate, autoEnd, description)
      rankingsCache.clear()
      setTimeout(() => rankingsCache.preloadCommonData(db), 100)

      res.json({ success: true, id: seasonId, name, startDate, endDate, autoEnd, description })
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
      body('description').optional({ nullable: true, checkFalsy: true }).isString().withMessage('Description must be string')
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const seasonId = parseInt(req.params.id)
      let { name, startDate, endDate, autoEnd = false, description = '' } = req.body
      endDate = endDate || null
      description = description || ''

      if (autoEnd && !endDate) {
        res.status(400).json({ success: false, error: 'Auto-end requires an end date to be set' })
        return
      }

      await db.updateSeason(seasonId, name, startDate, endDate, autoEnd, description)
      rankingsCache.clear()
      setTimeout(() => rankingsCache.preloadCommonData(db), 100)
      res.json({ success: true, message: 'Season updated successfully' })
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
      rankingsCache.clear()
      setTimeout(() => rankingsCache.preloadCommonData(db), 100)
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
      rankingsCache.clear()
      setTimeout(() => rankingsCache.preloadCommonData(db), 100)
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
      rankingsCache.clear()
      setTimeout(() => rankingsCache.preloadCommonData(db), 100)
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
        rankingsCache.clear()
        setTimeout(() => rankingsCache.preloadCommonData(db), 100)
      }
      res.json({ success: true, ended: expiredSeasons.length, seasons: expiredSeasons })
    })
  )

  return router
}
