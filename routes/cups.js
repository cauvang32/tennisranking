import { Router } from 'express'
import { body, param } from 'express-validator'
import config from '../config/env.js'
import { asyncHandler } from '../utils/async-handler.js'

export const createCupRouter = ({
  db,
  checkAuth,
  authenticateToken,
  requireAdmin,
  requireEditor,
  conditionalRateLimit,
  createLimiter,
  deleteLimiter,
  handleValidationErrors,
  rankingsCache,
  sanitizeResponse,
}) => {
  const router = Router()

  // ── Public reads (auth required, no admin needed) ──────────────────────

  router.get('/', checkAuth, asyncHandler(async (req, res) => {
    const { data: cups, hit: cacheHit } = await rankingsCache.getOrSet(
      'cups',
      () => db.getCups(100)
    )
    if (!config.isProduction) res.set('Redis-Cache', cacheHit ? 'HIT' : 'MISS')
    res.json(sanitizeResponse(cups || []))
  }))

  router.get('/:id', checkAuth, [
    param('id').isInt().withMessage('Invalid cup ID')
  ], handleValidationErrors, asyncHandler(async (req, res) => {
    const cupId = parseInt(req.params.id)
    const cacheKey = `cup:${cupId}`
    const { data: cup, hit: cacheHit } = await rankingsCache.getOrSet(
      cacheKey,
      () => db.getCupById(cupId)
    )
    if (!cup) {
      return res.status(404).json({ error: 'Cup not found' })
    }
    if (!config.isProduction) res.set('Redis-Cache', cacheHit ? 'HIT' : 'MISS')
    res.json(sanitizeResponse(cup))
  }))

  // Bracket (match structure) — public read
  router.get('/:id/bracket', checkAuth, [
    param('id').isInt().withMessage('Invalid cup ID')
  ], handleValidationErrors, asyncHandler(async (req, res) => {
    const cupId = parseInt(req.params.id)
    const cacheKey = `cup:${cupId}:bracket`
    const { data: matches, hit: cacheHit } = await rankingsCache.getOrSet(
      cacheKey,
      () => db.getCupBracket(cupId)
    )
    if (!config.isProduction) res.set('Redis-Cache', cacheHit ? 'HIT' : 'MISS')
    res.json(sanitizeResponse(matches || []))
  }))

  // ── Admin writes ────────────────────────────────────────────────────────

  // Create cup
  router.post(
    '/',
    authenticateToken,
    requireAdmin,
    conditionalRateLimit(createLimiter),
    [
      body('name')
        .trim()
        .isLength({ min: 1, max: 255 }).withMessage('Cup name is required (max 255 chars)'),
      body('format')
        .isIn(['single_elimination', 'double_elimination', 'round_robin'])
        .withMessage('Invalid cup format'),
      body('numTeams')
        .isInt({ min: 2, max: 32 }).withMessage('Number of teams must be 2-32')
        .custom((val) => {
          // Must be power of 2 for single elimination
          return true // allow non-power-of-2, padding handled by bracket gen
        }),
      body('seasonId').optional().isInt().withMessage('Season ID must be integer'),
      body('regulationText').optional().isString().withMessage('Regulation text must be string'),
      body('startDate').optional({ nullable: true, checkFalsy: true }).isISO8601().withMessage('Valid start date required'),
      body('endDate').optional({ nullable: true, checkFalsy: true }).isISO8601().withMessage('Valid end date required'),
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const { name, format, numTeams, seasonId, regulationText, startDate, endDate } = req.body
      const createdBy = req.user?.username || req.user?.email || 'system'

      const cupId = await db.createCup(
        name,
        seasonId || null,
        format,
        numTeams,
        regulationText || null,
        createdBy
      )

      // Update dates if provided
      if (startDate || endDate) {
        const updates = {}
        if (startDate) updates.start_date = startDate.split('T')[0]
        if (endDate) updates.end_date = endDate.split('T')[0]
        if (Object.keys(updates).length) {
          await db.updateCup(cupId, updates)
        }
      }

      await rankingsCache.invalidateByPrefix('cups*')
      res.status(201).json({ success: true, id: cupId })
    })
  )

  // Update cup
  router.put(
    '/:id',
    authenticateToken,
    requireAdmin,
    conditionalRateLimit(createLimiter),
    [
      param('id').isInt().withMessage('Invalid cup ID'),
      body('name').optional().trim().isLength({ min: 1, max: 255 }).withMessage('Invalid name'),
      body('format').optional().isIn(['single_elimination', 'double_elimination', 'round_robin']).withMessage('Invalid format'),
      body('numTeams').optional().isInt({ min: 2, max: 32 }).withMessage('Teams must be 2-32'),
      body('seasonId').optional().isInt().withMessage('Season ID must be integer'),
      body('regulationText').optional().isString().withMessage('Regulation text must be string'),
      body('startDate').optional({ nullable: true, checkFalsy: true }).isISO8601(),
      body('endDate').optional({ nullable: true, checkFalsy: true }).isISO8601(),
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const cupId = parseInt(req.params.id)
      const cup = await db.getCupById(cupId)
      if (!cup) return res.status(404).json({ error: 'Cup not found' })

      // Only allow structural changes in draft status
      const structuralFields = ['format', 'numTeams']
      const hasStructuralChange = structuralFields.some(f => req.body[f] !== undefined)
      if (hasStructuralChange && cup.status !== 'draft') {
        return res.status(400).json({ error: 'Cannot change format/teams after bracket generated' })
      }

      const updates = {}
      for (const key of ['name', 'format', 'numTeams', 'seasonId', 'regulationText', 'startDate', 'endDate']) {
        if (req.body[key] !== undefined) {
          const dbKey = key === 'numTeams' ? 'num_teams' :
                        key === 'seasonId' ? 'season_id' :
                        key === 'regulationText' ? 'regulation_text' :
                        key === 'startDate' ? 'start_date' :
                        key === 'endDate' ? 'end_date' : key
          updates[dbKey] = key === 'startDate' || key === 'endDate'
            ? req.body[key].split('T')[0]
            : req.body[key]
        }
      }

      await db.updateCup(cupId, updates)
      await rankingsCache.invalidateByPrefix('cups*')
      res.json({ success: true })
    })
  )

  // Delete cup (only in draft status)
  router.delete(
    '/:id',
    authenticateToken,
    requireAdmin,
    conditionalRateLimit(deleteLimiter),
    [param('id').isInt().withMessage('Invalid cup ID')],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const cupId = parseInt(req.params.id)
      const cup = await db.getCupById(cupId)
      if (!cup) return res.status(404).json({ error: 'Cup not found' })
      if (cup.status !== 'draft') {
        return res.status(400).json({ error: 'Can only delete cups in draft status' })
      }
      await db.deleteCup(cupId)
      await rankingsCache.invalidateByPrefix('cups*')
      res.json({ success: true })
    })
  )

  // Update cup status
  router.put(
    '/:id/status',
    authenticateToken,
    requireAdmin,
    conditionalRateLimit(createLimiter),
    [
      param('id').isInt().withMessage('Invalid cup ID'),
      body('status').isIn(['draft', 'scheduled', 'in_progress', 'completed', 'cancelled'])
        .withMessage('Invalid status'),
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const cupId = parseInt(req.params.id)
      const cup = await db.getCupById(cupId)
      if (!cup) return res.status(404).json({ error: 'Cup not found' })

      const validTransitions = {
        draft: ['scheduled', 'cancelled'],
        scheduled: ['in_progress', 'cancelled'],
        in_progress: ['completed', 'cancelled'],
        completed: [],
        cancelled: ['draft'],
      }

      const newStatus = req.body.status
      const allowed = validTransitions[cup.status] || []
      if (!allowed.includes(newStatus)) {
        return res.status(400).json({
          error: `Cannot transition from '${cup.status}' to '${newStatus}'`,
          allowed,
        })
      }

      await db.updateCup(cupId, { status: newStatus })
      await rankingsCache.invalidateByPrefix('cups*')
      res.json({ success: true, status: newStatus })
    })
  )

  // ── Participants ────────────────────────────────────────────────────────

  // List participants
  router.get('/:id/participants', checkAuth, [
    param('id').isInt().withMessage('Invalid cup ID')
  ], handleValidationErrors, asyncHandler(async (req, res) => {
    const cupId = parseInt(req.params.id)
    const cacheKey = `cup:${cupId}:participants`
    const { data: participants, hit: cacheHit } = await rankingsCache.getOrSet(
      cacheKey,
      () => db.getCupParticipants(cupId)
    )
    if (!config.isProduction) res.set('Redis-Cache', cacheHit ? 'HIT' : 'MISS')
    res.json(sanitizeResponse(participants || []))
  }))

  // Add participant
  router.post(
    '/:id/participants',
    authenticateToken,
    requireAdmin,
    conditionalRateLimit(createLimiter),
    [
      param('id').isInt().withMessage('Invalid cup ID'),
      body('player1Id').isInt().withMessage('Primary player ID required'),
      body('player2Id').optional().isInt().withMessage('Secondary player ID must be integer'),
      body('teamName').optional().trim().isString().withMessage('Team name must be string'),
      body('seed').optional().isInt({ min: 1 }).withMessage('Seed must be positive integer'),
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const cupId = parseInt(req.params.id)
      const cup = await db.getCupById(cupId)
      if (!cup) return res.status(404).json({ error: 'Cup not found' })
      if (cup.status !== 'draft') {
        return res.status(400).json({ error: 'Can only modify participants in draft status' })
      }

      const currentCount = (await db.getCupParticipants(cupId)).length
      if (currentCount >= cup.num_teams) {
        return res.status(400).json({ error: `Cup already at max ${cup.num_teams} teams` })
      }

      const { player1Id, player2Id, teamName, seed } = req.body
      const participantId = await db.addCupParticipant(
        cupId, player1Id, player2Id || null, teamName || null, seed || null
      )

      if (!participantId) {
        return res.status(409).json({ error: 'Participant already registered' })
      }

      await rankingsCache.invalidateByPrefix(`cup:${cupId}:*`)
      res.status(201).json({ success: true, id: participantId })
    })
  )

  // Reorder participants (drag-and-drop seeding)
  router.put(
    '/:id/participants/reorder',
    authenticateToken,
    requireAdmin,
    conditionalRateLimit(createLimiter),
    [
      param('id').isInt().withMessage('Invalid cup ID'),
      body('orderedIds').isArray({ min: 1 }).withMessage('Ordered IDs array required'),
      body('orderedIds.*').isInt().withMessage('Each ID must be integer'),
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const cupId = parseInt(req.params.id)
      const cup = await db.getCupById(cupId)
      if (!cup) return res.status(404).json({ error: 'Cup not found' })
      if (cup.status !== 'draft') {
        return res.status(400).json({ error: 'Can only reorder in draft status' })
      }

      await db.reorderCupParticipants(cupId, req.body.orderedIds)
      await rankingsCache.invalidateByPrefix(`cup:${cupId}:*`)
      res.json({ success: true })
    })
  )

  // Remove participant
  router.delete(
    '/:id/participants/:pid',
    authenticateToken,
    requireAdmin,
    conditionalRateLimit(deleteLimiter),
    [
      param('id').isInt().withMessage('Invalid cup ID'),
      param('pid').isInt().withMessage('Invalid participant ID'),
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const cupId = parseInt(req.params.id)
      const pid = parseInt(req.params.pid)
      const cup = await db.getCupById(cupId)
      if (!cup) return res.status(404).json({ error: 'Cup not found' })
      if (cup.status !== 'draft') {
        return res.status(400).json({ error: 'Can only remove participants in draft status' })
      }

      await db.removeCupParticipant(cupId, pid)
      await rankingsCache.invalidateByPrefix(`cup:${cupId}:*`)
      res.json({ success: true })
    })
  )

  // ── Bracket generation & match management ───────────────────────────────

  // Generate bracket
  router.post(
    '/:id/generate-bracket',
    authenticateToken,
    requireAdmin,
    conditionalRateLimit(createLimiter),
    [param('id').isInt().withMessage('Invalid cup ID')],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const cupId = parseInt(req.params.id)
      const cup = await db.getCupById(cupId)
      if (!cup) return res.status(404).json({ error: 'Cup not found' })

      const participants = await db.getCupParticipants(cupId)
      if (participants.length < 2) {
        return res.status(400).json({ error: 'Need at least 2 participants to generate bracket' })
      }

      await db.generateBracket(cupId)
      await db.updateCup(cupId, { status: 'scheduled' })
      await rankingsCache.invalidateByPrefix(`cup:${cupId}:*`)
      await rankingsCache.invalidateByPrefix('cups*')

      const matches = await db.getCupBracket(cupId)
      res.json({ success: true, matchesCount: matches.length })
    })
  )

  // Shuffle seeds (randomize participant order for fair bracket)
  router.post(
    '/:id/seed-shuffle',
    authenticateToken,
    requireAdmin,
    conditionalRateLimit(createLimiter),
    [param('id').isInt().withMessage('Invalid cup ID')],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const cupId = parseInt(req.params.id)
      const cup = await db.getCupById(cupId)
      if (!cup) return res.status(404).json({ error: 'Cup not found' })
      if (cup.status !== 'draft') {
        return res.status(400).json({ error: 'Can only shuffle in draft status' })
      }

      const participants = await db.getCupParticipants(cupId)
      // Fisher-Yates shuffle
      const ids = participants.map(p => p.id)
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[ids[i], ids[j]] = [ids[j], ids[i]]
      }

      await db.reorderCupParticipants(cupId, ids)
      await rankingsCache.invalidateByPrefix(`cup:${cupId}:*`)
      res.json({ success: true })
    })
  )

  // Update match score
  router.put(
    '/:id/matches/:mid',
    authenticateToken,
    requireAdmin,
    conditionalRateLimit(createLimiter),
    [
      param('id').isInt().withMessage('Invalid cup ID'),
      param('mid').isInt().withMessage('Invalid match ID'),
      body('team1Score').isInt({ min: 0 }).withMessage('Team 1 score must be non-negative integer'),
      body('team2Score').isInt({ min: 0 }).withMessage('Team 2 score must be non-negative integer'),
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const cupId = parseInt(req.params.id)
      const matchId = parseInt(req.params.mid)
      const cup = await db.getCupById(cupId)
      if (!cup) return res.status(404).json({ error: 'Cup not found' })
      if (cup.status !== 'in_progress') {
        return res.status(400).json({ error: 'Cup must be in_progress to update scores' })
      }

      const { team1Score, team2Score } = req.body
      const result = await db.updateCupMatchScore(cupId, matchId, team1Score, team2Score)
      await rankingsCache.invalidateByPrefix(`cup:${cupId}:*`)
      await rankingsCache.invalidateByPrefix('cups*')

      res.json({ success: true, ...result })
    })
  )

  // Get all players (for participant selection dropdown)
  router.get('/_players', checkAuth, asyncHandler(async (req, res) => {
    const { data: players } = await rankingsCache.getOrSet(
      'players',
      () => db.getPlayers(1000)
    )
    res.json(sanitizeResponse(players || []))
  }))

  // Get all seasons (for season selection dropdown)
  router.get('/_seasons', checkAuth, asyncHandler(async (req, res) => {
    const { data: seasons } = await rankingsCache.getOrSet(
      'seasons',
      () => db.getSeasons(100)
    )
    res.json(sanitizeResponse(seasons || []))
  }))

  return router
}
