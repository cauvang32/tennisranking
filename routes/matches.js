import { Router } from 'express'
import { body, param } from 'express-validator'
import { asyncHandler } from '../utils/async-handler.js'

export const createMatchRouter = ({
  db,
  checkAuth,
  authenticateToken,
  requireEditor,
  conditionalRateLimit,
  createLimiter,
  deleteLimiter,
  handleValidationErrors,
  rankingsCache
}) => {
  const router = Router()

  router.get('/', checkAuth, asyncHandler(async (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit) : null
    const matches = await db.getMatches(limit)
    res.json(matches)
  }))

  router.get('/by-date/:date', checkAuth, asyncHandler(async (req, res) => {
    const { date } = req.params
    const matches = await db.getMatchesByPlayDate(date)
    res.json(matches)
  }))

  router.get('/by-season/:seasonId', checkAuth, asyncHandler(async (req, res) => {
    const seasonId = parseInt(req.params.seasonId)
    const matches = await db.getMatchesBySeason(seasonId)
    res.json(matches)
  }))

  router.get('/:id', checkAuth, [param('id').isInt().withMessage('Invalid match ID')], handleValidationErrors, asyncHandler(async (req, res) => {
    const matchId = parseInt(req.params.id)
    const match = await db.getMatchById(matchId)
    if (!match) {
      res.status(404).json({ error: 'Match not found' })
      return
    }
    res.json(match)
  }))

  const validateMatchPayload = [
    body('seasonId').isInt().withMessage('Valid season ID is required'),
    body('playDate').isISO8601().withMessage('Valid play date is required'),
    body('player1Id').isInt().withMessage('Valid player 1 ID is required'),
    body('player2Id').isInt().withMessage('Valid player 2 ID is required'),
    body('player3Id').isInt().withMessage('Valid player 3 ID is required'),
    body('player4Id').isInt().withMessage('Valid player 4 ID is required'),
    body('team1Score').isInt({ min: 0 }).withMessage('Valid team 1 score is required'),
    body('team2Score').isInt({ min: 0 }).withMessage('Valid team 2 score is required'),
    body('winningTeam').isInt({ min: 1, max: 2 }).withMessage('Winning team must be 1 or 2')
  ]

  router.post(
    '/',
    authenticateToken,
    requireEditor,
    conditionalRateLimit(createLimiter),
    validateMatchPayload,
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const { seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam } = req.body
      const playerIds = [player1Id, player2Id, player3Id, player4Id]
      if (new Set(playerIds).size !== 4) {
        res.status(400).json({ error: 'All players must be different' })
        return
      }
      const matchId = await db.addMatch(seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam)
      rankingsCache.clear()
      setTimeout(() => rankingsCache.preloadCommonData(db), 100)
      res.json({ success: true, id: matchId })
    })
  )

  router.put(
    '/:id',
    authenticateToken,
    requireEditor,
    [param('id').isInt().withMessage('Invalid match ID'), ...validateMatchPayload],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const matchId = parseInt(req.params.id)
      const existingMatch = await db.getMatchById(matchId)
      if (!existingMatch) {
        res.status(404).json({ error: 'Match not found' })
        return
      }
      const { seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam } = req.body
      const playerIds = [player1Id, player2Id, player3Id, player4Id]
      if (new Set(playerIds).size !== 4) {
        res.status(400).json({ error: 'All players must be different' })
        return
      }
      await db.updateMatch(matchId, seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam)
      rankingsCache.clear()
      setTimeout(() => rankingsCache.preloadCommonData(db), 100)
      res.json({ success: true, message: 'Match updated successfully' })
    })
  )

  router.delete(
    '/:id',
    authenticateToken,
    requireEditor,
    conditionalRateLimit(deleteLimiter),
    [param('id').isInt().withMessage('Invalid match ID')],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const matchId = parseInt(req.params.id)
      const existingMatch = await db.getMatchById(matchId)
      if (!existingMatch) {
        res.status(404).json({ error: 'Match not found' })
        return
      }
      await db.deleteMatch(matchId)
      rankingsCache.clear()
      setTimeout(() => rankingsCache.preloadCommonData(db), 100)
      res.json({ success: true, message: 'Match deleted successfully' })
    })
  )

  router.get('/play-dates/list', checkAuth, asyncHandler(async (req, res) => {
    const playDates = await db.getPlayDates()
    res.json(playDates)
  }))

  router.get('/play-dates/latest', checkAuth, asyncHandler(async (req, res) => {
    const latestDate = await db.getLatestPlayDate()
    res.json({ playDate: latestDate })
  }))

  return router
}
