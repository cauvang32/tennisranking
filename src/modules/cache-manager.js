/**
 * Client-side cache manager.
 *
 * Smart cache with type-specific TTLs. Supports selective invalidation
 * (rankings, matches, players, seasons, playDates) and full clear.
 */

const CACHE_TTL = {
  rankings: 2 * 60 * 1000,      // 2 min - changes when matches recorded
  matches: 1 * 60 * 1000,       // 1 min - changes frequently
  players: 10 * 60 * 1000,      // 10 min - rarely changes
  seasons: 10 * 60 * 1000,      // 10 min - rarely changes
  playDates: 5 * 60 * 1000,     // 5 min - changes with new matches
  versionCheck: 15 * 1000        // 15s - check server version
}

/**
 * Create a new cache instance.
 * @returns {object} { cache, isCacheValid, setCache, getCache, invalidateCache, clearCache, CACHE_TTL }
 */
export function createCacheManager() {
  const cache = {
    rankings: new Map(),
    matches: new Map(),
    players: null,
    seasons: null,
    playDates: null,
    lastFetch: new Map(),
    serverVersion: null
  }

  function isCacheValid(cacheKey, type = 'rankings') {
    const lastFetch = cache.lastFetch.get(cacheKey)
    if (!lastFetch) return false

    const ttl = CACHE_TTL[type] || CACHE_TTL.rankings
    return (Date.now() - lastFetch) < ttl
  }

  function setCache(type, key, data) {
    const cacheKey = key ? `${type}:${key}` : type

    if (type === 'rankings' || type === 'matches') {
      cache[type].set(key, data)
    } else {
      cache[type] = data
    }

    cache.lastFetch.set(cacheKey, Date.now())
    console.log(`💾 Cache SET: ${cacheKey}`)
  }

  function getCache(type, key = null) {
    const cacheKey = key ? `${type}:${key}` : type

    if (!isCacheValid(cacheKey, type)) {
      console.log(`❌ Cache MISS: ${cacheKey}`)
      return null
    }

    let data = null
    if (type === 'rankings' || type === 'matches') {
      data = cache[type].get(key)
    } else {
      data = cache[type]
    }

    if (data) {
      console.log(`✅ Cache HIT: ${cacheKey}`)
    }
    return data
  }

  function invalidateCache(types = []) {
    if (!types || types.length === 0) {
      // Full clear
      cache.rankings.clear()
      cache.matches.clear()
      cache.lastFetch.clear()
      cache.players = null
      cache.seasons = null
      cache.playDates = null
      console.log('🗑️ Full cache cleared')
      return
    }

    types.forEach(type => {
      switch (type) {
        case 'rankings':
          cache.rankings.clear()
          for (const key of cache.lastFetch.keys()) {
            if (key.startsWith('rankings:')) {
              cache.lastFetch.delete(key)
            }
          }
          console.log('🗑️ Rankings cache cleared')
          break

        case 'matches':
          cache.matches.clear()
          cache.playDates = null
          for (const key of cache.lastFetch.keys()) {
            if (key.startsWith('matches:') || key === 'playDates') {
              cache.lastFetch.delete(key)
            }
          }
          console.log('🗑️ Matches cache cleared')
          break

        case 'players':
          cache.players = null
          cache.lastFetch.delete('players')
          console.log('🗑️ Players cache cleared')
          break

        case 'seasons':
          cache.seasons = null
          cache.lastFetch.delete('seasons')
          console.log('🗑️ Seasons cache cleared')
          break

        case 'playDates':
          cache.playDates = null
          cache.lastFetch.delete('playDates')
          console.log('🗑️ PlayDates cache cleared')
          break
      }
    })
  }

  function clearCache() {
    invalidateCache()
  }

  return {
    cache,
    isCacheValid,
    setCache,
    getCache,
    invalidateCache,
    clearCache,
    CACHE_TTL
  }
}
