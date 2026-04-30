import rateLimit from 'express-rate-limit'
import { RedisStore } from 'rate-limit-redis'
import IORedis from 'ioredis'
import os from 'os'
import config from '../config/env.js'
import { getRealClientIP, logError } from '../access-logger.js'

/**
 * Rate limiting module.
 *
 * Features:
 * - Redis-backed distributed rate limiting (cluster/PM2 safe)
 * - Dynamic scaling based on CPU/RAM pressure
 * - User-aware limits (admin > authenticated > anonymous)
 * - Graceful degradation if Redis is down (passOnStoreError)
 */

// ── Dedicated Redis client for rate limiting ────────────────────────────────
// Separate from cache client so failures are isolated.
// enableOfflineQueue: false — when Redis is down, commands fail immediately
// instead of accumulating in memory. passOnStoreError on each limiter
// handles graceful degradation (fail-open).
const rateLimitRedis = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  retryStrategy(times) {
    return Math.min(times * 200, 5000) // reconnect with backoff
  }
})
rateLimitRedis.on('error', () => {
  // Suppressed — passOnStoreError in each limiter handles degradation
})

const createRedisRateLimitStore = (suffix) => new RedisStore({
  sendCommand: async (...args) => {
    try {
      // If Redis is offline, ioredis throws immediately because offlineQueue is false.
      // rate-limit-redis calls 'SCRIPT LOAD' on startup. If this throws, the app crashes.
      if (rateLimitRedis.status !== 'ready' && args[0] === 'SCRIPT' && args[1] === 'LOAD') {
        // Return a dummy SHA to satisfy the library during startup
        return 'dummy_sha_to_prevent_startup_crash'
      }
      return await rateLimitRedis.call(...args)
    } catch (err) {
      if (err.message && err.message.includes('enableOfflineQueue')) {
        // For EVALSHA or other commands when offline, just throw an error that rate-limit-redis will catch and fail-open
        throw new Error('Redis offline')
      }
      throw err
    }
  },
  prefix: `rate-limit-redis-tennis:${suffix}:`,
})

// ── Dynamic resource sampling ───────────────────────────────────────────────

let resourceSnapshot = { cpuPct: 0, ramUsedPct: 0, updatedAt: 0 }

const sampleServerResources = () => {
  try {
    const cpuCores = os.cpus()?.length || 1
    const load1 = Array.isArray(os.loadavg?.()) ? os.loadavg()[0] : 0
    const cpuPct = cpuCores > 0 ? (load1 / cpuCores) * 100 : 0
    const totalMem = os.totalmem?.() || 0
    const freeMem = os.freemem?.() || 0
    const ramUsedPct = totalMem > 0 ? ((totalMem - freeMem) / totalMem) * 100 : 0
    resourceSnapshot = { cpuPct, ramUsedPct, updatedAt: Date.now() }
  } catch {
    // keep last good snapshot
  }
}

if (config.rateLimit.dynamic.enabled) {
  sampleServerResources()
  const interval = setInterval(sampleServerResources, config.rateLimit.dynamic.sampleMs)
  if (typeof interval.unref === 'function') interval.unref()
}

const getRateLimitDynamicMultiplier = () => {
  if (!config.rateLimit.dynamic.enabled) return 1
  const { cpuPct, ramUsedPct } = resourceSnapshot
  const d = config.rateLimit.dynamic
  let multiplier = 1
  if (cpuPct >= d.cpuCriticalPct || ramUsedPct >= d.ramCriticalPct) {
    multiplier = d.scaleCritical
  } else if (cpuPct >= d.cpuHighPct || ramUsedPct >= d.ramHighPct) {
    multiplier = d.scaleHigh
  }
  return Math.max(d.minScale, Math.min(1, multiplier))
}

// ── Limiter factory ─────────────────────────────────────────────────────────

const createProxyAwareRateLimiter = ({ storePrefix, ...options }) => {
  if (config.rateLimit.disabled) {
    return (_req, _res, next) => next()
  }

  const baseLimit = options.limit
  const dynamicLimit = (req, res) => {
    const resolvedBase = typeof baseLimit === 'function' ? baseLimit(req, res) : baseLimit
    const numericBase = Number(resolvedBase)
    const safeBase = Number.isFinite(numericBase) && numericBase > 0 ? numericBase : 1
    const multiplier = getRateLimitDynamicMultiplier()
    const computed = Math.floor(safeBase * multiplier)
    return computed > 0 ? computed : 1
  }

  const store = storePrefix ? createRedisRateLimitStore(storePrefix) : undefined

  return rateLimit({
    ...options,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    limit: dynamicLimit,
    store,
    passOnStoreError: true,
    keyGenerator: (req) => getRealClientIP(req),
    skip: (req) =>
      req.path === '/api/health' ||
      req.path === '/health' ||
      /\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf)$/.test(req.path),
    handler: (req, res, _next, opts) => {
      const clientIP = getRealClientIP(req)
      const userInfo = req.user ? `${req.user.username}(${req.user.role})` : 'anonymous'
      console.warn(`⚠️ Rate limit exceeded: ${clientIP} | ${userInfo} | ${req.method} ${req.path}`)
      logError(new Error(`Rate limit exceeded: ${req.method} ${req.path}`), req, req.user)
      res.status(opts.statusCode || 429).json(
        opts.message || { error: 'Too many requests from this IP, please try again later.' }
      )
    }
  })
}

