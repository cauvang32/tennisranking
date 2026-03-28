import crypto from 'crypto'
import csrf from 'csrf'
import config from '../config/env.js'
import { withCookieDefaults } from '../config/cookie.js'

/**
 * CSRF protection middleware.
 *
 * Strategy:
 * 1. A random csrfSessionId is stored in an httpOnly cookie (not the secret itself).
 * 2. The real CSRF secret is derived from csrfSessionId + server CSRF_SECRET using HMAC.
 * 3. Tokens are verified against this derived secret on every state-changing request.
 */

const tokens = new csrf()

export { tokens }

// ── Helpers ─────────────────────────────────────────────────────────────────

export function generateSessionId() {
  return crypto.randomBytes(32).toString('base64url')
}

export function deriveCSRFSecret(sessionId) {
  if (!sessionId) {
    throw new Error('Session ID is required for CSRF secret derivation')
  }
  return crypto.createHmac('sha256', config.csrfSecret)
    .update(sessionId)
    .digest('base64')
}

/**
 * Ensure a csrfSessionId cookie exists on the response.
 * Returns the session ID (existing or newly created).
 */
export function ensureCSRFCookie(req, res) {
  let sessionId = req.cookies.csrfSessionId
  if (!sessionId) {
    sessionId = generateSessionId()
    if (!res.headersSent) {
      res.cookie('csrfSessionId', sessionId, withCookieDefaults({
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000
      }))
    }
  }
  return sessionId
}

// ── Route helpers ───────────────────────────────────────────────────────────

const SUBPATH = config.subpath

const matchesApiRoute = (req, route) => {
  if (!route) return false
  const { path, originalUrl } = req
  if (path === route) return true
  const normalized = originalUrl?.split('?')[0]
  if (normalized === route) return true
  if (SUBPATH !== '/' && normalized === `${SUBPATH}${route}`) return true
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

  // Skip CSRF for non-authenticated users on logout
  if (matchesApiRoute(req, '/api/auth/logout') && !req.cookies.authToken) return next()

  // Apply CSRF validation for all other state-changing operations
  const token = req.get('X-CSRF-Token') || req.body._csrf

  let sessionId = req.cookies.csrfSessionId
  if (!sessionId) {
    sessionId = generateSessionId()
    res.cookie('csrfSessionId', sessionId, withCookieDefaults({
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000
    }))
  }

  const secret = deriveCSRFSecret(sessionId)

  if (!token || !tokens.verify(secret, token)) {
    return res.status(403).json({
      error: 'Invalid CSRF token',
      csrfRequired: true
    })
  }

  next()
}
