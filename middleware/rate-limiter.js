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
 * - Graceful degradation if Redis is down (fail-closed: requests are blocked)
 */

// ── Dedicated Redis client for rate limiting ────────────────────────────────
// Separate from cache client so failures are isolated.
// enableOfflineQueue: false — when Redis is down, commands fail immediately
// instead of accumulating in memory. passOnStoreError: false on each limiter
// ensures rate limiting stays enforced even when Redis is down (fail-closed).
//
// IMPORTANT: The client is created lazily (lazyRateLimitClient) to avoid a
// startup race when Redis runs inside Docker with a host port mapping
// (e.g. 127.0.0.1:6380). Docker's port forwarding takes 10-30s to become
// ready; creating the client at module load time would cause IORedis to
// throw "Stream isn't writeable" when RedisStore calls SCRIPT LOAD during
// construction. The client is created on first use by initRateLimitRedis().
let rateLimitRedis = null
const createRateLimitClient = () => {
  if (rateLimitRedis) return rateLimitRedis
  rateLimitRedis = new IORedis(config.redisUrl, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    connectTimeout: 5000,
    retryStrategy(times) {
      const delay = Math.min(1000 * (2 ** Math.min(times, 5)), 60000)
      return delay
    }
  })
  rateLimitRedis.on('error', () => {
    // Suppressed — passOnStoreError: false ensures requests are blocked when Redis is down
  })
  return rateLimitRedis
}

// Track how long Redis has been down for rate limiting (for logging)
let redisDownSince = null
const REDIS_DOWN_WARN_THRESHOLD = 30 // seconds
let isDisconnecting = false

