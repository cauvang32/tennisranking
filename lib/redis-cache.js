import Redis from 'ioredis'

/**
 * Redis-based cache for tennis rankings system
 * Replaces the in-memory cache with distributed Redis caching
 * 
 * Cache Keys:
 * - tennis:rankings:lifetime - Lifetime player rankings with forms
 * - tennis:rankings:season:{id} - Season-specific rankings
 * - tennis:players - All players list
 * - tennis:seasons - All seasons list
 * - tennis:season:active - Currently active season
 * - tennis:matches:date:{YYYY-MM-DD} - Matches for specific date (last 5 days with matches)
 * - tennis:playdates - List of all play dates
 * - tennis:version - Data version for client cache sync
 */
export default class RedisCache {
  constructor(options = {}) {
    this.prefix = options.prefix || 'tennis:'
    this.defaultTTL = options.ttl || 24 * 60 * 60 // 24 hours in seconds
    this.devLogging = options.devLogging || process.env.NODE_ENV === 'development'
    
    // Redis connection config
    this.redisUrl = options.redisUrl || process.env.REDIS_URL || 'redis://localhost:6379'
    this.client = null
    this.subscriber = null // For PostgreSQL LISTEN/NOTIFY
    this.pgClient = null // PostgreSQL client for LISTEN
    this.isConnected = false
    
    // Stats tracking
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0,
      preloads: 0,
      errors: 0,
      connectionRetries: 0
    }
    
