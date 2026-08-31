import { Router } from 'express'
import { body, param } from 'express-validator'
import multer from 'multer'
import fs from 'fs'
import config from '../config/env.js'
import { asyncHandler } from '../utils/async-handler.js'
import {
  createUploadFilename,
  ensureUploadDirectory,
  resolveAbsoluteUploadPath,
  resolveUploadPath,
  toStoredUploadPath,
  validateUploadedImage
} from '../lib/upload-storage.js'

const CUP_UPLOAD_DIR = await ensureUploadDirectory('cups')

// Only powers of two produce clean single-elimination brackets (each round
// halves the field down to a single final). Restrict to these so a bracket can
// always be generated without byes straddling an odd split.
const TEAM_COUNTS = [2, 4, 8, 16, 32]
const isTeamCount = value => TEAM_COUNTS.includes(Number(value))
const safeImageContentType = value =>
  ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(value)
    ? value
    : 'application/octet-stream'

const cupImageStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const cupId = req.params?.id
    if (cupId) {
      ensureUploadDirectory('cups', String(cupId)).then(
        directory => cb(null, directory),
        error => cb(error as Error, '')
      )
    } else {
      cb(null, CUP_UPLOAD_DIR)
    }
  },
  filename: (_req, file, cb) => cb(null, createUploadFilename(file.mimetype))
})
const imageUpload = multer({
  storage: cupImageStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    if (allowed.includes(file.mimetype)) cb(null, true)
    else cb(new Error('Invalid image type'))
  }
})

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

  // Helper endpoints for frontend dropdowns — MUST be defined BEFORE /:id
  // so Express doesn't match '_players' or '_seasons' as a cup ID.
  router.get('/_players', checkAuth, asyncHandler(async (req, res) => {
    const { data: players } = await rankingsCache.getOrSet(
      'players',
      () => db.getPlayers(1000)
    )
    res.json(sanitizeResponse(players || []))
  }))

  router.get('/_seasons', checkAuth, asyncHandler(async (req, res) => {
    const { data: seasons } = await rankingsCache.getOrSet(
      'seasons',
      () => db.getSeasons(100)
    )
    res.json(sanitizeResponse(seasons || []))
  }))

  // List all cups
  router.get('/', checkAuth, asyncHandler(async (req, res) => {
    const { data: cups, hit: cacheHit } = await rankingsCache.getOrSet(
      'cups',
      () => db.getCups(100)
    )
    if (!config.isProduction) res.set('Redis-Cache', cacheHit ? 'HIT' : 'MISS')
    res.json(sanitizeResponse(cups || []))
  }))

  // Get cup by ID
  router.get('/:id', checkAuth, [
    param('id').isInt().withMessage('Invalid cup ID')
  ], handleValidationErrors, asyncHandler(async (req, res) => {
    const cupId = parseInt(String(req.params.id))
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
    const cupId = parseInt(String(req.params.id))
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
        .isIn(['single_elimination'])
        .withMessage('Invalid cup format. Only single_elimination is supported.'),
      body('numTeams')
        .isInt({ min: 2, max: 32 })
        .custom(isTeamCount)
        .withMessage('Number of teams must be a power of two (2, 4, 8, 16 or 32)'),
      body('seasonId').optional({ nullable: true }).isInt().withMessage('Season ID must be integer'),
      body('regulationText').optional({ nullable: true, checkFalsy: true }).isString().withMessage('Regulation text must be string'),
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
        const updates: Record<string, string> = {}
        if (startDate) updates.start_date = startDate.split('T')[0]
        if (endDate) updates.end_date = endDate.split('T')[0]
        if (Object.keys(updates).length) {
          await db.updateCup(cupId, updates)
        }
      }

      await rankingsCache.invalidateByPrefix('cups*')
      await rankingsCache.incrementVersion()
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
      body('format').optional().isIn(['single_elimination']).withMessage('Invalid format'),
      body('numTeams').optional().isInt({ min: 2, max: 32 }).custom(isTeamCount).withMessage('Teams must be a power of two (2, 4, 8, 16 or 32)'),
      body('seasonId').optional({ nullable: true }).isInt().withMessage('Season ID must be integer'),
      body('regulationText').optional({ nullable: true, checkFalsy: true }).isString().withMessage('Regulation text must be string'),
      body('startDate').optional({ nullable: true, checkFalsy: true }).isISO8601(),
      body('endDate').optional({ nullable: true, checkFalsy: true }).isISO8601(),
      body('finalResults').optional({ nullable: true, checkFalsy: true }).isString(),
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const cupId = parseInt(String(req.params.id))
      const cup = await db.getCupById(cupId)
      if (!cup) return res.status(404).json({ error: 'Cup not found' })
      if (cup.status === 'completed') {
        return res.status(400).json({ error: 'Cannot edit a completed cup' })
      }

      // Only allow structural changes in draft status
      const structuralFields = ['format', 'numTeams']
      const hasStructuralChange = structuralFields.some(f => req.body[f] !== undefined)
      if (hasStructuralChange && cup.status !== 'draft') {
        return res.status(400).json({ error: 'Cannot change format/teams after bracket generated' })
      }

      const updates = {}
      for (const key of ['name', 'format', 'numTeams', 'seasonId', 'regulationText', 'startDate', 'endDate', 'finalResults']) {
        if (req.body[key] !== undefined) {
          const dbKey = key === 'numTeams' ? 'num_teams' :
                        key === 'seasonId' ? 'season_id' :
                        key === 'regulationText' ? 'regulation_text' :
                        key === 'startDate' ? 'start_date' :
                        key === 'endDate' ? 'end_date' :
                        key === 'finalResults' ? 'final_results' : key
          updates[dbKey] = (key === 'startDate' || key === 'endDate')
            ? req.body[key].split('T')[0]
            : req.body[key]
        }
      }

      await db.updateCup(cupId, updates)
      await rankingsCache.invalidateByPrefix(`cup:${cupId}*`)
      await rankingsCache.invalidateByPrefix('cups*')
      await rankingsCache.incrementVersion()
      res.json({ success: true })
    })
  )

  // Delete cup (allowed in any status)
  router.delete(
    '/:id',
    authenticateToken,
    requireAdmin,
    conditionalRateLimit(deleteLimiter),
    [param('id').isInt().withMessage('Invalid cup ID')],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const cupId = parseInt(String(req.params.id))
      const cup = await db.getCupById(cupId)
      if (!cup) return res.status(404).json({ error: 'Cup not found' })
      await db.deleteCup(cupId)
      await rankingsCache.invalidateByPrefix(`cup:${cupId}*`)
      await rankingsCache.invalidateByPrefix('cups*')
      await rankingsCache.incrementVersion()
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
      const cupId = parseInt(String(req.params.id))
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
      await rankingsCache.invalidateByPrefix(`cup:${cupId}*`)
      await rankingsCache.invalidateByPrefix('cups*')
      await rankingsCache.incrementVersion()
      res.json({ success: true, status: newStatus })
    })
  )

  // ── Participants ────────────────────────────────────────────────────────

  // List participants
  router.get('/:id/participants', checkAuth, [
    param('id').isInt().withMessage('Invalid cup ID')
  ], handleValidationErrors, asyncHandler(async (req, res) => {
    const cupId = parseInt(String(req.params.id))
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
      const cupId = parseInt(String(req.params.id))
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

      await rankingsCache.invalidateByPrefix(`cup:${cupId}*`)
      await rankingsCache.incrementVersion()
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
      const cupId = parseInt(String(req.params.id))
      const cup = await db.getCupById(cupId)
      if (!cup) return res.status(404).json({ error: 'Cup not found' })
      if (cup.status !== 'draft') {
        return res.status(400).json({ error: 'Can only reorder in draft status' })
      }

      await db.reorderCupParticipants(cupId, req.body.orderedIds)
      await rankingsCache.invalidateByPrefix(`cup:${cupId}*`)
      await rankingsCache.incrementVersion()
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
      const cupId = parseInt(String(req.params.id))
      const pid = parseInt(String(req.params.pid))
      const cup = await db.getCupById(cupId)
      if (!cup) return res.status(404).json({ error: 'Cup not found' })
      if (cup.status !== 'draft') {
        return res.status(400).json({ error: 'Can only remove participants in draft status' })
      }

      await db.removeCupParticipant(cupId, pid)
      await rankingsCache.invalidateByPrefix(`cup:${cupId}*`)
      await rankingsCache.incrementVersion()
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
      const cupId = parseInt(String(req.params.id))
      const cup = await db.getCupById(cupId)
      if (!cup) return res.status(404).json({ error: 'Cup not found' })
      if (cup.format !== 'single_elimination') {
        return res.status(400).json({ error: `Bracket generation not supported for format: ${cup.format}. Only 'single_elimination' is available.` })
      }

      const participants = await db.getCupParticipants(cupId)
      if (participants.length < 2) {
        return res.status(400).json({ error: 'Need at least 2 participants to generate bracket' })
      }

      await db.generateBracket(cupId)
      await db.updateCup(cupId, { status: 'scheduled' })
      await rankingsCache.invalidateByPrefix(`cup:${cupId}*`)
      await rankingsCache.invalidateByPrefix('cups*')
      await rankingsCache.incrementVersion()

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
      const cupId = parseInt(String(req.params.id))
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
      await rankingsCache.invalidateByPrefix(`cup:${cupId}*`)
      await rankingsCache.incrementVersion()
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
      const cupId = parseInt(String(req.params.id))
      const matchId = parseInt(String(req.params.mid))
      const cup = await db.getCupById(cupId)
      if (!cup) return res.status(404).json({ error: 'Cup not found' })
      if (cup.status !== 'in_progress') {
        return res.status(400).json({ error: 'Cup must be in_progress to update scores' })
      }

      const matchInfo = await db.getCupMatchById(matchId, cupId)
      if (!matchInfo) return res.status(404).json({ error: 'Match not found' })
      if (matchInfo.status === 'locked') {
        return res.status(400).json({ error: 'Vòng này đã được khóa — không thể chỉnh sửa' })
      }

      // Check if all previous rounds are completed
      if (matchInfo.round_number > 1) {
        const prevRoundComplete = await db.areAllMatchesInRoundCompleted(cupId, matchInfo.round_number - 1)
        if (!prevRoundComplete) {
          return res.status(400).json({ error: 'Chưa thể ghi điểm — vòng trước chưa hoàn thành' })
        }
      }

      // A match cannot be scored until both of its teams have been assigned by
      // advancing the previous round. Allowing this would record a "completed"
      // match with no winner and later break advanceRound ("No winners to advance").
      if (matchInfo.team1_participant_id === null || matchInfo.team2_participant_id === null) {
        return res.status(400).json({ error: 'Chưa thể ghi điểm — hai đội chưa được xác định (hãy hoàn thành vòng trước)' })
      }

      const { team1Score, team2Score } = req.body
      const result = await db.updateCupMatchScore(cupId, matchId, team1Score, team2Score)
      await rankingsCache.invalidateByPrefix(`cup:${cupId}*`)
      await rankingsCache.invalidateByPrefix('cups*')
      await rankingsCache.incrementVersion()

      res.json({ success: true, ...result })
    })
  )

  // Reset match score/winner (back to scheduled)
  router.put(
    '/:id/matches/:mid/reset',
    authenticateToken,
    requireEditor,
    conditionalRateLimit(createLimiter),
    [
      param('id').isInt().withMessage('Invalid cup ID'),
      param('mid').isInt().withMessage('Invalid match ID'),
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const cupId = parseInt(String(req.params.id))
      const matchId = parseInt(String(req.params.mid))
      const cup = await db.getCupById(cupId)
      if (!cup) return res.status(404).json({ error: 'Cup not found' })
      if (cup.status !== 'in_progress') {
        return res.status(400).json({ error: 'Cup must be in_progress to reset matches' })
      }

      const matchInfo = await db.getCupMatchById(matchId, cupId)
      if (!matchInfo) return res.status(404).json({ error: 'Match not found' })
      if (matchInfo.status === 'locked') {
        return res.status(400).json({ error: 'Vòng này đã được khóa — không thể chỉnh sửa' })
      }

      const result = await db.resetCupMatch(cupId, matchId)
      await rankingsCache.invalidateByPrefix(`cup:${cupId}*`)
      await rankingsCache.invalidateByPrefix('cups*')
      await rankingsCache.incrementVersion()

      res.json({ success: true, ...result })
    })
  )

  // Update match date
  router.put(
    '/:id/matches/:mid/date',
    authenticateToken,
    requireAdmin,
    conditionalRateLimit(createLimiter),
    [
      param('id').isInt().withMessage('Invalid cup ID'),
      param('mid').isInt().withMessage('Invalid match ID'),
      body('playDate').isISO8601().withMessage('Valid date required'),
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const cupId = parseInt(String(req.params.id))
      const matchId = parseInt(String(req.params.mid))
      const cup = await db.getCupById(cupId)
      if (!cup) return res.status(404).json({ error: 'Cup not found' })
      if (!['scheduled', 'in_progress'].includes(cup.status)) {
        return res.status(400).json({ error: 'Cup must be scheduled or in_progress to set match dates' })
      }

      if (cup.status === 'in_progress') {
        const matchInfo = await db.getCupMatchById(matchId, cupId)
        if (!matchInfo) return res.status(404).json({ error: 'Match not found' })
        if (matchInfo.status === 'locked') {
          return res.status(400).json({ error: 'Vòng này đã được khóa — không thể chỉnh sửa' })
        }
        if (matchInfo.round_number > 1) {
          const prevRoundComplete = await db.areAllMatchesInRoundCompleted(cupId, matchInfo.round_number - 1)
          if (!prevRoundComplete) {
            return res.status(400).json({ error: 'Chưa thể chỉnh sửa — vòng trước chưa hoàn thành' })
          }
        }
        if (matchInfo.team1_participant_id === null || matchInfo.team2_participant_id === null) {
          return res.status(400).json({ error: 'Chưa thể chỉnh sửa — hai đội chưa được xác định (hãy hoàn thành vòng trước)' })
        }
      }

      await db.updateCupMatchDate(cupId, matchId, req.body.playDate.split('T')[0])
      await rankingsCache.invalidateByPrefix(`cup:${cupId}*`)
      await rankingsCache.incrementVersion()
      res.json({ success: true })
    })
  )

  // Upload conclusion image for completed cup
  router.post(
    '/:id/conclusion-image',
    authenticateToken,
    requireAdmin,
    [param('id').isInt({ min: 1 }).withMessage('Invalid cup ID')],
    handleValidationErrors,
    imageUpload.single('image'),
    validateUploadedImage,
    asyncHandler(async (req, res) => {
      const cupId = parseInt(String(req.params.id))

      // CWE-22: validate the uploaded file's path before any filesystem
      // operation. Multer sets req.file.path from a controlled destination and
      // a random filename, but a path is never trusted without a containment
      // check.
      let uploadedPath = null
      if (req.file) {
        uploadedPath = resolveAbsoluteUploadPath(req.file.path)
        if (!uploadedPath) {
          return res.status(400).json({ error: 'Invalid upload path' })
        }
      }

      const cup = await db.getCupById(cupId)
      if (!cup) {
        if (uploadedPath) await fs.promises.unlink(uploadedPath).catch(() => {})
        return res.status(404).json({ error: 'Cup not found' })
      }

      if (!req.file) {
        res.status(400).json({ error: 'No image file provided' })
        return
      }

      const storagePath = toStoredUploadPath(uploadedPath)

      await db.query(`
        UPDATE cups SET conclusion_image_path = $1, conclusion_image_filename = $2,
          conclusion_image_content_type = $3, conclusion_image_size = $4, updated_at = NOW()
        WHERE id = $5
      `, [storagePath, req.file.originalname, req.file.mimetype, req.file.size, cupId])
      if (cup.conclusion_image_path && cup.conclusion_image_path !== storagePath) {
        const oldPath = resolveUploadPath(cup.conclusion_image_path)
        if (oldPath) {
          await fs.promises.unlink(oldPath).catch(() => {})
        }
      }

      await rankingsCache.invalidateByPrefix(`cup:${cupId}*`)
      await rankingsCache.invalidateByPrefix('cups*')
      await rankingsCache.incrementVersion()
      res.json({
        success: true,
        message: 'Conclusion image uploaded',
        url: `/api/cups/${cupId}/conclusion-image/file`
      })
    })
  )

  // Serve cup conclusion image
  router.get(
    '/:id/conclusion-image/file',
    checkAuth,
    [param('id').isInt().withMessage('Invalid cup ID')],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const cupId = parseInt(String(req.params.id))
      const cup = await db.getCupById(cupId)
      if (!cup || !cup.conclusion_image_path) {
        res.status(404).json({ error: 'Conclusion image not found' })
        return
      }
      // CWE-22: Validate that the conclusion image path stays within the project root
      const filePath = resolveUploadPath(cup.conclusion_image_path)
      if (!filePath || !fs.existsSync(filePath)) {
        res.status(404).json({ error: 'Image file not found on disk' })
        return
      }
      res.set({
        'Content-Type': safeImageContentType(cup.conclusion_image_content_type),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff'
      })
      res.sendFile(filePath)
    })
  )

  // Delete cup conclusion image
  router.delete(
    '/:id/conclusion-image',
    authenticateToken,
    requireAdmin,
    conditionalRateLimit(deleteLimiter),
    [param('id').isInt().withMessage('Invalid cup ID')],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const cupId = parseInt(String(req.params.id))
      const cup = await db.getCupById(cupId)
      if (!cup) return res.status(404).json({ error: 'Cup not found' })

      if (cup.conclusion_image_path) {
        const oldPath = resolveUploadPath(cup.conclusion_image_path)
        if (oldPath && fs.existsSync(oldPath)) fs.unlinkSync(oldPath)
      }

      await db.query(`
        UPDATE cups SET conclusion_image_path = NULL, conclusion_image_filename = NULL,
          conclusion_image_content_type = NULL, conclusion_image_size = NULL, updated_at = NOW()
        WHERE id = $1
      `, [cupId])

      await rankingsCache.invalidateByPrefix(`cup:${cupId}*`)
      await rankingsCache.invalidateByPrefix('cups*')
      await rankingsCache.incrementVersion()
      res.json({ success: true, message: 'Conclusion image removed' })
    })
  )

  // Advance round: shuffle winners from current round to next round, lock current
  router.post(
    '/:id/advance-round',
    authenticateToken,
    requireAdmin,
    conditionalRateLimit(createLimiter),
    [
      param('id').isInt().withMessage('Invalid cup ID'),
      body('fromRound').isInt({ min: 1 }).withMessage('Valid round number required'),
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const cupId = parseInt(String(req.params.id))
      const cup = await db.getCupById(cupId)
      if (!cup) return res.status(404).json({ error: 'Cup not found' })
      if (cup.status !== 'in_progress') {
        return res.status(400).json({ error: 'Cup must be in_progress to advance' })
      }

      const { fromRound } = req.body
      const result = await db.advanceRound(cupId, fromRound)
      await rankingsCache.invalidateByPrefix(`cup:${cupId}*`)
      await rankingsCache.invalidateByPrefix('cups*')
      await rankingsCache.incrementVersion()

      // If this was the final round, update cup status
      if (result.isFinal) {
        await db.updateCup(cupId, { status: 'completed' })
        await rankingsCache.invalidateByPrefix(`cup:${cupId}*`)
        await rankingsCache.invalidateByPrefix('cups*')
        await rankingsCache.incrementVersion()
      }

      res.json(result)
    })
  )

  // Set match winner manually (no scores required) — records winner only
  router.put(
    '/:id/matches/:mid/winner',
    authenticateToken,
    requireAdmin,
    conditionalRateLimit(createLimiter),
    [
      param('id').isInt().withMessage('Invalid cup ID'),
      param('mid').isInt().withMessage('Invalid match ID'),
      body('winnerParticipantId').isInt().withMessage('Winner participant ID required'),
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const cupId = parseInt(String(req.params.id))
      const matchId = parseInt(String(req.params.mid))
      const cup = await db.getCupById(cupId)
      if (!cup) return res.status(404).json({ error: 'Cup not found' })
      if (!['scheduled', 'in_progress'].includes(cup.status)) {
        return res.status(400).json({ error: 'Can only set winners when cup is scheduled or in_progress' })
      }

      const matchInfo = await db.getCupMatchById(matchId, cupId)
      if (!matchInfo) return res.status(404).json({ error: 'Match not found' })
      if (matchInfo.status === 'locked') {
        return res.status(400).json({ error: 'Vòng này đã được khóa — không thể chỉnh sửa' })
      }

      // Check if all previous rounds are completed
      if (matchInfo.round_number > 1) {
        const prevRoundComplete = await db.areAllMatchesInRoundCompleted(cupId, matchInfo.round_number - 1)
        if (!prevRoundComplete) {
          return res.status(400).json({ error: 'Chưa thể ghi điểm — vòng trước chưa hoàn thành' })
        }
      }

      // A match cannot have a winner picked until both of its teams are assigned
      // (i.e. the previous round has been advanced into it).
      if (matchInfo.team1_participant_id === null || matchInfo.team2_participant_id === null) {
        return res.status(400).json({ error: 'Chưa thể chọn người thắng — hai đội chưa được xác định (hãy hoàn thành vòng trước)' })
      }

      const { winnerParticipantId } = req.body
      const result = await db.setCupMatchWinner(cupId, matchId, winnerParticipantId)
      await rankingsCache.invalidateByPrefix(`cup:${cupId}*`)
      await rankingsCache.invalidateByPrefix('cups*')
      await rankingsCache.incrementVersion()

      res.json({ success: true, ...result })
    })
  )

  return router
}
