import Redis from 'ioredis'
import { EventEmitter } from 'events'

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
export default class RedisCache extends EventEmitter {
  constructor(options = {}) {
    super()
    this.prefix = options.prefix || 'tennis:'
    this.defaultTTL = options.ttl || 24 * 60 * 60 // 24 hours in seconds
    this.devLogging = options.devLogging || process.env.NODE_ENV === 'development'
    
    // Redis connection config
    this.redisUrl = options.redisUrl || process.env.REDIS_URL || 'redis://localhost:6379'
    this.client = null
    this.subscriber = null // For PostgreSQL LISTEN/NOTIFY
    this.pgClient = null // PostgreSQL client for LISTEN
    this.isConnected = false
    this.connectPromise = null
    this.reconnectTimer = null
    this.retryAttempt = 0
    this.maxReconnectDelayMs = 60000
    
    // Startup cache keys - stored permanently (no TTL), recreated on invalidation
    // These are preloaded at server startup and kept fresh via invalidation
    this.startupCacheKeys = new Set([
      'rankings:lifetime',
      'players',
      'seasons',
      'playdates',
      'playdate:latest',
      'season:active',
      'seasons:active'
      // Note: rankings:season:{id} and rankings:date:{date} are added dynamically
    ])
    
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

    if (this.connectPromise) {
      return this.connectPromise
    }

    this.connectPromise = this._connectOnce()

    try {
      return await this.connectPromise
    } finally {
      this.connectPromise = null
    }
  }

  async _connectOnce() {
    if (!this.client) {
      this.client = new Redis(this.redisUrl, {
        maxRetriesPerRequest: null,
        retryStrategy: (times) => {
          const delay = Math.min(1000 * (2 ** Math.min(times, 5)), this.maxReconnectDelayMs)
          return delay
        },
        retryUnfulfilledCommands: true,
        enableOfflineQueue: true,
        connectTimeout: 5000,
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
        this.retryAttempt = 0
        this.log('🟢 Redis connected')
      })

      this.client.on('error', (err) => {
        this.stats.errors++
        console.error('❌ Redis error:', err.message)
      })

      this.client.on('close', () => {
        this.isConnected = false
        this.log('🔴 Redis connection closed')
        this.scheduleReconnect()
      })

      this.client.on('reconnecting', () => {
        this.stats.connectionRetries++
        this.log('🔄 Redis reconnecting...')
      })

      this.client.on('ready', async () => {
        this.isConnected = true
        try {
          await this.ensureVersionKey()
        } catch (error) {
          console.error('❌ Redis version bootstrap failed:', error.message)
        }
      })
    }

    try {
      await this.waitForReady(5000)
      await this.ensureVersionKey()
      this.log(`🚀 Redis cache initialized (version: ${this.dataVersion})`)
      return true
    } catch (error) {
      this.stats.errors++
      console.error('❌ Redis connection failed:', error.message)
      this.isConnected = false
      this.scheduleReconnect()
      return false
    }
  }

  async waitForReady(timeoutMs = 5000) {
    if (this.isConnected) {
      return true
    }

    return await new Promise((resolve, reject) => {
      const onReady = () => {
        cleanup()
        resolve(true)
      }

      const onError = (error) => {
        cleanup()
        reject(error)
      }

      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('Redis connection timed out'))
      }, timeoutMs)

      const cleanup = () => {
        clearTimeout(timeout)
        this.client?.off('ready', onReady)
        this.client?.off('error', onError)
      }