// ── Pre-built limiters ──────────────────────────────────────────────────────

const wm = config.rateLimit.windowMs

export const generalLimiter = createProxyAwareRateLimiter({
  windowMs: wm, limit: config.rateLimit.maxRequests, storePrefix: 'general',
  message: { error: 'Too many requests from this IP, please try again later.' }
})

export const apiLimiter = createProxyAwareRateLimiter({
  windowMs: wm, limit: config.rateLimit.apiMax, storePrefix: 'api',
  message: { error: 'Too many API requests from this IP, please try again later.' }
})

export const authLimiter = createProxyAwareRateLimiter({
  windowMs: wm, limit: 5, storePrefix: 'auth',
  message: { error: 'Too many login attempts from this IP, please try again later.' }
})

export const deleteLimiter = createProxyAwareRateLimiter({
  windowMs: wm, limit: 50, storePrefix: 'delete',
  message: { error: 'Too many delete requests from this IP, please try again later.' }
})

export const createLimiter = createProxyAwareRateLimiter({
  windowMs: wm, limit: 200, storePrefix: 'create',
  message: { error: 'Too many create requests from this IP, please try again later.' }
})

export const exportLimiter = createProxyAwareRateLimiter({
  windowMs: wm, limit: 150, storePrefix: 'export',
  message: { error: 'Too many export requests from this IP, please try again later.' }
})

export const criticalLimiter = createProxyAwareRateLimiter({
  windowMs: 60 * 60 * 1000, limit: 10, storePrefix: 'critical',
  message: { error: 'Critical operation limit exceeded. Please wait 1 hour before trying again.' }
})

export const restoreLimiter = createProxyAwareRateLimiter({
  windowMs: 60 * 60 * 1000, limit: 50, storePrefix: 'restore',
  message: { error: 'Too many restore requests from this IP, please try again later.' }
})

// User-aware rate limiter (different limits for authenticated users vs anonymous)
export const smartApiLimiter = createProxyAwareRateLimiter({
  windowMs: wm,
  storePrefix: 'smart-api',
  limit: (req) => {
    if (req.user && req.user.role === 'admin') return config.rateLimit.authenticatedMax * 2
    if (req.user) return config.rateLimit.authenticatedMax
    return config.rateLimit.anonymousMax
  },
  message: (req) => ({
    error: `Too many requests from this IP. ${req.user ? 'Authenticated users receive higher limits' : 'Anonymous users are limited'}. Please try again later.`
  })
})

/**
 * Conditional rate limiter — bypasses in development mode.
 */
export const conditionalRateLimit = (limiter) => {
  return (req, res, next) => {
    if (config.isDevelopment) return next()
    return limiter(req, res, next)
  }
}

/**
 * Apply global rate limiting to an Express app.
 */
export function applyGlobalRateLimiting(app) {
  if (!config.isDevelopment) {
    app.use(generalLimiter)
    app.use('/api', smartApiLimiter)
  } else {
    console.log('🚧 Development mode: Global rate limiting disabled')
  }
}

/**
 * Log rate limit configuration.
 */
export function logRateLimitConfig() {
  console.log('🔧 Rate Limiting Configuration:')
  console.log(`   Window: ${wm}ms (${wm / 60000} minutes)`)
  console.log(`   General Limit: ${config.rateLimit.maxRequests} requests`)
  console.log(`   API Limit: ${config.rateLimit.apiMax} requests`)
  console.log(`   Disabled: ${config.rateLimit.disabled}`)
  console.log(`   Dynamic Enabled: ${config.rateLimit.dynamic.enabled}`)
  if (config.rateLimit.dynamic.enabled) {
    const d = config.rateLimit.dynamic
    console.log(`   Dynamic Sample: ${d.sampleMs}ms`)
    console.log(`   CPU High/Critical: ${d.cpuHighPct}% / ${d.cpuCriticalPct}%`)
    console.log(`   RAM High/Critical: ${d.ramHighPct}% / ${d.ramCriticalPct}%`)
    console.log(`   Scale High/Critical: ${d.scaleHigh} / ${d.scaleCritical} (min ${d.minScale})`)
  }
}

/**
 * Disconnect rate-limit Redis client (for graceful shutdown).
 */
export async function disconnectRateLimitRedis() {
  try { await rateLimitRedis.quit() } catch { /* ignore */ }
}
