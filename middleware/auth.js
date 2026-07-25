import { readToken, verifyToken } from '../lib/jwt-encryption.js'

// S5: LRU cache for tokenVersion lookups.
// The JWT payload already carries tokenVersion — the DB check is only needed
// for server-side revocation (user deleted, tokens invalidated). Caching the
// "not-revoked" result for 30s eliminates per-request DB hits while keeping
// revocation latency bounded. Map iteration order = insertion order for LRU.
const TOKEN_VERSION_CACHE_MAX = 200
const TOKEN_VERSION_CACHE_TTL = 30_000 // 30 seconds — revocation is near-real-time
const tokenVersionCache = new Map()

function getCachedTokenVersion(user) {
  if (!user?.id) return null
  const key = `tv:${user.id}`
  const entry = tokenVersionCache.get(key)
  if (entry && Date.now() - entry.ts < TOKEN_VERSION_CACHE_TTL) {
    return entry.value // cached value (null = user deleted, number = version)
  }
  // Evict LRU entry when cache is full
  if (tokenVersionCache.size >= TOKEN_VERSION_CACHE_MAX) {
    const oldest = tokenVersionCache.keys().next().value
    tokenVersionCache.delete(oldest)
  }
  return undefined // not cached — will be fetched from DB below
}

function setCachedTokenVersion(user, value) {
  if (!user?.id) return
  tokenVersionCache.set(`tv:${user.id}`, { value, ts: Date.now() })
}

function invalidateTokenVersionCache(userId) {
  if (userId) tokenVersionCache.delete(`tv:${userId}`)
}

export { invalidateTokenVersionCache }

export const buildAuthMiddleware = ({
  security,
  db
}) => {
  const { clearCookieAllPaths, deriveCSRFSecretFromUser } = security

  const authenticateToken = async (req, res, next) => {
    let token = req.cookies.authToken || (req.headers['authorization'] && req.headers['authorization'].split(' ')[1])

    if (!token) {
      return res.status(401).json({ error: 'Access token required' })
    }

    if (req.cookies.authToken && token === req.cookies.authToken) {
      const raw = readToken(token)
      if (raw) token = raw
    }

    try {
      const user = verifyToken(token)

      // verifyToken returns null for invalid/expired tokens — guard before .type access
      if (!user) {
        return res.status(401).json({ error: 'Invalid or expired token' })
      }

      // Reject refresh tokens used as access tokens
      if (user.type !== 'access') {
        return res.status(401).json({ error: 'Invalid token type' })
      }

      // Server-side token revocation check for database users.
      // S5: Use LRU cache to avoid per-request DB hits. Cache "not-revoked"
      // for 30s — revocation latency is bounded, DB load is dramatically reduced.
      // System users (env-based admin/editor) don't have a DB id, skip this check.
      if (user.id && db && typeof db.getTokenVersion === 'function') {
        let currentVersion = getCachedTokenVersion(user)
        if (currentVersion === undefined) {
          currentVersion = await db.getTokenVersion(user.id)
          setCachedTokenVersion(user, currentVersion)
        }
        // null = user deleted from DB
        if (currentVersion === null) {
          clearCookieAllPaths(res, 'authToken')
          clearCookieAllPaths(res, 'refreshToken')
          return res.status(401).json({ error: 'User no longer exists' })
        }
        if (typeof user.tokenVersion === 'number' && user.tokenVersion !== currentVersion) {
          clearCookieAllPaths(res, 'authToken')
          clearCookieAllPaths(res, 'refreshToken')
          return res.status(401).json({ error: 'Token has been revoked' })
        }
      }

      req.user = user
      req.isAuthenticated = true
      next()
    } catch (err) {
      if (req.cookies.authToken) {
        clearCookieAllPaths(res, 'authToken')
      }
      return res.status(403).json({ error: 'Invalid or expired token' })
    }
  }

  const checkAuth = async (req, res, next) => {
    let token = req.cookies.authToken || (req.headers['authorization'] && req.headers['authorization'].split(' ')[1])

    if (token) {
      if (req.cookies.authToken && token === req.cookies.authToken) {
        const raw = readToken(token)
        if (raw) token = raw
      }

      try {
        const user = verifyToken(token)

        // Reject refresh tokens used as access tokens (same as authenticateToken)
        if (user.type && user.type !== 'access') {
          req.isAuthenticated = false
          req.csrfSecret = deriveCSRFSecretFromUser(req.user || { id: 'anonymous' })
          return next()
        }

        // Server-side token revocation check (same as authenticateToken).
        // S5: Use LRU cache to avoid per-request DB hits.
        if (user.id && db && typeof db.getTokenVersion === 'function') {
          let currentVersion = getCachedTokenVersion(user)
          if (currentVersion === undefined) {
            currentVersion = await db.getTokenVersion(user.id)
            setCachedTokenVersion(user, currentVersion)
          }
          // null = user deleted from DB
          if (currentVersion === null || (typeof user.tokenVersion === 'number' && user.tokenVersion !== currentVersion)) {
            if (!res.headersSent) {
              clearCookieAllPaths(res, 'authToken')
              clearCookieAllPaths(res, 'refreshToken')
            }
            req.isAuthenticated = false
            req.csrfSecret = deriveCSRFSecretFromUser(req.user || { id: 'anonymous' })
            return next()
          }
        }

        req.user = user
        req.isAuthenticated = true
      } catch {
        if (req.cookies.authToken && !res.headersSent) {
          clearCookieAllPaths(res, 'authToken')
          clearCookieAllPaths(res, 'refreshToken')
        }
      }
    }

    req.isAuthenticated = req.isAuthenticated || false

    req.csrfSecret = deriveCSRFSecretFromUser(req.user || { id: 'anonymous' })
    next()
  }

  const requireRole = (allowedRoles) => {
    return (req, res, next) => {
      if (!req.isAuthenticated || !req.user) {
        return res.status(401).json({ error: 'Authentication required' })
      }

      const userRole = req.user.role
      const rolesArray = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles]

      if (!rolesArray.includes(userRole)) {
        return res.status(403).json({ error: 'Insufficient permissions' })
      }

      next()
    }
  }

  const requireAdmin = requireRole('admin')
  const requireEditor = requireRole(['admin', 'editor'])

  return {
    authenticateToken,
    checkAuth,
    requireRole,
    requireAdmin,
    requireEditor
  }
}
