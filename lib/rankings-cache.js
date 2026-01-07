import os from 'os'

export default class RankingsCache {
  constructor({ ttl = 5 * 60 * 1000, devLogging = false } = {}) {
    this.cache = new Map()
    this.defaultTTL = ttl
    this.devLogging = devLogging || process.env.NODE_ENV === 'development'
    
    // Dynamic resource-based limits
    this.baseMaxEntries = parseInt(process.env.CACHE_MAX_ENTRIES) || 0  // 0 = dynamic
    this.maxMemoryPercent = parseInt(process.env.CACHE_MAX_MEMORY_PERCENT) || 15  // Max 15% of system RAM
    this.minFreeMemoryMB = parseInt(process.env.CACHE_MIN_FREE_MEMORY_MB) || 256  // Keep 256MB free minimum
    
    // Critical keys that should never be evicted (rankings data is most important)
    this.criticalKeyPrefixes = ['rankings:lifetime', 'rankings:season', 'rankings:date']
    
    // Cleanup configuration
    this.cleanupIntervalMs = parseInt(process.env.CACHE_CLEANUP_INTERVAL) || 60000  // 1 minute
    this.preloadIntervalMs = parseInt(process.env.CACHE_PRELOAD_INTERVAL) || 240000  // 4 minutes
    
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0,
      preloads: 0,
      expired: 0,
      evictions: 0,
      resourceEvictions: 0,
      cleanups: 0
    }
    
    // Memory tracking
    this.currentMemoryBytes = 0
    
