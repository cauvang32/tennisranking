import { Router } from 'express'
import { body, param, query } from 'express-validator'
import { asyncHandler } from '../utils/async-handler.js'
import { streamJsonResponse } from '../utils/stream-helper.js'

export const createMatchRouter = ({
  db,
  checkAuth,
  authenticateToken,
  requireEditor,
  conditionalRateLimit,
  createLimiter,
  deleteLimiter,
  handleValidationErrors,
  rankingsCache,
  sanitizeResponse
}) => {
  const router = Router()

  // SQL for match listing (shared between cached and streamed paths)
  const MATCHES_LIST_SQL = `
    SELECT m.id, m.season_id, TO_CHAR(m.play_date, 'YYYY-MM-DD') as play_date,
      m.player1_id, m.player2_id, m.player3_id, m.player4_id,
      m.team1_score, m.team2_score, m.winning_team, 
      COALESCE(m.match_type, 'duo') as match_type,
      m.created_at,
      s.name as season_name,
      COALESCE(s.lose_money_per_loss, 20000) as lose_money_per_loss,
      p1.name as player1_name, COALESCE(p2.name, '') as player2_name, 
      p3.name as player3_name, COALESCE(p4.name, '') as player4_name
    FROM matches m
    JOIN seasons s ON m.season_id = s.id
    JOIN players p1 ON m.player1_id = p1.id
    LEFT JOIN players p2 ON m.player2_id = p2.id
    JOIN players p3 ON m.player3_id = p3.id
    LEFT JOIN players p4 ON m.player4_id = p4.id
    ORDER BY m.play_date DESC, m.created_at DESC
  `

  router.get('/', checkAuth, [
    query('limit').optional().isInt({ min: 1, max: 1000 }).withMessage('Limit must be between 1 and 1000')
  ], handleValidationErrors, asyncHandler(async (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit) : null

    // For bounded requests (with limit), use the cached path
    if (limit) {
      const cacheKey = `matches:list:${limit}`
      const { data: matches, hit: cacheHit } = await rankingsCache.getOrSet(
        cacheKey,
        () => db.getMatches(limit)
      )
      res.set('Redis-Cache', cacheHit ? 'HIT' : 'MISS')
      return res.json(sanitizeResponse(matches))
    }

    // For unbounded requests (no limit), try cache first, then stream
    const cacheKey = 'matches:list:all'
    const cached = await rankingsCache.get(cacheKey)
    if (cached) {
      res.set('Redis-Cache', 'HIT')
      return res.json(sanitizeResponse(cached))
    }

    // Stream directly from DB → HTTP response (constant memory)
    res.set('Redis-Cache', 'MISS')
    await streamJsonResponse(db.pool, MATCHES_LIST_SQL, [], res, { sanitize: sanitizeResponse })
  }))

  router.get('/by-date/:date', checkAuth, [
    param('date').isISO8601().withMessage('Valid date required (YYYY-MM-DD)')
  ], handleValidationErrors, asyncHandler(async (req, res) => {
    const { date } = req.params
    const cacheKey = `matches:date:${date}`
    const { data: matches, hit: cacheHit } = await rankingsCache.getOrSet(
      cacheKey,
      () => db.getMatchesByPlayDate(date)
    )
    res.set('Redis-Cache', cacheHit ? 'HIT' : 'MISS')
    res.json(sanitizeResponse(matches))
  }))

  router.get('/by-season/:seasonId', checkAuth, [
    param('seasonId').isInt({ min: 1 }).withMessage('Invalid season ID')
  ], handleValidationErrors, asyncHandler(async (req, res) => {
    const seasonId = parseInt(req.params.seasonId)
    const cacheKey = `matches:season:${seasonId}`
    const { data: matches, hit: cacheHit } = await rankingsCache.getOrSet(
      cacheKey,
      () => db.getMatchesBySeason(seasonId)
    )
    res.set('Redis-Cache', cacheHit ? 'HIT' : 'MISS')
    res.json(sanitizeResponse(matches))
  }))

  router.get('/:id', checkAuth, [param('id').isInt().withMessage('Invalid match ID')], handleValidationErrors, asyncHandler(async (req, res) => {
    const matchId = parseInt(req.params.id)
    const cacheKey = `match:${matchId}`
    const { data: match, hit: cacheHit } = await rankingsCache.getOrSet(
      cacheKey,
      async () => {
        const result = await db.getMatchById(matchId)
        // Return sentinel value for not-found so we don't cache null
        return result || { __notFound: true }
      }
    )
    if (!match || match.__notFound) {
      res.status(404).json({ error: 'Match not found' })
      return
    }
    res.set('Redis-Cache', cacheHit ? 'HIT' : 'MISS')
    res.json(sanitizeResponse(match))
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
        await rankingsCache.invalidateOnMatchChange(playDate)
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
        await rankingsCache.invalidateOnMatchChange(playDate)
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
      
      await rankingsCache.invalidateOnMatchChange(playDate)
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
      const matchDate = existingMatch.play_date
      await db.deleteMatch(matchId)
      await rankingsCache.invalidateOnMatchChange(matchDate)
      res.json({ success: true, message: 'Match deleted successfully' })
    })
  )

  router.get('/play-dates/list', checkAuth, asyncHandler(async (req, res) => {
    const { data: playDates, hit: cacheHit } = await rankingsCache.getOrSet(
      'playdates',
      () => db.getPlayDates()
    )
    res.set('Redis-Cache', cacheHit ? 'HIT' : 'MISS')
    res.json(playDates)
  }))

  router.get('/play-dates/latest', checkAuth, asyncHandler(async (req, res) => {
    const { data: latestDate, hit: cacheHit } = await rankingsCache.getOrSet(
      'playdate:latest',
      () => db.getLatestPlayDate()
    )
    res.set('Redis-Cache', cacheHit ? 'HIT' : 'MISS')
    res.json({ playDate: latestDate })
  }))

  return router
}
