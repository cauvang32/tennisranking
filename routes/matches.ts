import crypto from 'crypto'
import { Router, json as expressJson } from 'express'
import { body, param, query } from 'express-validator'
import config from '../config/env.js'
import { readImageDimensions } from '../lib/image-dimensions.js'
import { asyncHandler } from '../utils/async-handler.js'
import { parseImageMatches } from '../lib/ai-parser.js'

export const createMatchRouter = ({
  db,
  checkAuth,
  authenticateToken,
  requireEditor,
  conditionalRateLimit,
  createLimiter,
  deleteLimiter,
  criticalLimiter,
  handleValidationErrors,
  rankingsCache,
  sanitizeResponse,
  pushSender
}) => {
  const router = Router()

  router.get('/', checkAuth, [
    query('limit').optional().isInt({ min: 1, max: 1000 }).withMessage('Limit must be between 1 and 1000'),
    query('after').optional().isString().custom((value) => {
      if (!value) return true // empty string is fine — treated as null
      // Validate base64-encoded JSON cursor format
      try {
        const decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf8'))
        if (typeof decoded !== 'object' || !decoded.playDate || !decoded.createdAt || typeof decoded.id !== 'number') {
          return false
        }
      } catch { return false }
      return true
    }).withMessage('Valid pagination cursor required')
  ], handleValidationErrors, asyncHandler(async (req, res) => {
    // Apply a default server-side limit to prevent loading all matches into memory.
    // The frontend can override with ?limit=N (max 1000).
    const limit = req.query.limit ? parseInt(String(req.query.limit)) : 50
    const cursor = req.query.after ? String(req.query.after) : null

    // Build query with optional cursor-based pagination (keyset indexing)
    let queryMatches
    if (cursor) {
      queryMatches = () => db.getMatchesAfterCursor(cursor, limit)
    } else {
      queryMatches = () => db.getMatches(limit)
    }

    // For bounded requests (with limit), use the cached path
    // Hash cursor to avoid Redis key bloat from long base64 strings
    const cursorHash = cursor ? crypto.createHash('sha256').update(cursor).digest('hex').substring(0, 16) : null
    const cacheKey = cursorHash ? `matches:list:cursor:${cursorHash}` : `matches:list:${limit}`
    const { data: matches, hit: cacheHit } = await rankingsCache.getOrSet(
      cacheKey,
      queryMatches
    )
    // Only expose Redis-Cache headers in development for debugging
    if (!config.isProduction) res.set('Redis-Cache', cacheHit ? 'HIT' : 'MISS')

    // Add pagination headers for frontend
    // M1: Use keyset cursor with (play_date, created_at, id) tuple for correct ordering
    if (matches && matches.length > 0) {
      const last = matches[matches.length - 1]
      const cursorObj = {
        playDate: last.play_date,
        createdAt: last.created_at,
        id: last.id
      }
      res.set('X-Next-Cursor', Buffer.from(JSON.stringify(cursorObj)).toString('base64'))
    }

    return res.json(sanitizeResponse(matches))
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
    if (!config.isProduction) res.set('Redis-Cache', cacheHit ? 'HIT' : 'MISS')
    res.json(sanitizeResponse(matches))
  }))

  router.get('/by-season/:seasonId', checkAuth, [
    param('seasonId').isInt({ min: 1 }).withMessage('Invalid season ID')
  ], handleValidationErrors, asyncHandler(async (req, res) => {
    const seasonId = parseInt(String(req.params.seasonId))
    const cacheKey = `matches:season:${seasonId}`
    const { data: matches, hit: cacheHit } = await rankingsCache.getOrSet(
      cacheKey,
      () => db.getMatchesBySeason(seasonId)
    )
    if (!config.isProduction) res.set('Redis-Cache', cacheHit ? 'HIT' : 'MISS')
    res.json(sanitizeResponse(matches))
  }))

  router.get('/:id', checkAuth, [param('id').isInt().withMessage('Invalid match ID')], handleValidationErrors, asyncHandler(async (req, res) => {
    const matchId = parseInt(String(req.params.id))
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
    if (!config.isProduction) res.set('Redis-Cache', cacheHit ? 'HIT' : 'MISS')
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
    // L6: Max 100 prevents overflow in ranking calculations and unreasonable money penalties
    body('team1Score').isInt({ min: 0, max: 100 }).withMessage('Valid team 1 score is required'),
    body('team2Score').isInt({ min: 0, max: 100 }).withMessage('Valid team 2 score is required'),
    body('winningTeam').isInt({ min: 1, max: 2 }).withMessage('Winning team must be 1 or 2'),
    body('matchType').optional().isIn(['solo', 'duo']).withMessage('Match type must be solo or duo')
  ]

  // Helper function to validate players are in season.
  // Accepts a pre-fetched seasonPlayers map (seasonId → Set of playerIds)
  // to avoid N+1 queries in bulk operations. If not provided, fetches from DB.
  const validatePlayersInSeason = async (seasonId, playerIds, seasonPlayersMap = null) => {
    let seasonPlayerIds
    if (seasonPlayersMap && seasonPlayersMap.has(seasonId)) {
      seasonPlayerIds = seasonPlayersMap.get(seasonId)
    } else if (seasonPlayersMap) {
      // Season not in map — fetch on demand (shouldn't happen in bulk path)
      const seasonPlayers = await db.getSeasonPlayers(seasonId)
      seasonPlayerIds = new Set(seasonPlayers.map(p => p.id))
    } else {
      // Legacy call without map — fetch from DB (single-match path)
      const seasonPlayers = await db.getSeasonPlayers(seasonId)
      seasonPlayerIds = new Set(seasonPlayers.map(p => p.id))
    }

    // If season has no assigned players, allow all (backward compatibility)
    if (seasonPlayerIds.size === 0) {
      return { valid: true }
    }

    const invalidPlayers = playerIds.filter(id => id && !seasonPlayerIds.has(id))
    if (invalidPlayers.length > 0) {
      return {
        valid: false,
        error: `Players ${invalidPlayers.join(', ')} are not eligible for this season`
      }
    }
    return { valid: true }
  }

  // Fire-and-forget FCM push for a newly created match. Builds the match object
  // from the request body + a single player-name lookup (run in parallel with
  // the cache invalidation), so we avoid the extra 5-table JOIN that a
  // post-hoc getMatchById would have required. Never blocks or fails the
  // response. Create-only; no PUT/PATCH variant.
  const fireMatchPush = (matchId, body, matchType) => {
    if (!pushSender) return
    Promise.resolve()
      .then(async () => {
        const ids = [body.player1Id, body.player2Id, body.player3Id, body.player4Id]
        const players = await db.getPlayersByIds(ids)
        const nameMap = new Map(players.map(p => [p.id, p.name]))
        const match = {
          id: matchId,
          match_type: matchType,
          player1_name: nameMap.get(body.player1Id) || '',
          player2_name: nameMap.get(body.player2Id) || '',
          player3_name: nameMap.get(body.player3Id) || '',
          player4_name: nameMap.get(body.player4Id) || '',
          team1_score: body.team1Score,
          team2_score: body.team2Score
        }
        await pushSender.sendMatch(match)
      })
      .catch(err => console.warn('FCM sendMatch failed:', err.message))
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
      // winMoney / loseMoney are intentionally ignored — computed server-side from season config
      const resolvedMatchType = matchType

      // For solo matches, only player1 and player3 are required (they are the opponents)
      if (resolvedMatchType === 'solo') {
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
        const matchId = await db.addMatch(seasonId, playDate, player1Id, null, player3Id, null, team1Score, team2Score, winningTeam, resolvedMatchType)
        fireMatchPush(matchId, req.body, resolvedMatchType)
        try { await rankingsCache.invalidateOnMatchChange(playDate, seasonId, matchId) } catch (err) { console.error('Cache invalidation failed after match create:', err.message) }
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

        const matchId = await db.addMatch(seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam, resolvedMatchType)
        fireMatchPush(matchId, req.body, resolvedMatchType)
        try { await rankingsCache.invalidateOnMatchChange(playDate, seasonId, matchId) } catch (err) { console.error('Cache invalidation failed after match create:', err.message) }
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
      const matchId = parseInt(String(req.params.id))
      const existingMatch = await db.getMatchById(matchId)
      if (!existingMatch) {
        res.status(404).json({ error: 'Match not found' })
        return
      }
      const { seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam, matchType } = req.body
      // Preserve existing matchType when not provided in update
      const resolvedMatchType = matchType || existingMatch.match_type || 'duo'

      if (resolvedMatchType === 'solo') {
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
        
        await db.updateMatch(matchId, seasonId, playDate, player1Id, null, player3Id, null, team1Score, team2Score, winningTeam, resolvedMatchType)
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

        await db.updateMatch(matchId, seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam, resolvedMatchType)
      }
      
      // Invalidate new date + old date if play_date changed
      try { await rankingsCache.invalidateOnMatchChange(playDate, seasonId, matchId) } catch (err) { console.error('Cache invalidation failed after match update:', err.message) }
      const oldDate = existingMatch.play_date?.split?.('T')?.[0] || existingMatch.play_date
      if (oldDate && oldDate !== playDate) {
        try { await rankingsCache.invalidateOnMatchChange(oldDate, existingMatch.season_id, matchId) } catch (err) { console.error('Cache invalidation failed for old date:', err.message) }
      }
      // Also invalidate player rankings if players changed
      if (player1Id !== existingMatch.player1_id || player2Id !== existingMatch.player2_id ||
          player3Id !== existingMatch.player3_id || player4Id !== existingMatch.player4_id) {
        try { await rankingsCache.invalidateOnPlayerChange() } catch (err) { console.error('Cache invalidation failed for player change:', err.message) }
      }
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
      const matchId = parseInt(String(req.params.id))
      const existingMatch = await db.getMatchById(matchId)
      if (!existingMatch) {
        res.status(404).json({ error: 'Match not found' })
        return
      }
      const matchDate = existingMatch.play_date
      await db.deleteMatch(matchId)
      try { await rankingsCache.invalidateOnMatchChange(matchDate, existingMatch.season_id, matchId) } catch (err) { console.error('Cache invalidation failed after match delete:', err.message) }
      res.json({ success: true, message: 'Match deleted successfully' })
    })
  )

  router.get('/play-dates/list', checkAuth, asyncHandler(async (req, res) => {
    const { data: playDates, hit: cacheHit } = await rankingsCache.getOrSet(
      'playdates',
      () => db.getPlayDates()
    )
    // L3: Only expose Redis-Cache diagnostic header in development
    if (!config.isProduction) res.set('Redis-Cache', cacheHit ? 'HIT' : 'MISS')
    res.json(playDates)
  }))

  router.get('/play-dates/latest', checkAuth, asyncHandler(async (req, res) => {
    const { data: latestDate, hit: cacheHit } = await rankingsCache.getOrSet(
      'playdate:latest',
      () => db.getLatestPlayDate()
    )
    // L3: Only expose Redis-Cache diagnostic header in development
    if (!config.isProduction) res.set('Redis-Cache', cacheHit ? 'HIT' : 'MISS')
    res.json({ playDate: latestDate })
  }))

  // ── Bulk Create: POST /api/matches/bulk-create ───────────────────────────────
  // Creates multiple matches in a single database transaction.
  // Used by the AI screenshot parse flow to bulk-confirm extracted matches.
  // Requires editor/admin authentication.

  router.post(
    '/bulk-create',
    authenticateToken,
    requireEditor,
    asyncHandler(async (req, res) => {
      const { matches } = req.body

      if (!Array.isArray(matches) || matches.length === 0) {
        res.status(400).json({ error: 'Danh sách trận đấu không được để trống' })
        return
      }

      // CWE-400: Limit bulk operations to prevent DoS via large payloads
      if (matches.length > 200) {
        res.status(400).json({ error: 'Tối đa 200 trận đấu mỗi lần gửi' })
        return
      }

      const client = await db.pool.connect()
      let createdCount = 0

      // Batch-validate: collect all unique (seasonId, playerIds) pairs upfront,
      // fetch season players once per season, then validate all matches.
      // This avoids N+1 queries where each match triggers a separate DB call.
      const seasonPlayerIdsSet = new Set()
      for (const match of matches) {
        const { seasonId: _seasonId, player1Id, player2Id, player3Id, player4Id, matchType = 'duo' } = match
        const pIds = matchType === 'duo'
          ? [player1Id, player2Id, player3Id, player4Id]
          : [player1Id, player3Id]
        for (const id of pIds) { if (id) seasonPlayerIdsSet.add(id) }
      }
      const allSeasonIds = [...new Set(matches.map(m => m.seasonId))]
      const seasonPlayersMap = new Map()
      for (const sid of allSeasonIds) {
        const sps = await db.getSeasonPlayers(sid)
        seasonPlayersMap.set(sid, new Set(sps.map(p => p.id)))
      }

      try {
        await client.query('BEGIN')

        // M6: Collect created match IDs and affected dates — invalidate AFTER commit
        // to avoid invalidating cache for matches that never committed.
        const createdMatches = []

        for (const match of matches) {
          const { seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam, matchType = 'duo' } = match

          // Validate players are in season (using pre-fetched map)
          const playerIds = matchType === 'duo'
            ? [player1Id, player2Id, player3Id, player4Id]
            : [player1Id, player3Id]

          const validation = await validatePlayersInSeason(seasonId, playerIds, seasonPlayersMap)
          if (!validation.valid) {
            await client.query('ROLLBACK')
            res.status(400).json({ error: validation.error })
            return
          }

          // Validate match payload (scores, winningTeam, matchType, playDate)
          if (typeof team1Score !== 'number' || team1Score < 0 || team1Score > 100) {
            await client.query('ROLLBACK')
            res.status(400).json({ error: `Invalid team1Score: ${team1Score}. Must be between 0 and 100.` })
            return
          }
          if (typeof team2Score !== 'number' || team2Score < 0 || team2Score > 100) {
            await client.query('ROLLBACK')
            res.status(400).json({ error: `Invalid team2Score: ${team2Score}. Must be between 0 and 100.` })
            return
          }
          if (winningTeam !== 1 && winningTeam !== 2) {
            await client.query('ROLLBACK')
            res.status(400).json({ error: `Invalid winningTeam: ${winningTeam}. Must be 1 or 2.` })
            return
          }
          if (matchType !== 'solo' && matchType !== 'duo') {
            await client.query('ROLLBACK')
            res.status(400).json({ error: `Invalid matchType: ${matchType}. Must be 'solo' or 'duo'.` })
            return
          }

          let matchId
          if (matchType === 'solo') {
            matchId = await db.addMatch(seasonId, playDate, player1Id, null, player3Id, null, team1Score, team2Score, winningTeam, matchType, client)
          } else {
            matchId = await db.addMatch(seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam, matchType, client)
          }

          createdMatches.push({ matchId, match, matchType, playDate })
          createdCount++
        }

        await client.query('COMMIT')

        // M6: Invalidate cache and fire pushes AFTER successful commit
        const affectedDates = [...new Set(createdMatches.map(cm => cm.playDate))]
        for (const date of affectedDates) {
          await rankingsCache.invalidateOnMatchChange(date)
        }
        for (const cm of createdMatches) {
          fireMatchPush(cm.matchId, cm.match, cm.matchType)
        }

        res.json({ success: true, created: createdCount, total: matches.length })
      } catch (err) {
        await client.query('ROLLBACK')
        console.error('❌ Bulk create failed:', err.message)
        res.status(500).json({ error: 'Lỗi khi tạo nhiều trận đấu' })
      } finally {
        client.release()
      }
    })
  )

  // ── AI Image Parser: POST /api/matches/parse-image ──────────────────────────
  // Accepts a JSON body with a base64-encoded image, calls AI vision API,
  // returns parsed matches as JSON for frontend preview/editing.
  // Requires editor/admin authentication. Only one image per request.

  router.post(
    '/parse-image',
    authenticateToken,
    requireEditor,
    conditionalRateLimit(criticalLimiter),
    expressJson({ limit: '12mb' }),
    asyncHandler(async (req, res) => {
      const { imageBase64, mimeType } = req.body

      if (!imageBase64) {
        res.status(400).json({ error: 'Vui lòng chọn một hình ảnh để phân tích' })
        return
      }

      // Validate image size: base64 string should be reasonable (< 20MB)
      // A 5MB image = ~6.7MB base64. 20MB base64 ≈ 15MP image, well above phone cameras.
      const maxBase64Length = 11 * 1024 * 1024
      if (imageBase64.length > maxBase64Length) {
        res.status(400).json({
          error: `Hình ảnh quá lớn (${(imageBase64.length / 1024 / 1024).toFixed(1)}MB). Tối đa 8MB.`
        })
        return
      }

      // Validate MIME type if provided
      if (mimeType && !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType.toLowerCase())) {
        res.status(400).json({ error: 'Định dạng hình ảnh không hợp lệ. Chỉ hỗ trợ PNG, JPEG, WebP, GIF.' })
        return
      }

      if (typeof imageBase64 !== 'string' ||
          imageBase64.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) {
        return res.status(400).json({ error: 'Dữ liệu hình ảnh base64 không hợp lệ.' })
      }
      const imageBytes = Buffer.from(imageBase64, 'base64')
      if (imageBytes.length === 0 || imageBytes.length > 8 * 1024 * 1024) {
        return res.status(400).json({ error: 'Kích thước hình ảnh không hợp lệ hoặc vượt quá 8MB.' })
      }
      const detectedMime =
        imageBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png'
          : imageBytes[0] === 0xff && imageBytes[1] === 0xd8 && imageBytes[2] === 0xff ? 'image/jpeg'
            : ['GIF87a', 'GIF89a'].includes(imageBytes.subarray(0, 6).toString('ascii')) ? 'image/gif'
              : imageBytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
                imageBytes.subarray(8, 12).toString('ascii') === 'WEBP' ? 'image/webp'
                : null
      if (!detectedMime || (mimeType && detectedMime !== mimeType.toLowerCase())) {
        return res.status(400).json({ error: 'Nội dung tệp không khớp với định dạng hình ảnh.' })
      }
      try {
        const dimensions = readImageDimensions(imageBytes)
        const width = dimensions?.width || 0
        const height = dimensions?.height || 0
        const pixels = width * height
        if (!pixels || width > 10000 || height > 10000 || pixels > 40_000_000) {
          return res.status(400).json({ error: 'Kích thước điểm ảnh vượt quá giới hạn 40 megapixel.' })
        }
      } catch {
        return res.status(400).json({ error: 'Không thể đọc cấu trúc hình ảnh.' })
      }

      let parsed
      const abortController = new AbortController()
      const abortProviderRequest = () => abortController.abort()
      req.once('aborted', abortProviderRequest)
      res.once('close', abortProviderRequest)
      try {
        parsed = await parseImageMatches(imageBase64, { signal: abortController.signal })
      } catch (error) {
        console.error('[parse-image] AI parsing failed:', error.message)
        res.status(502).json({
          error: `Phân tích hình ảnh thất bại: ${error.message}`
        })
        return
      } finally {
        req.off('aborted', abortProviderRequest)
        res.off('close', abortProviderRequest)
      }

      // Guard: parseImageMatches can return objects without .matches
      // (ai-parser.js early returns for LM Studio raw output).
      // Without this, parsed.matches.map() throws a TypeError that
      // results in a generic 500 instead of a helpful message.
      if (!parsed.matches || !Array.isArray(parsed.matches)) {
        console.warn('[parse-image] Unexpected AI response:', typeof parsed, JSON.stringify(parsed).substring(0, 200))
        res.status(400).json({
          error: 'AI trả về kết quả không hợp lệ — không tìm thấy "matches" array. Vui lòng thử lại với ảnh rõ hơn.'
        })
        return
      }

      // Normalize parsed matches into our internal format
      const normalized = parsed.matches.map(m => {
        const names = [m.player1Name, m.player2Name, m.player3Name, m.player4Name].filter(Boolean)
        // Trust the AI's explicit matchType classification (set by normalizeMatch in ai-parser.js).
        // Only use the route-level heuristic as a fallback when matchType is missing.
        let matchType = m.matchType || (names.length <= 2 ? 'solo' : 'duo')
        const team1Score = parseInt(m.team1Score) || 0
        const team2Score = parseInt(m.team2Score) || 0
        const winningTeam = team1Score > team2Score ? 1 : team2Score > team1Score ? 2 : 1

        const player1Name = (typeof m.player1Name === 'string' && m.player1Name.trim()) || ''
        let player2Name = (typeof m.player2Name === 'string' && m.player2Name.trim()) || null
        let player3Name = (typeof m.player3Name === 'string' && m.player3Name.trim()) || ''
        const player4Name = (typeof m.player4Name === 'string' && m.player4Name.trim()) || null

        // Handle solo matches: the model may put the two opponents in
        // player1 + player2 (with player3/player4 = null). Our DB format
        // expects player1 + player3 (with player2/player4 = null).
        if (matchType === 'solo' && player2Name) {
          player3Name = player2Name
          player2Name = null
        }

        // Heuristic: if a solo match has a multi-word name (e.g. "Hải Phong"),
        // it's likely a doubles match where the AI extracted team nicknames
        // instead of individual player names. Reclassify as duo so the
        // frontend's mapTeamToPlayerPair can resolve the nicknames.
        // Match normalizeMatch's OR logic: EITHER multi-word name → duo.
        if (matchType === 'solo' && names.length <= 2) {
          const isTeamNickname = (name) => name && name.split(/\s+/).length > 1
          if (isTeamNickname(player1Name) || isTeamNickname(player3Name)) {
            matchType = 'duo'
          }
        }

        return {
          player1Name,
          player2Name,
          player3Name,
          player4Name,
          team1Score,
          team2Score,
          winningTeam,
          matchType
        }
      })

      res.json({ matches: normalized })
    })
  )

  return router
}
