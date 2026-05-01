import { Router } from 'express'
import { asyncHandler } from '../utils/async-handler.js'
import {
  createDateExportBuffer,
  createSeasonExportBuffer,
  MATCHES_FULL_COLUMNS
} from '../utils/excel-helper.js'
import { streamExcelResponse } from '../utils/stream-helper.js'

export const createExportRouter = ({
  db,
  authenticateToken,
  requireEditor,
  conditionalRateLimit,
  exportLimiter
}) => {
  const router = Router()

  // SQL for full match export (used by streaming path)
  const MATCHES_EXPORT_SQL = `
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

  // Full export (all data) — streams matches via cursor
  router.get('/', authenticateToken, requireEditor, conditionalRateLimit(exportLimiter), asyncHandler(async (req, res) => {
    const filename = `tennis-rankings-${new Date().toISOString().split('T')[0]}.xlsx`
    await streamExcelResponse(db.pool, MATCHES_EXPORT_SQL, [], res, {
      columns: MATCHES_FULL_COLUMNS,
      filename
    })
  }))

  // Export by date (small dataset — non-streamed is fine)
  router.get('/date/:date', authenticateToken, requireEditor, conditionalRateLimit(exportLimiter), asyncHandler(async (req, res) => {
    const { date } = req.params
    
    const [rankings, matches] = await Promise.all([
      db.getPlayerStatsBySpecificDate(date),
      db.getMatchesByDate(date)
    ])

    const buffer = await createDateExportBuffer({ date, rankings, matches })
    
    const sanitizedDate = date.replace(/[^a-zA-Z0-9-_]/g, '')
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="tennis-rankings-${sanitizedDate}.xlsx"`)
    res.send(buffer)
  }))

  // Export by season (bounded by season — non-streamed is fine)
  router.get('/season/:seasonId', authenticateToken, requireEditor, conditionalRateLimit(exportLimiter), asyncHandler(async (req, res) => {
    const { seasonId } = req.params
    
    if (!/^\d+$/.test(seasonId)) {
      return res.status(400).json({ error: 'Invalid season ID' })
    }
    
    const [season, rankings, matches] = await Promise.all([
      db.getSeasonById(seasonId),
      db.getPlayerStatsBySeason(seasonId),
      db.getMatchesBySeason(seasonId)
    ])
    
    const seasonName = season ? season.name : `Mùa ${seasonId}`
    const buffer = await createSeasonExportBuffer({ seasonName, rankings, matches })
    
    const sanitizedSeasonId = seasonId.replace(/[^0-9]/g, '')
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="tennis-rankings-season-${sanitizedSeasonId}.xlsx"`)
    res.send(buffer)
  }))

  // Export lifetime — rankings only (single sheet)
  router.get('/lifetime', authenticateToken, requireEditor, conditionalRateLimit(exportLimiter), asyncHandler(async (req, res) => {
    const rankings = await db.getPlayerStatsWithFormsLifetime(5)
    const { processRankingsData, RANKINGS_COLUMNS, writeExcelBuffer } = await import('../utils/excel-helper.js')
    const processedRankings = processRankingsData(rankings)

    const buffer = await writeExcelBuffer([
      { name: 'Bảng xếp hạng tổng', data: processedRankings, columns: RANKINGS_COLUMNS }
    ])

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="tennis-rankings-lifetime.xlsx"')
    res.send(Buffer.from(buffer))
  }))

  return router
}