      this.client.once('ready', onReady)
      this.client.once('error', onError)
    })
  }

  async ensureVersionKey() {
    if (!this.client || !this.isConnected) {
      return
    }

    const storedVersion = await this.client.get(`${this.prefix}version`)
    if (storedVersion) {
      this.dataVersion = parseInt(storedVersion, 10)
    } else {
      await this.client.set(`${this.prefix}version`, this.dataVersion.toString())
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) {
      return
    }

    const delayMs = Math.min(5000 * (2 ** this.retryAttempt), this.maxReconnectDelayMs)
    this.retryAttempt += 1

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      try {
        await this.connect()
      } catch (error) {
        console.error('❌ Redis reconnect attempt failed:', error.message)
      }
    }, delayMs)

    this.reconnectTimer.unref?.()
    console.warn(`⚠️ Redis unavailable, retrying connection in ${Math.round(delayMs / 1000)}s`)
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
   * Check if a key is a startup cache key (should be permanent)
   * @param {string} key - Cache key (without prefix)
   * @returns {boolean} True if startup cache key
   */
  isStartupCacheKey(key) {
    // Direct match
    if (this.startupCacheKeys.has(key)) return true
    
    // Check for dynamic startup keys (e.g., rankings:season:{id} for active season)
    if (key.startsWith('rankings:season:')) return true
    
    // Date-specific rankings and matches are also permanent startup cache
    if (key.startsWith('rankings:date:')) return true
    if (key.startsWith('matches:date:')) return true
    
    return false
  }

  /**
   * Store data in Redis cache
   * - Startup cache keys: stored permanently (no TTL)
   * - Other keys: stored with TTL (default 24 hours)
   * @param {string} key - Cache key (without prefix)
   * @param {any} data - Data to cache (will be JSON serialized)
   * @param {number} ttl - TTL in seconds (default: 24 hours, ignored for startup keys)
   */
  async set(key, data, ttl = this.defaultTTL) {
    if (!this.isConnected) {
      this.log(`⚠️ Redis not connected, skipping set: ${key}`)
      return false
    }

    try {
      const fullKey = `${this.prefix}${key}`
      const serialized = JSON.stringify(data)
      const isPermanent = this.isStartupCacheKey(key)
      
      if (isPermanent) {
        // Startup cache: no TTL (permanent until invalidation)
        await this.client.set(fullKey, serialized)
      } else {
        // Other cache: with TTL (lazy-load, auto-expire)
        await this.client.setex(fullKey, ttl, serialized)
      }
      
      this.stats.sets++
      
      const sizeKB = (Buffer.byteLength(serialized, 'utf8') / 1024).toFixed(1)
      this.log(`📦 Cache SET: ${key} (${sizeKB}KB, ${isPermanent ? 'permanent' : `TTL: ${ttl}s`})`)
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
      const isPermanent = this.isStartupCacheKey(key)
      this.log(`🎯 Cache HIT: ${key} (${isPermanent ? 'permanent' : 'with TTL'})`)
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
        this.log(`�️ Cache INVALIDATE: ${pattern}* (${totalDeleted} keys)`)
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
   * Clears: rankings, match lists, individual matches, play dates
   * @param {string} date - Match date in YYYY-MM-DD format
   */
  async invalidateOnMatchChange(date) {
    this.log(`🔄 Invalidating cache for match change (date: ${date || 'unknown'})`)
    
    await Promise.all([
      this.invalidateByPrefix('rankings:'),
      date ? this.delete(`matches:date:${date}`) : this.invalidateByPrefix('matches:date:'),
      this.invalidateByPrefix('matches:list:'),
      this.invalidateByPrefix('matches:season:'),
      this.invalidateByPrefix('match:'),
      this.delete('playdates'),
      this.delete('playdate:latest')
    ])

    // Bump version synchronously so the requesting client gets fresh data
    await this.incrementVersion()
  }

  /**
   * Invalidate cache when a player changes
   * Clears: rankings, players list, season player lists
   */
  async invalidateOnPlayerChange() {
    this.log('🔄 Invalidating cache for player change')
    
    await Promise.all([
      this.invalidateByPrefix('rankings:'),
      this.delete('players'),
      this.invalidateByPrefix('season:')  // Clears season:active AND season:*:players
    ])

    // Bump version synchronously so the requesting client gets fresh data
    await this.incrementVersion()
  }

  /**
   * Invalidate cache when a season changes
   * Clears: rankings, seasons lists, active season, season player lists
   */
  async invalidateOnSeasonChange() {
    this.log('🔄 Invalidating cache for season change')
    
    await Promise.all([
      this.invalidateByPrefix('rankings:'),
      this.delete('seasons'),
      this.delete('seasons:active'),
      this.invalidateByPrefix('season:')  // Clears season:active AND season:*:players
    ])

    // Bump version synchronously so the requesting client gets fresh data
    await this.incrementVersion()
  }

  /**
   * Increment data version for client cache sync.
   * Uses a short-lived Redis lock so all cluster workers converge on the
   * same version number — the first worker to win writes the canonical
   * value; all others read it back, ensuring every worker emits the
   * same version to their SSE clients.
   */
  async incrementVersion() {
    const newVersion = Date.now()
    if (this.isConnected) {
      try {
        const versionKey = `${this.prefix}version`
        const lockKey = `${this.prefix}version-lock`
        // NX = only set if key does not exist; EX 2 = auto-expire in 2 s
        const acquired = await this.client.set(lockKey, '1', 'EX', 2, 'NX')
        if (acquired === 'OK') {
          // This worker won the race — write the canonical version
          await this.client.set(versionKey, newVersion.toString())
          this.dataVersion = newVersion
        } else {
          // Another worker already wrote the version — read it back so all
          // workers emit the same value to their SSE clients
          const stored = await this.client.get(versionKey)
          this.dataVersion = stored ? parseInt(stored, 10) : newVersion
        }
      } catch (error) {
        this.dataVersion = newVersion
        console.error('❌ Failed to update cache version:', error.message)
      }
    } else {
      this.dataVersion = newVersion
    }
    // Emit event so SSE connections can push to clients immediately
    this.emit('versionChange', this.dataVersion)
  }

  /**
   * Get current data version for client sync
   */
  getDataVersion() {
    return this.dataVersion
  }

  // ==========================================
  // Cache Stampede Protection (Distributed Locks)
  // ==========================================

  /**
   * Acquire a distributed lock using Redis SET NX EX
   * Prevents cache stampede by ensuring only one process rebuilds cache
   * @param {string} key - Lock key (without prefix)
   * @param {number} ttlSeconds - Lock TTL in seconds (auto-release safety net)
   * @returns {boolean} True if lock acquired
   */
  async acquireLock(key, ttlSeconds = 10) {
    if (!this.isConnected) return true // Fallback: allow through if Redis is down

    try {
      const lockKey = `${this.prefix}lock:${key}`
      // SET key value EX ttl NX - only set if key doesn't exist
      const result = await this.client.set(lockKey, '1', 'EX', ttlSeconds, 'NX')
      const acquired = result === 'OK'
      if (acquired) {
        this.log(`🔒 Lock ACQUIRED: ${key} (TTL: ${ttlSeconds}s)`)
      }
      return acquired
    } catch (error) {
      this.stats.errors++
      console.error(`❌ Lock acquire error for ${key}:`, error.message)
      return true // Fallback: allow through on error
    }
  }

  /**
   * Release a distributed lock
   * @param {string} key - Lock key (without prefix)
   */
  async releaseLock(key) {
    if (!this.isConnected) return

    try {
      const lockKey = `${this.prefix}lock:${key}`
      await this.client.del(lockKey)
      this.log(`🔓 Lock RELEASED: ${key}`)
    } catch (error) {
      this.stats.errors++
      console.error(`❌ Lock release error for ${key}:`, error.message)
    }
  }

  /**
   * Get-or-set with stampede protection
   * If cache miss: acquires lock, calls fetcher, sets cache, releases lock.
   * If another process holds the lock: waits briefly and retries cache read.
   * @param {string} key - Cache key (without prefix)
   * @param {Function} fetcher - Async function that returns data to cache
   * @param {number} ttl - TTL in seconds (ignored for startup keys)
   * @param {object} options - { lockTTL, retries, retryDelay }
   * @returns {{ data: any, hit: boolean }} Cached or freshly-fetched data with cache hit indicator
   */
  async getOrSet(key, fetcher, ttl = this.defaultTTL, options = {}) {
    const { lockTTL = 15, retries = 3, retryDelay = 200 } = options

    // 1. Try cache first
    let data = await this.get(key)
    if (data !== null) return { data, hit: true }

    // 2. Cache miss — try to acquire lock
    const lockAcquired = await this.acquireLock(key, lockTTL)

    if (lockAcquired) {
      // We own the lock — fetch from DB and populate cache
      try {
        // Double-check cache (another process may have filled it while we waited)
        data = await this.get(key)
        if (data !== null) return { data, hit: true }

        data = await fetcher()
        await this.set(key, data, ttl)
        return { data, hit: false }
      } finally {
        await this.releaseLock(key)
      }
    }

    // 3. Lock NOT acquired — another process is rebuilding; wait & retry
    for (let i = 0; i < retries; i++) {
      await new Promise(resolve => setTimeout(resolve, retryDelay * (i + 1)))
      data = await this.get(key)
      if (data !== null) {
        this.log(`🔄 Lock wait HIT on retry ${i + 1}: ${key}`)
        return { data, hit: true }
      }
    }

    // 4. All retries exhausted — fall through to DB (no cache set to avoid stale data)
    this.log(`⚠️ Lock wait exhausted for ${key}, falling through to DB`)
    data = await fetcher()
    return { data, hit: false }
  }

  /**
   * Check if a cache key exists
   * @param {string} key - Cache key (without prefix)
   * @returns {boolean} True if key exists
   */
  async exists(key) {
    if (!this.isConnected) return false

    try {
      const fullKey = `${this.prefix}${key}`
      const result = await this.client.exists(fullKey)
      return result === 1
    } catch (error) {
      console.error(`❌ Redis EXISTS error for ${key}:`, error.message)
      return false
    }
  }

  /**
   * Preload startup cache data (permanent entries)
   * Called at server startup after clearing cache, and periodically to ensure data exists
   * Only loads data if not already cached (invalidation handles updates)
   * @param {object} db - Database instance
   * @param {boolean} force - Force reload even if data exists (used at startup)
   */
  async preloadCommonData(db, force = false) {
    if (!db || !this.isConnected) return

    try {
      let loadedCount = 0
      
      // 1. Lifetime rankings (permanent)
      const lifetimeKey = 'rankings:lifetime'
      if (force || !(await this.exists(lifetimeKey))) {
        const rankings = await db.getPlayerStatsWithFormsLifetime(5)
        await this.set(lifetimeKey, rankings)
        this.stats.preloads++
        loadedCount++
        this.log('📦 Cache PRELOAD: rankings:lifetime')
      }

      // 2. Active season rankings (permanent)
      const activeSeason = await db.getActiveSeason()
      if (activeSeason) {
        const seasonKey = `rankings:season:${activeSeason.id}`
        if (force || !(await this.exists(seasonKey))) {
          const seasonRankings = await db.getPlayerStatsWithFormsBySeason(activeSeason.id, 5)
          await this.set(seasonKey, seasonRankings)
          this.stats.preloads++
          loadedCount++
          this.log(`📦 Cache PRELOAD: ${seasonKey}`)
        }

        // Cache active season object (permanent)
        if (force || !(await this.exists('season:active'))) {
          await this.set('season:active', activeSeason)
          this.stats.preloads++
          loadedCount++
        }
      }

      // 3. Players list (permanent)
      if (force || !(await this.exists('players'))) {
        const players = await db.getPlayers()
        await this.set('players', players)
        this.stats.preloads++
        loadedCount++
        this.log('📦 Cache PRELOAD: players')
      }

      // 4. Seasons list (permanent)
      if (force || !(await this.exists('seasons'))) {
        const seasons = await db.getSeasons()
        await this.set('seasons', seasons)
        this.stats.preloads++
        loadedCount++
        this.log('📦 Cache PRELOAD: seasons')
      }

      // 5. Play dates (permanent)
      if (force || !(await this.exists('playdates'))) {
        const playDates = await db.getPlayDates()
        await this.set('playdates', playDates)
        this.stats.preloads++
        loadedCount++
        this.log('📦 Cache PRELOAD: playdates')
      }

      // 6. Latest play date (permanent)
      if (force || !(await this.exists('playdate:latest'))) {
        const latestDate = await db.getLatestPlayDate()
        await this.set('playdate:latest', latestDate)
        this.stats.preloads++
        loadedCount++
        this.log('📦 Cache PRELOAD: playdate:latest')
      }

      // 7. Active seasons list (permanent)
      if (force || !(await this.exists('seasons:active'))) {
        const activeSeasons = await db.getActiveSeasons()
        await this.set('seasons:active', activeSeasons)
        this.stats.preloads++
        loadedCount++
        this.log('📦 Cache PRELOAD: seasons:active')
      }

      // 8. Warm recent play date rankings & matches (last 5 dates with matches)
      // These are permanent startup cache (no TTL) — invalidated via PG NOTIFY
      try {
        const playDates = await db.getPlayDates()
        const recentDates = playDates.slice(0, 5).map(d => d.play_date?.split('T')[0] || d.play_date)
        
        await Promise.all(recentDates.map(async (date) => {
          if (!date) return
          
          // Warm date rankings (batch: 2 queries instead of N+1)
          const rankingsKey = `rankings:date:${date}`
          if (force || !(await this.exists(rankingsKey))) {
            const rankingsWithForm = await db.getPlayerStatsWithFormsByDate(date, 5)
            await this.set(rankingsKey, rankingsWithForm)
            this.stats.preloads++
            loadedCount++
            this.log(`📦 Cache PRELOAD: ${rankingsKey}`)
          }
          
          // Warm date matches
          const matchesKey = `matches:date:${date}`
          if (force || !(await this.exists(matchesKey))) {
            const matches = await db.getMatchesByPlayDate(date)
            await this.set(matchesKey, matches)
            this.stats.preloads++
            loadedCount++
            this.log(`📦 Cache PRELOAD: ${matchesKey}`)
          }
        }))
      } catch (warmError) {
        console.error('⚠️ Cache warming for recent dates failed:', warmError.message)
        // Non-critical — continue startup
      }

      if (loadedCount > 0) {
        this.log(`✅ Cache preload complete (${loadedCount} entries loaded)`)
      } else {
        this.log(`✅ Cache check complete (all startup data exists)`)
      }
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
      dataVersion: this.dataVersion,
      startupCacheKeys: Array.from(this.startupCacheKeys)
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
   * Clear all cache and preload startup data
   * Called at server startup to ensure fresh cache state
   * @param {object} db - Database instance
   */
  async clearAndPreload(db) {
    this.log('🚀 Server startup: clearing all cache and preloading...')
    
    // Clear all existing cache
    await this.clear()
    
    // Preload startup cache with force=true
    await this.preloadCommonData(db, true)
    
    this.log('✅ Server startup cache initialization complete')
  }

  /**
   * Disconnect from Redis
   */
  async disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

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
