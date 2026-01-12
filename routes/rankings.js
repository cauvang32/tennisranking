import { Router } from 'express'
import { asyncHandler } from '../utils/async-handler.js'

// DoS mitigation: Process form queries in batches to avoid overwhelming the database
// Instead of limiting results (which cuts off players), we batch the additional queries
const BATCH_SIZE = 50

export const createRankingRouter = ({ db, checkAuth, rankingsCache }) => {
  const router = Router()

  router.get('/lifetime', checkAuth, asyncHandler(async (req, res) => {
    const cacheKey = 'rankings:lifetime'
    let rankings = rankingsCache.get(cacheKey)
    let cacheHit = true

    if (!rankings) {
      cacheHit = false
      rankings = await db.getPlayerStatsLifetime()
      
      // DoS mitigation: Process form queries in batches to prevent spawning too many concurrent DB queries
      for (let i = 0; i < rankings.length; i += BATCH_SIZE) {
        const batch = rankings.slice(i, i + BATCH_SIZE)
        const forms = await Promise.all(batch.map(player => 
          db.getPlayerForm(player.id, 5)
        ))
        batch.forEach((player, idx) => {
          player.form = forms[idx]
        })
      }
      
      rankingsCache.set(cacheKey, rankings, 10 * 60 * 1000)
    }

    res.set('X-Cache', cacheHit ? 'HIT' : 'MISS')
    res.set('X-Cache-Key', cacheKey)
    res.json(rankings)
  }))

  router.get('/season/:seasonId', checkAuth, asyncHandler(async (req, res) => {
    const seasonId = parseInt(req.params.seasonId)
    const cacheKey = `rankings:season:${seasonId}`
    let rankings = rankingsCache.get(cacheKey)
    let cacheHit = true

    if (!rankings) {
      cacheHit = false
      rankings = await db.getPlayerStatsBySeason(seasonId)
      
      // DoS mitigation: Validate array length and process in batches
      const MAX_RANKINGS = 10000 // Reasonable limit for rankings
      if (rankings.length > MAX_RANKINGS) {
        return res.status(400).json({ error: 'Rankings list exceeds maximum limit' })
      }
      
      // DoS mitigation: Process form queries in batches
      for (let i = 0; i < rankings.length; i += BATCH_SIZE) {
        const batch = rankings.slice(i, i + BATCH_SIZE)
        const forms = await Promise.all(batch.map(player => 
          db.getPlayerFormBySeason(player.id, seasonId, 5)
        ))
        batch.forEach((player, idx) => {
          player.form = forms[idx]
        })
      }
      
      rankingsCache.set(cacheKey, rankings, 3 * 60 * 1000)
    }

    res.set('X-Cache', cacheHit ? 'HIT' : 'MISS')
    res.set('X-Cache-Key', cacheKey)
    res.json(rankings)
  }))

  router.get('/date/:date', checkAuth, asyncHandler(async (req, res) => {
    const { date } = req.params
    const cacheKey = `rankings:date:${date}`
    let rankings = rankingsCache.get(cacheKey)
    let cacheHit = true

    if (!rankings) {
      cacheHit = false
      rankings = await db.getPlayerStatsBySpecificDate(date)
      
      // DoS mitigation: Validate array length and process in batches
      const MAX_RANKINGS = 10000 // Reasonable limit for rankings
      if (rankings.length > MAX_RANKINGS) {
        return res.status(400).json({ error: 'Rankings list exceeds maximum limit' })
      }
      
      // DoS mitigation: Process form queries in batches
      for (let i = 0; i < rankings.length; i += BATCH_SIZE) {
        const batch = rankings.slice(i, i + BATCH_SIZE)
        const forms = await Promise.all(batch.map(player => 
          db.getPlayerFormBySpecificDate(player.id, date, 5)
        ))
        batch.forEach((player, idx) => {
          player.form = forms[idx]
        })
      }
      
      rankingsCache.set(cacheKey, rankings, 15 * 60 * 1000)
    }

    res.set('X-Cache', cacheHit ? 'HIT' : 'MISS')
    res.set('X-Cache-Key', cacheKey)
    res.json(rankings)
  }))

  return router
}
