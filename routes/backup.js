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
      // Security: exclude password_hash from backup to prevent offline cracking if file leaks
      const usersForBackup = users.map(u => ({
        id: u.id, username: u.username, email: u.email,
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

      // Wrap entire restore in a transaction for all-or-nothing semantics
      const client = await db.pool.connect()
      let matchesRestored = 0, matchesSkipped = 0
      let usersRestored = 0, usersSkipped = 0
      try {
        await client.query('BEGIN')

        // Clear existing data (within transaction)
        await client.query('DELETE FROM matches')
        await client.query('DELETE FROM season_players')
        await client.query('DELETE FROM seasons')
        await client.query('DELETE FROM players')
        if (currentUserId) {
          await client.query('DELETE FROM users WHERE id != $1', [currentUserId])
        }
        await client.query('ALTER SEQUENCE players_id_seq RESTART WITH 1')
        await client.query('ALTER SEQUENCE seasons_id_seq RESTART WITH 1')
        await client.query('ALTER SEQUENCE matches_id_seq RESTART WITH 1')

        // Restore players
        const playerIdMap = new Map()
        for (const player of backupData.players) {
          const result = await client.query('INSERT INTO players (name) VALUES ($1) RETURNING id', [player.name])
          playerIdMap.set(Number(player.id), result.rows[0].id)
        }
        console.log(`✅ Restored ${backupData.players.length} players`)

        // Restore seasons
        const seasonIdMap = new Map()
        for (const season of backupData.seasons) {
          const result = await client.query(
            `INSERT INTO seasons (name, start_date, end_date, is_active, auto_end, description, lose_money_per_loss)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [season.name, season.start_date, season.end_date || null,
             season.is_active !== false, season.auto_end !== false,
             season.description || '', season.lose_money_per_loss || 20000]
          )
          const newId = result.rows[0].id
          seasonIdMap.set(Number(season.id), newId)

          if (season.players && season.players.length > 0) {
            const newPlayerIds = season.players.map(oldId => playerIdMap.get(Number(oldId))).filter(Boolean)
            for (const playerId of newPlayerIds) {
              await client.query(
                'INSERT INTO season_players (season_id, player_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
                [newId, playerId, 'restore']
              )
            }
          }
        }
        console.log(`✅ Restored ${backupData.seasons.length} seasons`)

        // Restore matches
        for (const match of backupData.matches) {
          const newSeasonId = seasonIdMap.get(Number(match.season_id))
          const newP1 = playerIdMap.get(Number(match.player1_id))
          const newP2 = match.player2_id ? playerIdMap.get(Number(match.player2_id)) : null
          const newP3 = playerIdMap.get(Number(match.player3_id))
          const newP4 = match.player4_id ? playerIdMap.get(Number(match.player4_id)) : null
          if (newSeasonId && newP1 && newP3) {
            try {
              const matchType = match.match_type || 'duo'
              if (match.created_at) {
                await client.query(
                  `INSERT INTO matches (season_id, play_date, player1_id, player2_id, player3_id, player4_id, team1_score, team2_score, winning_team, match_type, created_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                  [newSeasonId, match.play_date, newP1, newP2, newP3, newP4, match.team1_score, match.team2_score, match.winning_team, matchType, match.created_at]
                )
              } else {
                await client.query(
                  `INSERT INTO matches (season_id, play_date, player1_id, player2_id, player3_id, player4_id, team1_score, team2_score, winning_team, match_type)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                  [newSeasonId, match.play_date, newP1, newP2, newP3, newP4, match.team1_score, match.team2_score, match.winning_team, matchType]
                )
              }
              matchesRestored++
            } catch (e) { console.error('❌ Error restoring match:', e.message); matchesSkipped++ }
          } else { matchesSkipped++ }
        }
        console.log(`✅ Restored ${matchesRestored} matches (${matchesSkipped} skipped)`)

        // Restore users (within transaction)
        if (hasUsers) {
          for (const user of backupData.users) {
            if (user.username === currentUsername) { usersSkipped++; continue }
            const existsUser = await client.query('SELECT COUNT(*) as count FROM users WHERE username = $1', [user.username])
            if (parseInt(existsUser.rows[0].count) > 0) { usersSkipped++; continue }
            if (user.email) {
              const existsEmail = await client.query('SELECT COUNT(*) as count FROM users WHERE email = $1', [user.email])
              if (parseInt(existsEmail.rows[0].count) > 0) { usersSkipped++; continue }
            }
            try {
              await client.query(
                `INSERT INTO users (username, email, password_hash, role, display_name, is_active, created_by, notes)
                 VALUES ($1, $2, $3, $4, $5, $6, 'backup_restore', $7)`,
                [user.username, user.email, user.password_hash, user.role, user.display_name, user.is_active !== false, user.notes]
              )
              usersRestored++
            } catch (e) { console.error('Error restoring user:', e.message); usersSkipped++ }
          }
          console.log(`✅ Restored ${usersRestored} users (${usersSkipped} skipped)`)
        }

        await client.query('COMMIT')
        console.log('✅ Restore transaction committed successfully')
      } catch (error) {
        await client.query('ROLLBACK')
        console.error('❌ Restore failed, transaction rolled back:', error.message)
        throw error
      } finally {
        client.release()
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
