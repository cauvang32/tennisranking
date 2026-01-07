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
  checkAuth,
  authenticateToken,
  conditionalRateLimit,
  exportLimiter
}) => {
  const router = Router()

  // Full export (all data)
  router.get('/', checkAuth, conditionalRateLimit(exportLimiter), asyncHandler(async (req, res) => {
    const [players, seasons, matches, rankings] = await Promise.all([
      db.getPlayers(),
      db.getSeasons(),
      db.getMatches(),
      db.getPlayerStatsLifetime()
    ])

    const buffer = await createFullExportBuffer({ players, seasons, matches, rankings })
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="tennis-rankings-${new Date().toISOString().split('T')[0]}.xlsx"`)
    res.send(Buffer.from(buffer))
  }))

  // Export by date
  router.get('/date/:date', checkAuth, conditionalRateLimit(exportLimiter), asyncHandler(async (req, res) => {
    const { date } = req.params
    
    const [rankings, matches] = await Promise.all([
      db.getPlayerStatsBySpecificDate(date),
      db.getMatchesByDate(date)
    ])

    const buffer = await createDateExportBuffer({ date, rankings, matches })
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="tennis-rankings-${date}.xlsx"`)
    res.send(Buffer.from(buffer))
  }))

  // Export by season
  router.get('/season/:seasonId', checkAuth, conditionalRateLimit(exportLimiter), asyncHandler(async (req, res) => {
    const { seasonId } = req.params
    
    const [season, rankings, matches] = await Promise.all([
      db.getSeasonById(seasonId),
      db.getPlayerStatsBySeason(seasonId),
      db.getMatchesBySeason(seasonId)
    ])
    
    const seasonName = season ? season.name : `Mùa ${seasonId}`
    const buffer = await createSeasonExportBuffer({ seasonName, rankings, matches })
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="tennis-rankings-season-${seasonId}.xlsx"`)
    res.send(Buffer.from(buffer))
  }))

  // Export lifetime
  router.get('/lifetime', checkAuth, conditionalRateLimit(exportLimiter), asyncHandler(async (req, res) => {
    const [players, seasons, matches, rankings] = await Promise.all([
      db.getPlayers(),
      db.getSeasons(),
      db.getMatches(),
      db.getPlayerStatsLifetime()
    ])

    const buffer = await createLifetimeExportBuffer({ players, seasons, matches, rankings })
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="tennis-rankings-lifetime.xlsx"')
    res.send(Buffer.from(buffer))
  }))

  return router
}
