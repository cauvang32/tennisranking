import { describe, expect, it, vi } from 'vitest'
import RedisCache from '../../lib/redis-cache.js'

describe('Redis cache mutation correctness', () => {
  it('uses a distinct atomic version for every mutation', async () => {
    const cache = new RedisCache()
    cache.isConnected = true
    let version = 100
    cache.client = { incr: vi.fn(async () => ++version) }

    await cache.incrementVersion()
    expect(cache.getDataVersion()).toBe(101)
    await cache.incrementVersion()
    expect(cache.getDataVersion()).toBe(102)
    expect(cache.client.incr).toHaveBeenCalledTimes(2)
  })

  it('invalidates lifetime, season, date, list, and detail match data', async () => {
    const cache = new RedisCache()
    cache.delete = vi.fn(async () => true)
    cache.invalidateByPrefix = vi.fn(async () => 1)
    cache.incrementVersion = vi.fn(async () => {})

    await cache.invalidateOnMatchChange('2026-07-26', 4, 99)

    expect(cache.delete).toHaveBeenCalledWith('rankings:lifetime')
    expect(cache.delete).toHaveBeenCalledWith('rankings:season:4')
    expect(cache.delete).toHaveBeenCalledWith('rankings:date:2026-07-26')
    expect(cache.delete).toHaveBeenCalledWith('matches:date:2026-07-26')
    expect(cache.delete).toHaveBeenCalledWith('match:99')
    expect(cache.invalidateByPrefix).toHaveBeenCalledWith('matches:season:4')
    expect(cache.invalidateByPrefix).toHaveBeenCalledWith('matches:list:')
    expect(cache.incrementVersion).toHaveBeenCalledOnce()
  })

  it('invalidates once while notifying SSE clients on every worker', async () => {
    const values = new Map()
    let version = 100
    const client = {
      set: vi.fn(async (key, value, ...options) => {
        if (options.includes('NX') && values.has(key)) return null
        values.set(key, value)
        return 'OK'
      }),
      get: vi.fn(async key => values.get(key) ?? null),
      incr: vi.fn(async key => {
        version += 1
        values.set(key, String(version))
        return version
      }),
      del: vi.fn(async key => values.delete(key))
    }
    const leader = new RedisCache()
    const follower = new RedisCache()
    for (const cache of [leader, follower]) {
      cache.isConnected = true
      cache.client = client
      cache.dataVersion = 100
    }
    leader.invalidateOnMatchChange = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
      await leader.incrementVersion()
    })
    follower.invalidateOnMatchChange = vi.fn(async () => {
      await follower.incrementVersion()
    })
    const leaderVersionChange = vi.fn()
    const followerVersionChange = vi.fn()
    leader.on('versionChange', leaderVersionChange)
    follower.on('versionChange', followerVersionChange)
    const payload = {
      eventId: '100:matches:UPDATE:99',
      table: 'matches',
      action: 'UPDATE',
      id: 99,
      date: '2026-07-26',
      seasonId: 4
    }

    await Promise.all([
      leader.handleDbChange(payload),
      follower.handleDbChange(payload)
    ])

    expect(leader.invalidateOnMatchChange).toHaveBeenCalledOnce()
    expect(follower.invalidateOnMatchChange).not.toHaveBeenCalled()
    expect(leaderVersionChange).toHaveBeenCalledWith(101)
    expect(followerVersionChange).toHaveBeenCalledWith(101)
    expect(follower.getDataVersion()).toBe(101)
  })
})