    // Data version for client synchronization
    this.dataVersion = Date.now()
  }

  log(message) {
    if (this.devLogging) {
      console.log(message)
    }
  }

  /**
   * Initialize Redis connection
   */
  async connect() {
    if (this.client && this.isConnected) {
      return true
    }

    try {
      this.client = new Redis(this.redisUrl, {
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 100,
        enableReadyCheck: true,
        lazyConnect: false,
        reconnectOnError: (err) => {
          const targetError = 'READONLY'
          if (err.message.includes(targetError)) {
            return true
          }
          return false
        }
      })

      this.client.on('connect', () => {
        this.isConnected = true
        this.log('🟢 Redis connected')
      })

      this.client.on('error', (err) => {
        this.stats.errors++
        console.error('❌ Redis error:', err.message)
      })

      this.client.on('close', () => {
        this.isConnected = false
        this.log('🔴 Redis connection closed')
      })

      this.client.on('reconnecting', () => {
        this.stats.connectionRetries++
        this.log('🔄 Redis reconnecting...')
      })

      // Wait for connection
      await this.client.ping()
      this.isConnected = true
      
      // Initialize data version from Redis or set new one
      const storedVersion = await this.client.get(`${this.prefix}version`)
      if (storedVersion) {
        this.dataVersion = parseInt(storedVersion, 10)
      } else {
        await this.client.set(`${this.prefix}version`, this.dataVersion.toString())
      }
      
      this.log(`🚀 Redis cache initialized (version: ${this.dataVersion})`)
      return true
    } catch (error) {
      this.stats.errors++
      console.error('❌ Redis connection failed:', error.message)
      this.isConnected = false
      return false
    }
  }

  /**
   * Subscribe to PostgreSQL NOTIFY events for cache invalidation
   * @param {object} pgPool - PostgreSQL pool from database module
   */
  async subscribeToDbChanges(pgPool) {
    if (!pgPool) {
      this.log('⚠️ No PostgreSQL pool provided for LISTEN/NOTIFY')
      return
    }

    try {
      this.pgClient = await pgPool.connect()
      
      // Subscribe to cache invalidation channel
      await this.pgClient.query('LISTEN cache_invalidation')
      
      this.pgClient.on('notification', async (msg) => {
        if (msg.channel === 'cache_invalidation') {
          try {
            const payload = JSON.parse(msg.payload)
            await this.handleDbChange(payload)
          } catch (parseError) {
            console.error('❌ Failed to parse notification payload:', parseError.message)
          }
        }
      })
      
      this.log('🔔 Subscribed to PostgreSQL cache_invalidation channel')
    } catch (error) {
      console.error('❌ Failed to subscribe to PostgreSQL notifications:', error.message)
    }
  }

  /**
   * Handle database change notifications for selective cache invalidation
   * @param {object} payload - { table, action, id, date }
   */
  async handleDbChange(payload) {
    const { table, action, date } = payload
    this.log(`📣 DB Change: ${table}.${action}${date ? ` (date: ${date})` : ''}`)

    switch (table) {
      case 'matches':
        await this.invalidateOnMatchChange(date)
        break
      case 'players':
        await this.invalidateOnPlayerChange()
        break
      case 'seasons':
        await this.invalidateOnSeasonChange()
        break
      default:
        // Unknown table, clear all rankings to be safe
        await this.invalidateByPrefix('rankings:')
    }

    // Increment version for client sync
    await this.incrementVersion()
  }

  /**
   * Store data in Redis cache with TTL
   * @param {string} key - Cache key (without prefix)
   * @param {any} data - Data to cache (will be JSON serialized)
   * @param {number} ttl - TTL in seconds (default: 24 hours)
   */
  async set(key, data, ttl = this.defaultTTL) {
    if (!this.isConnected) {
      this.log(`⚠️ Redis not connected, skipping set: ${key}`)
      return false
    }

    try {
      const fullKey = `${this.prefix}${key}`
      const serialized = JSON.stringify(data)
      
      await this.client.setex(fullKey, ttl, serialized)
      this.stats.sets++
      
      const sizeKB = (Buffer.byteLength(serialized, 'utf8') / 1024).toFixed(1)
      this.log(`📦 Cache SET: ${key} (${sizeKB}KB, TTL: ${ttl}s)`)
      return true
    } catch (error) {
      this.stats.errors++
      console.error(`❌ Redis SET error for ${key}:`, error.message)
      return false
    }
  }

  /**
   * Retrieve data from Redis cache
   * @param {string} key - Cache key (without prefix)
   * @returns {any|null} - Parsed data or null if not found/expired
   */
  async get(key) {
    if (!this.isConnected) {
      this.stats.misses++
      return null
    }

    try {
      const fullKey = `${this.prefix}${key}`
      const data = await this.client.get(fullKey)
      
      if (data === null) {
        this.stats.misses++
        this.log(`❌ Cache MISS: ${key}`)
        return null
      }
      
      this.stats.hits++
      const ttl = await this.client.ttl(fullKey)
      this.log(`🎯 Cache HIT: ${key} (expires in ${ttl}s)`)
      return JSON.parse(data)
    } catch (error) {
      this.stats.errors++
      this.stats.misses++
      console.error(`❌ Redis GET error for ${key}:`, error.message)
      return null
    }
  }

  /**
   * Delete a specific key from cache
   * @param {string} key - Cache key (without prefix)
   */
  async delete(key) {
    if (!this.isConnected) return false

    try {
      const fullKey = `${this.prefix}${key}`
      const deleted = await this.client.del(fullKey)
      
      if (deleted > 0) {
        this.stats.invalidations++
        this.log(`🗑️ Cache DELETE: ${key}`)
      }
      return deleted > 0
    } catch (error) {
      this.stats.errors++
      console.error(`❌ Redis DELETE error for ${key}:`, error.message)
      return false
    }
  }

  /**
   * Delete all keys matching a prefix pattern
   * @param {string} pattern - Key pattern to match (without main prefix)
   */
  async invalidateByPrefix(pattern) {
    if (!this.isConnected) return 0

    try {
      const fullPattern = `${this.prefix}${pattern}*`
      let cursor = '0'
      let totalDeleted = 0
      
      // Use SCAN to safely iterate over keys
      do {
        const [newCursor, keys] = await this.client.scan(cursor, 'MATCH', fullPattern, 'COUNT', 100)
        cursor = newCursor
        
        if (keys.length > 0) {
          const deleted = await this.client.del(...keys)
          totalDeleted += deleted
        }
      } while (cursor !== '0')
      
      if (totalDeleted > 0) {
        this.stats.invalidations += totalDeleted
        this.log(`🗑️ Cache INVALIDATE: ${pattern}* (${totalDeleted} keys)`)
      }
      return totalDeleted
    } catch (error) {
      this.stats.errors++
      console.error(`❌ Redis INVALIDATE error for ${pattern}:`, error.message)
      return 0
    }
  }

  /**
   * Clear all cache entries
   */
  async clear() {
    if (!this.isConnected) return 0

    try {
      const deleted = await this.invalidateByPrefix('')
      await this.incrementVersion()
      this.log(`🧹 Cache CLEAR: ${deleted} entries removed`)
      return deleted
    } catch (error) {
      this.stats.errors++
      console.error('❌ Redis CLEAR error:', error.message)
      return 0
    }
  }

  /**
   * Invalidate cache when a match changes
   * Clears: rankings (all types), matches for that date, playdates
   * @param {string} date - Match date in YYYY-MM-DD format
   */
  async invalidateOnMatchChange(date) {
    this.log(`🔄 Invalidating cache for match change (date: ${date || 'unknown'})`)
    
    await Promise.all([
      this.invalidateByPrefix('rankings:'),
      date ? this.delete(`matches:date:${date}`) : this.invalidateByPrefix('matches:date:'),
      this.delete('playdates')
    ])
  }

  /**
   * Invalidate cache when a player changes
   * Clears: rankings (all types), players list
   */
  async invalidateOnPlayerChange() {
    this.log('🔄 Invalidating cache for player change')
    
    await Promise.all([
      this.invalidateByPrefix('rankings:'),
      this.delete('players')
    ])
  }

  /**
   * Invalidate cache when a season changes
   * Clears: rankings (all types), seasons list, active season
   */
  async invalidateOnSeasonChange() {
    this.log('🔄 Invalidating cache for season change')
    
    await Promise.all([
      this.invalidateByPrefix('rankings:'),
      this.delete('seasons'),
      this.delete('season:active')
    ])
  }

  /**
   * Increment data version for client cache sync
   */
  async incrementVersion() {
    this.dataVersion = Date.now()
    if (this.isConnected) {
      try {
        await this.client.set(`${this.prefix}version`, this.dataVersion.toString())
      } catch (error) {
        console.error('❌ Failed to update cache version:', error.message)
      }
    }
  }

  /**
   * Get current data version for client sync
   */
  getDataVersion() {
    return this.dataVersion
  }

  /**
   * Preload common cache data for performance
   * @param {object} db - Database instance
   */
  async preloadCommonData(db) {
    if (!db || !this.isConnected) return

    try {
      // 1. Preload lifetime rankings
      const lifetimeKey = 'rankings:lifetime'
      const cachedLifetime = await this.get(lifetimeKey)
      
      if (!cachedLifetime) {
        const rankings = await db.getPlayerStatsLifetime()
        const enhancedRankings = await Promise.all(rankings.map(async (player) => {
          const form = await db.getPlayerForm(player.id, 5)
          return { ...player, form }
        }))
        await this.set(lifetimeKey, enhancedRankings)
        this.stats.preloads++
        this.log('🚀 Cache PRELOAD: rankings:lifetime')
      }

      // 2. Preload active season rankings
      const activeSeason = await db.getActiveSeason()
      if (activeSeason) {
        const seasonKey = `rankings:season:${activeSeason.id}`
        const cachedSeason = await this.get(seasonKey)
        
        if (!cachedSeason) {
          const seasonRankings = await db.getPlayerStatsBySeason(activeSeason.id)
          const enhancedSeasonRankings = await Promise.all(seasonRankings.map(async (player) => {
            const form = await db.getPlayerFormBySeason(player.id, activeSeason.id, 5)
            return { ...player, form }
          }))
          await this.set(seasonKey, enhancedSeasonRankings)
          this.stats.preloads++
          this.log(`🚀 Cache PRELOAD: ${seasonKey}`)
        }

        // Cache active season object
        await this.set('season:active', activeSeason)
      }

      // 3. Preload players list
      const cachedPlayers = await this.get('players')
      if (!cachedPlayers) {
        const players = await db.getAllPlayers()
        await this.set('players', players)
        this.stats.preloads++
        this.log('🚀 Cache PRELOAD: players')
      }

      // 4. Preload seasons list
      const cachedSeasons = await this.get('seasons')
      if (!cachedSeasons) {
        const seasons = await db.getSeasons()
        await this.set('seasons', seasons)
        this.stats.preloads++
        this.log('🚀 Cache PRELOAD: seasons')
      }

      // 5. Preload last 5 days with matches
      const playDates = await db.getPlayDates()
      const last5Dates = playDates.slice(0, 5)
      
      await this.set('playdates', playDates)
      
      for (const dateRow of last5Dates) {
        const dateStr = dateRow.play_date
        const matchesKey = `matches:date:${dateStr}`
        const cachedMatches = await this.get(matchesKey)
        
        if (!cachedMatches) {
          try {
            const matches = await db.getMatchesByPlayDate(dateStr)
            if (matches && matches.length > 0) {
              await this.set(matchesKey, matches)
              this.stats.preloads++
              this.log(`🚀 Cache PRELOAD: ${matchesKey}`)
            }
          } catch (error) {
            this.log(`ℹ️ No matches for ${dateStr}: ${error.message}`)
          }
        }
      }

      this.log(`✅ Cache preload complete (${this.stats.preloads} entries)`)
    } catch (error) {
      console.error('❌ Cache preload error:', error.message)
    }
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const hitRate = this.stats.hits + this.stats.misses > 0
      ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2)
      : 0

    return {
      ...this.stats,
      hitRate: `${hitRate}%`,
      isConnected: this.isConnected,
      dataVersion: this.dataVersion
    }
  }

  /**
   * Get detailed cache info from Redis
   */
  async getInfo() {
    if (!this.isConnected) {
      return { error: 'Not connected' }
    }

    try {
      // Count keys with our prefix
      let cursor = '0'
      let totalKeys = 0
      
      do {
        const [newCursor, keys] = await this.client.scan(cursor, 'MATCH', `${this.prefix}*`, 'COUNT', 100)
        cursor = newCursor
        totalKeys += keys.length
      } while (cursor !== '0')

      const info = await this.client.info('memory')
      const usedMemory = info.match(/used_memory_human:(\S+)/)?.[1] || 'unknown'

      return {
        ...this.getStats(),
        currentEntries: totalKeys,
        memoryUsage: usedMemory
      }
    } catch (error) {
      return { error: error.message }
    }
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0,
      preloads: 0,
      errors: 0,
      connectionRetries: 0
    }
  }

  /**
   * Disconnect from Redis
   */
  async disconnect() {
    if (this.pgClient) {
      this.pgClient.release()
      this.pgClient = null
    }
    
    if (this.client) {
      await this.client.quit()
      this.client = null
      this.isConnected = false
      this.log('🔴 Redis disconnected')
    }
  }
}
