import { Router } from 'express'
import { asyncHandler } from '../utils/async-handler.js'

export const createRankingRouter = ({ db, checkAuth, rankingsCache }) => {
  const router = Router()

  router.get('/lifetime', checkAuth, asyncHandler(async (req, res) => {
    const cacheKey = 'rankings:lifetime'

    // Stampede-protected cache: only one request rebuilds on miss
    const { data: rankings, hit: cacheHit } = await rankingsCache.getOrSet(
      cacheKey,
      // Use optimized batch method (2 queries instead of N+1)
      () => db.getPlayerStatsWithFormsLifetime(5)
    )

    res.set('X-Cache', cacheHit ? 'HIT' : 'MISS')
    res.set('X-Cache-Key', cacheKey)
    res.json(rankings)
  }))

  router.get('/season/:seasonId', checkAuth, asyncHandler(async (req, res) => {
    const seasonId = parseInt(req.params.seasonId)
    const cacheKey = `rankings:season:${seasonId}`

    // Stampede-protected cache with optimized batch query
    const { data: rankings, hit: cacheHit } = await rankingsCache.getOrSet(
      cacheKey,
      // Use optimized batch method (2 queries instead of N+1)
      () => db.getPlayerStatsWithFormsBySeason(seasonId, 5)
    )

    res.set('X-Cache', cacheHit ? 'HIT' : 'MISS')
    res.set('X-Cache-Key', cacheKey)
    res.json(rankings)
  }))

  router.get('/date/:date', checkAuth, asyncHandler(async (req, res) => {
    const { date } = req.params
    const cacheKey = `rankings:date:${date}`

    // Stampede-protected cache with parallel batch form loading
    const { data: rankings, hit: cacheHit } = await rankingsCache.getOrSet(
      cacheKey,
      async () => {
        const stats = await db.getPlayerStatsBySpecificDate(date)
        if (stats.length === 0) return stats

        // Parallel batch: fetch all player forms concurrently using Promise.all
        const playerIds = stats.map(p => p.id)
        const formResults = await Promise.all(
          playerIds.map(id => db.getPlayerFormBySpecificDate(id, date, 5))
        )
        stats.forEach((player, idx) => {
          player.form = formResults[idx]
        })
        return stats
      }
    )

    res.set('X-Cache', cacheHit ? 'HIT' : 'MISS')
    res.set('X-Cache-Key', cacheKey)
    res.json(rankings)
  }))

  return router
}
