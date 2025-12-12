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

  // Validation for match payload - player2 and player4 are optional for solo matches
  const validateMatchPayload = [
    body('seasonId').isInt().withMessage('Valid season ID is required'),
    body('playDate').isISO8601().withMessage('Valid play date is required'),
    body('player1Id').isInt().withMessage('Valid player 1 ID is required'),
    body('player2Id').optional({ nullable: true }).isInt().withMessage('Valid player 2 ID is required for duo matches'),
    body('player3Id').isInt().withMessage('Valid player 3 ID is required'),
    body('player4Id').optional({ nullable: true }).isInt().withMessage('Valid player 4 ID is required for duo matches'),
    body('team1Score').isInt({ min: 0 }).withMessage('Valid team 1 score is required'),
    body('team2Score').isInt({ min: 0 }).withMessage('Valid team 2 score is required'),
    body('winningTeam').isInt({ min: 1, max: 2 }).withMessage('Winning team must be 1 or 2'),
    body('matchType').optional().isIn(['solo', 'duo']).withMessage('Match type must be solo or duo')
  ]

  // Helper function to validate players are in season
  const validatePlayersInSeason = async (seasonId, playerIds) => {
    const seasonPlayers = await db.getSeasonPlayers(seasonId)
    const seasonPlayerIds = seasonPlayers.map(p => p.id)
    
    // If season has no assigned players, allow all (backward compatibility)
    if (seasonPlayerIds.length === 0) {
      return { valid: true }
    }

    const invalidPlayers = playerIds.filter(id => id && !seasonPlayerIds.includes(id))
    if (invalidPlayers.length > 0) {
      return { 
        valid: false, 
        error: `Players ${invalidPlayers.join(', ')} are not eligible for this season`
      }
    }
    return { valid: true }
  }

  router.post(
    '/',
    authenticateToken,
    requireEditor,
    conditionalRateLimit(createLimiter),
    validateMatchPayload,
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const { seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam, matchType = 'duo' } = req.body
      
      // For solo matches, only player1 and player3 are required (they are the opponents)
      if (matchType === 'solo') {
        if (!player1Id || !player3Id) {
          res.status(400).json({ error: 'For solo matches, player 1 and player 3 are required' })
          return
        }
        if (player1Id === player3Id) {
          res.status(400).json({ error: 'Players must be different' })
          return
        }
        
        // Validate players are in season
        const validation = await validatePlayersInSeason(seasonId, [player1Id, player3Id])
        if (!validation.valid) {
          res.status(400).json({ error: validation.error })
          return
        }
        
        // For solo matches, player2 and player4 are null
        const matchId = await db.addMatch(seasonId, playDate, player1Id, null, player3Id, null, team1Score, team2Score, winningTeam, matchType)
        rankingsCache.clear()
        setTimeout(() => rankingsCache.preloadCommonData(db), 100)
        res.json({ success: true, id: matchId })
      } else {
        // Duo match validation (existing logic)
        const playerIds = [player1Id, player2Id, player3Id, player4Id]
        if (new Set(playerIds).size !== 4) {
          res.status(400).json({ error: 'All players must be different' })
          return
        }
        
        // Validate players are in season
        const validation = await validatePlayersInSeason(seasonId, playerIds)
        if (!validation.valid) {
          res.status(400).json({ error: validation.error })
          return
        }
        
        const matchId = await db.addMatch(seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam, matchType)
        rankingsCache.clear()
        setTimeout(() => rankingsCache.preloadCommonData(db), 100)
        res.json({ success: true, id: matchId })
      }
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
      const { seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam, matchType = 'duo' } = req.body
      
      if (matchType === 'solo') {
        if (!player1Id || !player3Id) {
          res.status(400).json({ error: 'For solo matches, player 1 and player 3 are required' })
          return
        }
        if (player1Id === player3Id) {
          res.status(400).json({ error: 'Players must be different' })
          return
        }
        
        // Validate players are in season
        const validation = await validatePlayersInSeason(seasonId, [player1Id, player3Id])
        if (!validation.valid) {
          res.status(400).json({ error: validation.error })
          return
        }
        
        await db.updateMatch(matchId, seasonId, playDate, player1Id, null, player3Id, null, team1Score, team2Score, winningTeam, matchType)
      } else {
        const playerIds = [player1Id, player2Id, player3Id, player4Id]
        if (new Set(playerIds).size !== 4) {
          res.status(400).json({ error: 'All players must be different' })
          return
        }
        
        // Validate players are in season
        const validation = await validatePlayersInSeason(seasonId, playerIds)
        if (!validation.valid) {
          res.status(400).json({ error: validation.error })
          return
        }
        
        await db.updateMatch(matchId, seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam, matchType)
      }
      
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
