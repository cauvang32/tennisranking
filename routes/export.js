import { Router } from 'express'
import { asyncHandler } from '../utils/async-handler.js'
import {
  createFullExportBuffer,
  createDateExportBuffer,
  createSeasonExportBuffer,
  createLifetimeExportBuffer
} from '../utils/excel-helper.js'

export const createExportRouter = ({
  db,
  authenticateToken,
  requireEditor,
  conditionalRateLimit,
  exportLimiter
}) => {
  const router = Router()

  // Full export (all data)
  router.get('/', authenticateToken, requireEditor, conditionalRateLimit(exportLimiter), asyncHandler(async (req, res) => {
    const [players, seasons, matches, rankings] = await Promise.all([
      db.getPlayers(),
      db.getSeasons(),
      db.getMatches(),
      db.getPlayerStatsLifetime()
    ])

    const buffer = await createFullExportBuffer({ players, seasons, matches, rankings })
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="tennis-rankings-${new Date().toISOString().split('T')[0]}.xlsx"`)
    res.send(buffer)
  }))

  // Export by date
  router.get('/date/:date', authenticateToken, requireEditor, conditionalRateLimit(exportLimiter), asyncHandler(async (req, res) => {
    const { date } = req.params
    
    const [rankings, matches] = await Promise.all([
      db.getPlayerStatsBySpecificDate(date),
      db.getMatchesByDate(date)
    ])

    const buffer = await createDateExportBuffer({ date, rankings, matches })
    
    // XSS Protection: Sanitize filename (only allow alphanumeric, dash, underscore)
    const sanitizedDate = date.replace(/[^a-zA-Z0-9-_]/g, '')
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="tennis-rankings-${sanitizedDate}.xlsx"`)
    res.send(buffer)
  }))

  // Export by season
  router.get('/season/:seasonId', authenticateToken, requireEditor, conditionalRateLimit(exportLimiter), asyncHandler(async (req, res) => {
    const { seasonId } = req.params
    
    // XSS Protection: Validate seasonId is numeric (sanitization)
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
    
    // XSS Protection: seasonId already validated as numeric above, but sanitize for safety
    const sanitizedSeasonId = seasonId.replace(/[^0-9]/g, '')
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="tennis-rankings-season-${sanitizedSeasonId}.xlsx"`)
    res.send(buffer)
  }))

  // Export lifetime
  router.get('/lifetime', authenticateToken, requireEditor, conditionalRateLimit(exportLimiter), asyncHandler(async (req, res) => {
    const [players, seasons, matches, rankings] = await Promise.all([
      db.getPlayers(),
      db.getSeasons(),
      db.getMatches(),
      db.getPlayerStatsLifetime()
    ])

    const buffer = await createLifetimeExportBuffer({ players, seasons, matches, rankings })
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="tennis-rankings-lifetime.xlsx"')
    res.send(buffer)
  }))

  return router
}