    // Start automatic cleanup timer
    this.startCleanupTimer()
  }

  log(message) {
    if (this.devLogging) {
      console.log(message)
    }
  }

  // Estimate object size in bytes
  estimateSize(obj) {
    try {
      return Buffer.byteLength(JSON.stringify(obj), 'utf8')
    } catch {
      return 1024  // Fallback estimate
    }
  }

  // Get dynamic max entries based on system resources
  getMaxEntries() {
    // If hard limit is set, use it
    if (this.baseMaxEntries > 0) {
      return this.baseMaxEntries
    }
    
    // Dynamic calculation based on available memory
    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    const usedByCache = this.currentMemoryBytes
    
    // Max memory for cache = min(15% of total, available - 256MB minimum)
    const maxCacheMemory = Math.min(
      totalMem * (this.maxMemoryPercent / 100),
      freeMem + usedByCache - (this.minFreeMemoryMB * 1024 * 1024)
    )
    
    // Estimate ~10KB per entry average
    const avgEntrySize = this.cache.size > 0 
      ? this.currentMemoryBytes / this.cache.size 
      : 10 * 1024
    
    const dynamicMax = Math.max(100, Math.floor(maxCacheMemory / avgEntrySize))
    
    return dynamicMax
  }

  // Check if system resources are under pressure
  isResourceConstrained() {
    const freeMem = os.freemem()
    const freeMemMB = freeMem / (1024 * 1024)
    
    // Resource constrained if free memory < 256MB
    return freeMemMB < this.minFreeMemoryMB
  }

  // Check if a key is critical (should not be evicted)
  isCriticalKey(key) {
    return this.criticalKeyPrefixes.some(prefix => key.startsWith(prefix))
  }

  set(key, data, ttl = this.defaultTTL) {
    const newSize = this.estimateSize(data)
    
    // Remove old entry size if updating existing key
    if (this.cache.has(key)) {
      const oldItem = this.cache.get(key)
      this.currentMemoryBytes -= oldItem.sizeBytes || 0
    }
    
    // Resource-aware eviction: only evict if resources are constrained
    if (this.isResourceConstrained() && !this.cache.has(key)) {
      const maxEntries = this.getMaxEntries()
      
      // Evict until we have room (but never evict critical keys)
      while (this.cache.size >= maxEntries) {
        if (!this.evictLRU(true)) {  // skipCritical = true
          this.log('⚠️ Cannot evict: all remaining keys are critical')
          break
        }
      }
    }

    const expiresAt = Date.now() + ttl
    this.cache.set(key, {
      data,
      sizeBytes: newSize,
      createdAt: Date.now(),
      expiresAt,
      accessCount: 0,
      lastAccessed: Date.now()
    })
    
    this.currentMemoryBytes += newSize
    this.stats.sets++
    
    const memMB = (this.currentMemoryBytes / (1024 * 1024)).toFixed(2)
    this.log(`📦 Cache SET: ${key} (${(newSize / 1024).toFixed(1)}KB) | Total: ${this.cache.size} entries, ${memMB}MB`)
  }

  // LRU eviction with critical key protection
  evictLRU(skipCritical = false) {
    let lruKey = null
    let lruTime = Infinity

    for (const [key, item] of this.cache.entries()) {
      // Skip critical keys if requested
      if (skipCritical && this.isCriticalKey(key)) {
        continue
      }
      
      if (item.lastAccessed < lruTime) {
        lruTime = item.lastAccessed
        lruKey = key
      }
    }

    if (lruKey) {
      const item = this.cache.get(lruKey)
      this.currentMemoryBytes -= item.sizeBytes || 0
      this.cache.delete(lruKey)
      this.stats.evictions++
      
      if (this.isResourceConstrained()) {
        this.stats.resourceEvictions++
      }
      
      this.log(`🗑️ Cache LRU EVICTION: ${lruKey}`)
      return true
    }
    
    return false
  }

  get(key) {
    const item = this.cache.get(key)
    if (!item) {
      this.stats.misses++
      this.log(`❌ Cache MISS: ${key}`)
      return null
    }

    if (Date.now() > item.expiresAt) {
      this.currentMemoryBytes -= item.sizeBytes || 0
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

  // Enhanced preload with 3 recent days
  async preloadCommonData(db) {
    if (!db) return

    try {
      // 1. Preload lifetime rankings (most important)
      if (!this.cache.has('rankings:lifetime') || this.isExpired('rankings:lifetime')) {
        const rankings = await db.getPlayerStatsLifetime()
        const enhancedRankings = await Promise.all(rankings.map(async (player) => {
          const form = await db.getPlayerForm(player.id, 5)
          return { ...player, form }
        }))
        this.set('rankings:lifetime', enhancedRankings, 10 * 60 * 1000)  // 10 min TTL
        this.stats.preloads++
        this.log('🚀 Cache PRELOAD: rankings:lifetime (10min TTL)')
      }

      // 2. Preload active season rankings
      const activeSeason = await db.getActiveSeason()
      if (activeSeason) {
        const seasonKey = `rankings:season:${activeSeason.id}`
        if (!this.cache.has(seasonKey) || this.isExpired(seasonKey)) {
          const seasonRankings = await db.getPlayerStatsBySeason(activeSeason.id)
          const enhancedSeasonRankings = await Promise.all(seasonRankings.map(async (player) => {
            const form = await db.getPlayerFormBySeason(player.id, activeSeason.id, 5)
            return { ...player, form }
          }))
          this.set(seasonKey, enhancedSeasonRankings, 5 * 60 * 1000)  // 5 min TTL
          this.stats.preloads++
          this.log(`🚀 Cache PRELOAD: ${seasonKey} (5min TTL)`)
        }
      }

      // 3. Preload 3 recent days rankings
      const today = new Date()
      for (let i = 0; i < 3; i++) {
        const date = new Date(today)
        date.setDate(date.getDate() - i)
        const dateStr = date.toISOString().split('T')[0]  // YYYY-MM-DD format
        const dateKey = `rankings:date:${dateStr}`
        
        if (!this.cache.has(dateKey) || this.isExpired(dateKey)) {
          try {
            const dateRankings = await db.getPlayerStatsByPlayDate(dateStr)
            if (dateRankings && dateRankings.length > 0) {
              // 15 min TTL for today, 30 min for older days
              const ttl = i === 0 ? 15 * 60 * 1000 : 30 * 60 * 1000
              this.set(dateKey, dateRankings, ttl)
              this.stats.preloads++
              this.log(`🚀 Cache PRELOAD: ${dateKey} (${ttl / 60000}min TTL)`)
            }
          } catch (error) {
            // Silently skip if no data for this date
            this.log(`ℹ️ No data for ${dateStr}: ${error.message}`)
          }
        }
      }
      
      // 4. Preload recent matches for the 3 days
      for (let i = 0; i < 3; i++) {
        const date = new Date(today)
        date.setDate(date.getDate() - i)
        const dateStr = date.toISOString().split('T')[0]
        const matchesKey = `matches:date:${dateStr}`
        
        if (!this.cache.has(matchesKey) || this.isExpired(matchesKey)) {
          try {
            const matches = await db.getMatchesByPlayDate(dateStr)
            if (matches && matches.length > 0) {
              const ttl = i === 0 ? 10 * 60 * 1000 : 20 * 60 * 1000
              this.set(matchesKey, matches, ttl)
              this.stats.preloads++
              this.log(`🚀 Cache PRELOAD: ${matchesKey} (${ttl / 60000}min TTL)`)
            }
          } catch (error) {
            this.log(`ℹ️ No matches for ${dateStr}: ${error.message}`)
          }
        }
      }

    } catch (error) {
      console.error(`Cache preload error: ${error.message}`)
    }
  }

  isExpired(key) {
    const item = this.cache.get(key)
    if (!item) return true
    return Date.now() > item.expiresAt
  }

  // Start automatic cleanup timer
  startCleanupTimer() {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired()
    }, this.cleanupIntervalMs)
    
    // Don't keep process alive just for cleanup
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref()
    }
    
    this.log(`🔄 Cache cleanup timer started (every ${this.cleanupIntervalMs / 1000}s)`)
  }

  stopCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
      this.log('⏹️ Cache cleanup timer stopped')
    }
  }

  cleanupExpired() {
    let cleanedCount = 0
    let freedBytes = 0
    const now = Date.now()
    
    for (const [key, item] of this.cache.entries()) {
      if (now > item.expiresAt) {
        freedBytes += item.sizeBytes || 0
        this.cache.delete(key)
        cleanedCount++
      }
    }

    if (cleanedCount > 0) {
      this.currentMemoryBytes -= freedBytes
      this.stats.expired += cleanedCount
      this.stats.cleanups++
      this.log(`🧹 Cache CLEANUP: ${cleanedCount} expired, freed ${(freedBytes / 1024).toFixed(1)}KB`)
    }

    return cleanedCount
  }

  invalidate(pattern = null) {
    let invalidated = 0
    let freedBytes = 0

    if (pattern) {
      for (const [key, item] of this.cache.entries()) {
        if (key.includes(pattern)) {
          freedBytes += item.sizeBytes || 0
          this.cache.delete(key)
          invalidated++
        }
      }
    } else {
      invalidated = this.cache.size
      freedBytes = this.currentMemoryBytes
      this.cache.clear()
    }

    this.currentMemoryBytes -= freedBytes
    this.stats.invalidations += invalidated
    this.log(`🗑️ Cache INVALIDATE: ${invalidated} entries (pattern: ${pattern || 'all'})`)
  }

  clear() {
    const size = this.cache.size
    this.cache.clear()
    this.currentMemoryBytes = 0
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

    // Memory info
    const freeMem = os.freemem()
    const totalMem = os.totalmem()
    const freeMemMB = (freeMem / (1024 * 1024)).toFixed(0)
    const cacheMemMB = (this.currentMemoryBytes / (1024 * 1024)).toFixed(2)

    return {
      ...this.stats,
      hitRate: `${hitRate}%`,
      currentEntries: this.cache.size,
      expiredEntries: expiredCount,
      memoryUsageMB: cacheMemMB,
      systemFreeMemMB: freeMemMB,
      systemTotalMemMB: (totalMem / (1024 * 1024)).toFixed(0),
      resourceConstrained: this.isResourceConstrained(),
      dynamicMaxEntries: this.getMaxEntries()
    }
  }

  resetStats() {
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0,
      preloads: 0,
      expired: 0,
      evictions: 0,
      resourceEvictions: 0,
      cleanups: 0
    }
  }
}