const createRedisRateLimitStore = (suffix) => new RedisStore({
  sendCommand: async (...args) => {
    // Ensure the Redis client exists (created lazily to avoid startup race).
    const client = createRateLimitClient()

    // rate-limit-redis v4.x sendCommand receives raw command args:
    //   args[0] = "SCRIPT", args[1] = "LOAD", args[2] = <lua-script>
    //   args[0] = "EVALSHA",  args[1] = <sha>, args[2] = <key>, ...
    //   args[0] = "EVAL",    args[1] = <lua>,  args[2] = <key>, ...

    // ── SCRIPT LOAD (startup) ──────────────────────────────────────────────
    if (args[0] === 'SCRIPT' && args[1] === 'LOAD') {
      if (client.status !== 'ready') {
        // Wait up to 3 seconds for Redis to become ready (startup race window).
        const startedDown = Date.now()
        let becameReady = false

        while (Date.now() - startedDown < 3000) {
          if (client.status === 'ready' || client.status === 'connecting') {
            await new Promise(resolve => setTimeout(resolve, 100))
            if (client.status === 'ready') {
              becameReady = true
              break
            }
          } else {
            // status is 'end' / 'fault' / 'disconnected' — Redis is truly down
            break
          }
        }

        if (!becameReady) {
          if (!redisDownSince && !isDisconnecting) {
            redisDownSince = Date.now()
            console.warn(`⚠️ Redis unavailable for rate limiting — requests will NOT be rate-limited until Redis is back`)
          }
          return 'dummy_sha_to_prevent_startup_crash'
        }
      }
      // Redis is back online — reset the counter
      if (redisDownSince) {
        console.log(`✅ Rate limiter: Redis recovered (${Math.round((Date.now() - redisDownSince) / 1000)}s downtime)`)
        redisDownSince = null
      }
    }

    try {
      const result = await client.call(...args)

      // Handle successful results from EVALSHA/EVAL Lua scripts.
      // rate-limit-redis v4.x expects [totalHits, timeToExpire].
      // When Redis is under memory pressure, the Lua script may return
      // [0, 0] (key was evicted between PTTL and INCR).  express-rate-limit
      // v7.x validates totalHits > 0, so we must return [1, 0] (expired key)
      // instead of [0, 0].
      if (Array.isArray(result) && result.length === 2) {
        const hits = Number(result[0])
        if (hits < 1) {
          return [1, 0]
        }
      }
      return result
    } catch (err) {
      // rate-limit-redis v4.x expects sendCommand to return arrays for all
      // EVALSHA/EVAL results (parseScriptResponse checks Array.isArray(result)).
      //
      // When Redis is down, SCRIPT LOAD returns a dummy SHA string.  The
      // library then calls EVALSHA with that dummy SHA, which fails with
      // "NOSCRIPT".  The retryableIncrement catch block reloads the script
      // and retries — but if Redis is still down, sendCommand's catch block
      // returns [1, 0] (below).  parseScriptResponse checks Array.isArray &&
      // results.length === 2.  [1, 0] passes both checks — effectively
      // fail-open without crashing.

      // Configuration errors (WRONGPASS, NOAUTH) — fail-open: return [1, 0]
      // (1 hit, 0ms TTL = expired immediately).  A config error means nobody
      // can rate-limit correctly anyway.  Must be >= 1 because
      // express-rate-limit v7.x validates totalHits > 0.
      const isConfigError = err.message?.includes('WRONGPASS') ||
        err.message?.includes('NOAUTH') ||
        err.message?.includes('invalid password') ||
        err.message?.includes('authentication')

      if (isConfigError) {
        console.error(`⚠️ Rate limiter: Redis configuration error — ${err.message}.`)
        if (!redisDownSince) redisDownSince = Date.now()
        return [1, 0]
      }

      // Transient errors (connection refused, timeout, NOSCRIPT, closed, etc.)
      // — fail-open: return [1, 0] so requests pass through without rate
      // limiting.  Must be >= 1 because express-rate-limit v7.x validates
      // totalHits > 0.  This prevents the "Expected result to be array of
      // values" / "Expected 2 replies" / "ERR_ERL_INVALID_HITS" crashes from
      // taking down PM2 workers.
      if (err.message?.includes('ECONNREFUSED') ||
          err.message?.includes('timeout') ||
          err.message?.includes('Connection refused') ||
          err.message?.includes('connect ETIMEDOUT') ||
          err.message?.includes('getaddrinfo') ||
          err.message?.includes('Connection is closed.') ||
          err.message?.includes('Connection has errored') ||
          err.message?.includes('Reconnecting') ||
          err.message?.includes('NOSCRIPT') ||
          err.message?.includes("Stream isn't writeable")) {
        if (!redisDownSince) {
          redisDownSince = Date.now()
          console.warn(`⚠️ Rate limiter: Redis temporarily unavailable — requests will NOT be rate-limited until Redis recovers`)
        }
        return [1, 0]
      }

      // Unknown error — fail-open as safety net (better than crashing workers)
      if (redisDownSince && (Date.now() - redisDownSince) > REDIS_DOWN_WARN_THRESHOLD * 1000) {
        console.warn(`⚠️ Rate limiter: Redis has been down for ${Math.round((Date.now() - redisDownSince) / 1000)}s — requests will NOT be rate-limited (fail-open)`)
      }
      return [1, 0]
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

const createProxyAwareRateLimiter = ({ storePrefix, essential = false, ...options }) => {
  if (config.rateLimit.disabled && !essential) {
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
    passOnStoreError: false,
    keyGenerator: (req) => getRealClientIP(req),
    skip: (req) =>
      req.path === '/api/health' ||
      req.path === '/health' ||
      req.path === '/api/csp-report' ||
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
  windowMs: wm, limit: 5, storePrefix: 'auth', essential: true,
  message: { error: 'Too many login attempts from this IP, please try again later.' }
})

// Dedicated login brute-force limiter: 10 requests per 5 minutes, per IP.
// Compensates for the CSRF bypass on the login endpoint.
export const loginLimiter = createProxyAwareRateLimiter({
  windowMs: 5 * 60 * 1000, limit: 10, storePrefix: 'login', essential: true,
  message: { error: 'Too many login attempts. Please wait before trying again.' }
})

// Refresh-token rotation limiter: 10/hour, always enforced (essential).
// Prevents logged-in attackers from spamming token-version reads/writes
// and flooding Redis with rotation events.
export const refreshLimiter = createProxyAwareRateLimiter({
  windowMs: 60 * 60 * 1000, limit: 10, storePrefix: 'refresh', essential: true,
  message: { error: 'Too many token refresh attempts. Please try again later.' }
})

// Init endpoint limiter: 30/min per IP. /api/init triggers up to 8 cache
// lookups (now parallelized) and several DB queries on cache miss — generous
// for normal page reloads, but blocks scrapers and bots.
export const initLimiter = createProxyAwareRateLimiter({
  windowMs: 60 * 1000, limit: 30, storePrefix: 'init',
  message: { error: 'Too many init requests. Please slow down.' }
})

// Device registration limiter: 60/hour per IP. FCM token rotations are bursty
// (reinstall, token refresh, multi-account on one device) but bounded.
// essential: true — survives DISABLE_RATE_LIMITING so an attacker can't spam
// devices table inserts when an operator toggles the global disable flag.
export const deviceRegisterLimiter = createProxyAwareRateLimiter({
  windowMs: 60 * 60 * 1000, limit: 60, storePrefix: 'device-register', essential: true,
  message: { error: 'Too many device registration attempts. Please try again later.' }
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

// Strict restore limiter: 5 requests per 15-minute window, per IP.
// Dedicated to restore endpoints so they cannot exhaust the general restore budget.
export const strictRestoreLimiter = createProxyAwareRateLimiter({
  windowMs: 15 * 60 * 1000, limit: 5, storePrefix: 'strict-restore',
  message: { error: 'Too many restore requests. Please wait before trying again.', retryAfter: 900 },
  handler: (req, res, _next, opts) => {
    const clientIP = getRealClientIP(req)
    const userInfo = req.user ? `${req.user.username}(${req.user.role})` : 'anonymous'
    console.warn(`⚠️ Strict restore rate limit exceeded: ${clientIP} | ${userInfo} | ${req.method} ${req.path}`)
    logError(new Error(`Strict restore rate limit exceeded: ${req.method} ${req.path}`), req, req.user)
    const retryAfter = typeof opts.message?.retryAfter === 'number' ? opts.message.retryAfter : 900
    res.set('Retry-After', String(retryAfter))
    res.status(opts.statusCode || 429).json(
      opts.message || { error: 'Too many restore requests. Please wait before trying again.', retryAfter }
    )
  }
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
 * Conditional rate limiter — bypasses only when RATE_LIMIT_BYPASS_IN_DEV=true.
 * Default behaviour: enforce limits in every environment.
 * Set RATE_LIMIT_BYPASS_IN_DEV=true to opt into bypass in non-production.
 */
export const conditionalRateLimit = (limiter) => {
  return (req, res, next) => {
    if (config.rateLimit.bypassInDev && !config.isProduction) return next()
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
 * Start the rate-limit Redis client.
 * Call this from server.js after the cache client connects so both
 * Redis clients start at roughly the same time, avoiding the startup race.
 *
 * For lazy-created clients (host PM2 with Docker Redis), this triggers
 * the connection. For already-connected clients (Docker FCM worker),
 * this is a no-op.
 */
export async function initRateLimitRedis() {
  // Create the client lazily (triggers connection). If the client was
  // already created by the first HTTP request, it's already connecting.
  const client = createRateLimitClient()
  const TIMEOUT_MS = 15000

  try {
    // Wait for the IORedis client to become ready (it connects in background).
    // Use a timeout so server startup is not blocked forever if Redis is down.
    await Promise.race([
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Redis probe timed out after ' + TIMEOUT_MS + 'ms')), TIMEOUT_MS)
      ),
      new Promise((resolve, reject) => {
        const onReady = () => resolve()
        const onError = () => reject(new Error('Redis connection failed'))
        // Already ready?
        if (client.status === 'ready') return resolve()
        // Connecting? Wait for it.
        if (client.status === 'connecting') {
          client.once('ready', onReady).once('error', onError)
        } else {
          // Not yet started — trigger connection, then wait.
          client.connect().then(() => {
            client.once('ready', onReady).once('error', onError)
          }).catch(onError)
        }
      })
    ])

    // Probe PING to verify the store will work on first request.
    await client.call('PING')
    console.log('✅ Rate limiter Redis client initialized successfully')
  } catch (error) {
    console.warn('⚠️  Rate limiter Redis not ready at startup:', error.message,
      '— rate limiting will engage on first request (may add ~3s delay)')
    // Don't throw — let the server start. The 3-second blocking loop on
    // first request handles recovery gracefully.
  }
  return client
}

/**
 * Disconnect rate-limit Redis client (for graceful shutdown).
 */
export async function disconnectRateLimitRedis() {
  isDisconnecting = true
  const client = createRateLimitClient()
  try {
    client.removeAllListeners('close')
    client.removeAllListeners('end')
    client.removeAllListeners('reconnecting')
    client.removeAllListeners('error')
    await client.quit()
  } catch { /* ignore */ }
}
