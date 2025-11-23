export default class RankingsCache {
  constructor({ ttl = 5 * 60 * 1000, devLogging = false } = {}) {
    this.cache = new Map()
    this.defaultTTL = ttl
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0,
      preloads: 0,
      expired: 0
    }
    this.devLogging = devLogging
  }

  log(message) {
    if (this.devLogging) {
      console.log(message)
    }
  }

  set(key, data, ttl = this.defaultTTL) {
    const expiresAt = Date.now() + ttl
    this.cache.set(key, {
      data,
      createdAt: Date.now(),
      expiresAt,
      accessCount: 0,
      lastAccessed: Date.now()
    })
    this.stats.sets++
    this.log(`📦 Cache SET: ${key} (TTL: ${ttl}ms)`)
  }

  get(key) {
    const item = this.cache.get(key)
    if (!item) {
      this.stats.misses++
      this.log(`❌ Cache MISS: ${key}`)
      return null
    }

    if (Date.now() > item.expiresAt) {
      this.cache.delete(key)
      this.stats.expired++
      this.stats.misses++
      this.log(`⏰ Cache EXPIRED: ${key}`)
      return null
    }

    item.accessCount++
    item.lastAccessed = Date.now()
    this.stats.hits++
    const timeLeft = Math.round((item.expiresAt - Date.now()) / 1000)
    this.log(`🎯 Cache HIT: ${key} (accessed ${item.accessCount} times, expires in ${timeLeft}s)`)
    return item.data
  }

  async preloadCommonData(db) {
    if (!db) return

    try {
      if (!this.cache.has('rankings:lifetime') || this.isExpired('rankings:lifetime')) {
        const rankings = await db.getPlayerStatsLifetime()
        const enhancedRankings = await Promise.all(rankings.map(async (player) => {
          const form = await db.getPlayerForm(player.id, 5)
          return { ...player, form }
        }))
        this.set('rankings:lifetime', enhancedRankings, 10 * 60 * 1000)
        this.stats.preloads++
        this.log('🚀 Cache PRELOAD: rankings:lifetime (10min TTL)')
      }

      const activeSeason = await db.getActiveSeason()
      if (activeSeason) {
        const seasonKey = `rankings:season:${activeSeason.id}`
        if (!this.cache.has(seasonKey) || this.isExpired(seasonKey)) {
          const seasonRankings = await db.getPlayerStatsBySeason(activeSeason.id)
          const enhancedSeasonRankings = await Promise.all(seasonRankings.map(async (player) => {
            const form = await db.getPlayerFormBySeason(player.id, activeSeason.id, 5)
            return { ...player, form }
          }))
          this.set(seasonKey, enhancedSeasonRankings, 3 * 60 * 1000)
          this.stats.preloads++
          this.log(`🚀 Cache PRELOAD: ${seasonKey} (3min TTL)`)
        }
      }
    } catch (error) {
      this.log(`Cache preload error (non-critical): ${error.message}`)
    }
  }

  isExpired(key) {
    const item = this.cache.get(key)
    if (!item) return true
    return Date.now() > item.expiresAt
  }

  cleanupExpired() {
    let cleanedCount = 0
    for (const [key, item] of this.cache.entries()) {
      if (Date.now() > item.expiresAt) {
        this.cache.delete(key)
        cleanedCount++
      }
    }

    if (cleanedCount > 0) {
      this.stats.expired += cleanedCount
      this.log(`🧹 Cache CLEANUP: ${cleanedCount} expired entries removed`)
    }

    return cleanedCount
  }

  invalidate(pattern = null) {
    let invalidated = 0

    if (pattern) {
      for (const key of this.cache.keys()) {
        if (key.includes(pattern)) {
          this.cache.delete(key)
          invalidated++
        }
      }
    } else {
      invalidated = this.cache.size
      this.cache.clear()
    }

    this.stats.invalidations += invalidated
    this.log(`🗑️ Cache INVALIDATE: ${invalidated} entries (pattern: ${pattern || 'all'})`)
  }

  clear() {
    const size = this.cache.size
    this.cache.clear()
    this.stats.invalidations += size
    this.log(`🧹 Cache CLEAR: ${size} entries removed`)
  }

  getStats() {
    const hitRate = this.stats.hits + this.stats.misses > 0
      ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2)
      : 0

    let expiredCount = 0
    for (const [, item] of this.cache.entries()) {
      if (Date.now() > item.expiresAt) {
        expiredCount++
      }
    }

    return {
      ...this.stats,
      hitRate: `${hitRate}%`,
      currentEntries: this.cache.size,
      expiredEntries: expiredCount,
      memoryUsage: JSON.stringify([...this.cache.entries()]).length
    }
  }

  resetStats() {
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0,
      preloads: 0,
      expired: 0
    }
  }
}
