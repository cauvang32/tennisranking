import crypto from 'crypto'
import csrf from 'csrf'
import config from '../config/env.js'
import { readToken, verifyToken } from '../lib/jwt-encryption.js'

/**
 * CSRF protection middleware.
 *
 * Strategy: The CSRF secret is derived from the authenticated user's ID
 * (or 'anonymous' for unauthenticated requests) using HMAC-SHA256.
 * No csrfSessionId cookie is needed. The frontend reads the derived
 * CSRF token from API responses (/api/csrf-token, /api/auth/login, /api/auth/status).
 */

const tokens = new csrf()

export { tokens }

/**
 * Derive a CSRF secret from a user object.
 * Same user ID always produces the same secret (deterministic).
 * @param {object} user - User object with id property, or null/undefined
 * @returns {string} Base64-encoded HMAC secret
 */
export function deriveCSRFSecretFromUser(user) {
  const userId = user?.id ?? 'anonymous'
  return crypto.createHmac('sha256', config.csrfSecret)
    .update(userId.toString())
    .digest('base64')
}

// ── Route helpers ───────────────────────────────────────────────────────────

const SUBPATH = config.subpath
const normalizedSubpath = SUBPATH !== '/' ? SUBPATH.replace(/\/+$/, '') : ''

const matchesApiRoute = (req, route) => {
  if (!route) return false
  const { path, originalUrl } = req
  const normalizedRoute = route.startsWith('/') ? route : `/${route}`
  if (path === route) return true
  const normalized = originalUrl?.split('?')[0]
  if (normalized === route || normalized === normalizedRoute) return true
  if (normalizedSubpath && (normalized === `${normalizedSubpath}${normalizedRoute}` || normalized === `${normalizedSubpath}${normalizedRoute}/`)) return true
  return false
}

// ── Global CSRF protection middleware ───────────────────────────────────────

export const globalCSRFProtection = (req, res, next) => {
  // Skip CSRF for GET requests (read-only operations)
  if (req.method === 'GET') return next()

  // Skip CSRF for login endpoint (needs to issue CSRF token)
  if (matchesApiRoute(req, '/api/auth/login')) return next()

  // Skip CSRF for public CSRF token endpoint
  if (matchesApiRoute(req, '/api/csrf-token')) return next()

  // Skip CSRF for CSP violation reports (browsers don't send CSRF tokens)
  if (matchesApiRoute(req, '/api/csp-report')) return next()

  // Skip CSRF for non-authenticated users on logout
  if (matchesApiRoute(req, '/api/auth/logout') && !req.cookies.authToken) return next()

  // Skip CSRF for unauthenticated device registration
  if (matchesApiRoute(req, '/api/devices/register') && !req.cookies.authToken) return next()

  // Extract the authenticated user from the auth token for CSRF verification.
  // `req.user` is not set yet at this point (route-level authenticateToken runs
  // after this global middleware), so we replicate the minimal token extraction
  // logic from `checkAuth` to derive the correct CSRF secret.
  if (!req.user) {
    let token = req.cookies.authToken
      || (req.headers['authorization'] && req.headers['authorization'].split(' ')[1])

    if (token) {
      if (req.cookies.authToken && token === req.cookies.authToken) {
        const raw = readToken(token)
        if (raw) token = raw
      }
      try {
        const user = verifyToken(token)
        // verifyToken returns null for invalid/expired tokens — guard before .type access
        if (user && user.type === 'access') {
          req.user = user
        }
      } catch { /* invalid token — authenticateToken will reject later */ }
    }
  }

  // Apply CSRF validation for all other state-changing operations
  const csrfToken = req.get('X-CSRF-Token') || req.body?._csrf

  const secret = deriveCSRFSecretFromUser(req.user || { id: 'anonymous' })

  if (!csrfToken || !tokens.verify(secret, csrfToken)) {
    return res.status(403).json({
      error: 'Invalid CSRF token',
      csrfRequired: true
    })
  }

  next()
}
