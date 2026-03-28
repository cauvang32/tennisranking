import { Router } from 'express'
import express from 'express'
import { body } from 'express-validator'
import { asyncHandler } from '../utils/async-handler.js'

/**
 * Backup and restore routes (admin-only).
 * Extracted from server.js for modularity.
 */
export const createBackupRouter = ({
  db,
  authenticateToken,
  requireAdmin,
  conditionalRateLimit,
  criticalLimiter,
  restoreLimiter,
  exportLimiter,
  handleValidationErrors,
  rankingsCache,
  formatSecureTimestamp
}) => {
  const router = Router()
  const largeBodyParser = express.json({ limit: '50mb' })

  // ── Full Backup (JSON with users) ─────────────────────────────────────────
  router.get('/backup',
    authenticateToken, requireAdmin, conditionalRateLimit(criticalLimiter),
    asyncHandler(async (req, res) => {
      console.log(`📦 BACKUP requested by user: ${req.user.username}`)
      const [players, seasons, matches, users] = await Promise.all([
        db.getPlayers(), db.getSeasons(), db.getMatches(), db.getUsersForBackup()
      ])
      const seasonsWithPlayers = await Promise.all(seasons.map(async (s) => {
        const sp = await db.getSeasonPlayers(s.id)
        return { ...s, players: sp.map(p => p.player_id || p.id) }
      }))
      const usersForBackup = users.map(u => ({
        id: u.id, username: u.username, email: u.email, password_hash: u.password_hash,
        role: u.role, display_name: u.display_name, is_active: u.is_active,
        created_at: u.created_at, notes: u.notes
      }))
      res.json({
        version: '2.1', timestamp: new Date().toISOString(), exportedBy: req.user.username,
        players, seasons: seasonsWithPlayers, matches, users: usersForBackup
      })
      console.log('✅ Backup created successfully (including users)')
    })
  )

  // ── Full Restore (JSON) ───────────────────────────────────────────────────
  router.post('/restore',
    largeBodyParser, authenticateToken, requireAdmin, conditionalRateLimit(restoreLimiter),
    asyncHandler(async (req, res) => {
      const backupData = req.body
      const currentUsername = req.user.username
      const currentUserId = req.user.id
      console.log(`🔄 RESTORE requested by user: ${currentUsername}`)

      if (!backupData.players || !backupData.seasons || !backupData.matches) {
        return res.status(400).json({ error: 'Invalid backup file structure' })
      }

      const hasUsers = backupData.users && backupData.users.length > 0
      console.log(`📊 Restoring: ${backupData.players.length} players, ${backupData.seasons.length} seasons, ${backupData.matches.length} matches${hasUsers ? `, ${backupData.users.length} users` : ''}`)

      await db.clearAllDataForRestore(currentUserId)

      // Restore players
      const playerIdMap = new Map()
      for (const player of backupData.players) {
        const newId = await db.addPlayer(player.name)
        playerIdMap.set(Number(player.id), newId)
      }
      console.log(`✅ Restored ${backupData.players.length} players`)

      // Restore seasons
      const seasonIdMap = new Map()
      for (const season of backupData.seasons) {
        const newId = await db.createSeason(season.name, season.start_date, season.end_date || null, season.auto_end !== false, season.description || '', season.lose_money_per_loss || 20000, [])
        seasonIdMap.set(Number(season.id), newId)
        if (season.is_active === false) {
          await db.query('UPDATE seasons SET is_active = false WHERE id = $1', [newId])
        }
        if (season.players && season.players.length > 0) {
          const newPlayerIds = season.players.map(oldId => playerIdMap.get(Number(oldId))).filter(Boolean)
          if (newPlayerIds.length > 0) await db.setSeasonPlayers(newId, newPlayerIds)
        }
      }
      console.log(`✅ Restored ${backupData.seasons.length} seasons`)

      // Restore matches
      let matchesRestored = 0, matchesSkipped = 0
      for (const match of backupData.matches) {
        const newSeasonId = seasonIdMap.get(Number(match.season_id))
        const newP1 = playerIdMap.get(Number(match.player1_id))
        const newP2 = match.player2_id ? playerIdMap.get(Number(match.player2_id)) : null
        const newP3 = playerIdMap.get(Number(match.player3_id))
        const newP4 = match.player4_id ? playerIdMap.get(Number(match.player4_id)) : null
        if (newSeasonId && newP1 && newP3) {
          try {
            await db.addMatchWithTimestamp(newSeasonId, match.play_date, newP1, newP2, newP3, newP4, match.team1_score, match.team2_score, match.winning_team, match.match_type || 'duo', match.created_at || null)
            matchesRestored++
          } catch (e) { console.error('❌ Error restoring match:', e.message); matchesSkipped++ }
        } else { matchesSkipped++ }
      }
      console.log(`✅ Restored ${matchesRestored} matches (${matchesSkipped} skipped)`)

      // Restore users
      let usersRestored = 0, usersSkipped = 0
      if (hasUsers) {
        for (const user of backupData.users) {
          if (user.username === currentUsername) { usersSkipped++; continue }
          if (await db.checkUsernameExists(user.username)) { usersSkipped++; continue }
          if (await db.checkEmailExists(user.email)) { usersSkipped++; continue }
          try {
            await db.restoreUser(user.username, user.email, user.password_hash, user.role, user.display_name, user.is_active, user.notes)
            usersRestored++
          } catch (e) { console.error('Error restoring user:', e.message); usersSkipped++ }
        }
        console.log(`✅ Restored ${usersRestored} users (${usersSkipped} skipped)`)
      }

      await rankingsCache.clear()
      res.json({
        success: true, message: 'Data restored successfully',
        restored: { players: backupData.players.length, seasons: backupData.seasons.length, matches: matchesRestored, users: usersRestored }
      })
    })
  )

  // ── Simple data backup (no users) ─────────────────────────────────────────
  router.get('/backup-data',
    authenticateToken, requireAdmin, conditionalRateLimit(exportLimiter),
    asyncHandler(async (req, res) => {
      const [players, seasons, matches] = await Promise.all([db.getPlayers(), db.getSeasons(), db.getMatches()])
      const fileName = `tennis-backup-${new Date().toISOString().split('T')[0]}-${Date.now()}.json`
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
      res.json({
        version: '1.0', timestamp: formatSecureTimestamp(), exportedBy: req.user.username,
        data: { players, seasons, matches },
        metadata: { playersCount: players.length, seasonsCount: seasons.length, matchesCount: matches.length }
      })
    })
  )

  // ── Simple data restore ───────────────────────────────────────────────────
  router.post('/restore-data',
    largeBodyParser, authenticateToken, requireAdmin, conditionalRateLimit(restoreLimiter),
    [
      body('backupData').isObject(), body('clearExisting').optional().isBoolean(),
      body('backupData.version').exists(), body('backupData.data').isObject()
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const { backupData, clearExisting = false } = req.body
      if (!backupData.data?.players || !backupData.data?.seasons || !backupData.data?.matches) {
        return res.status(400).json({ error: 'Invalid backup file structure' })
      }
      if (clearExisting) await db.clearAllData()
      const { players, seasons, matches } = backupData.data
      const results = { playersImported: 0, seasonsImported: 0, matchesImported: 0, errors: [] }

      for (const player of players) {
        try { await db.addPlayer(player.name); results.playersImported++ } catch (e) {
          if (!e.message.includes('UNIQUE constraint failed')) results.errors.push(`Player ${player.name}: ${e.message}`)
        }
      }
      const seasonMapping = new Map()
      for (const season of seasons) {
        try {
          const sid = await db.createSeason(season.name, season.start_date)
          seasonMapping.set(season.name, sid)
          if (season.end_date) await db.endSeason(sid, season.end_date)
          results.seasonsImported++
        } catch (e) { results.errors.push(`Season ${season.name}: ${e.message}`) }
      }
      await db.query('UPDATE seasons SET is_active = false', [])
      for (const season of seasons) {
        if (season.is_active) {
          const sid = seasonMapping.get(season.name)
          if (sid) {
            await db.query('UPDATE seasons SET is_active = $1 WHERE id = $2', [true, sid])
            if (season.end_date) await db.query('UPDATE seasons SET end_date = NULL WHERE id = $1', [sid])
          }
        }
      }
      const currentPlayers = await db.getPlayers()
      for (const match of matches) {
        try {
          const p1 = currentPlayers.find(p => p.name === match.player1_name)
          const p2 = currentPlayers.find(p => p.name === match.player2_name)
          const p3 = currentPlayers.find(p => p.name === match.player3_name)
          const p4 = currentPlayers.find(p => p.name === match.player4_name)
          const sid = seasonMapping.get(match.season_name)
          if (p1 && p2 && p3 && p4 && sid) {
            await db.addMatch(sid, match.play_date, p1.id, p2.id, p3.id, p4.id, match.team1_score, match.team2_score, match.winning_team)
            results.matchesImported++
          } else { results.errors.push(`Match ${match.id}: Missing players or season`) }
        } catch (e) { results.errors.push(`Match ${match.id}: ${e.message}`) }
      }

      await rankingsCache.clear()
      res.json({ success: true, message: 'Data restored successfully', results, timestamp: formatSecureTimestamp() })
    })
  )

  // ── Clear all data ────────────────────────────────────────────────────────
  router.delete('/clear-all-data',
    authenticateToken, requireAdmin, conditionalRateLimit(criticalLimiter),
    asyncHandler(async (req, res) => {
      console.log(`⚠️ CLEAR ALL DATA requested by user: ${req.user.username}`)
      await db.clearAllData()
      await rankingsCache.clear()
      console.log('✅ All data cleared successfully')
      res.json({ success: true, message: 'All data cleared successfully', timestamp: formatSecureTimestamp() })
    })
  )

  return router
}
