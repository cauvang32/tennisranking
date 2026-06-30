/**
 * Inline auth routes (login / logout / refresh / status).
 * Extracted from server.js for modularity and testability.
 * Follows the same factory pattern as other route modules.
 */
import { Router } from 'express'
import { body } from 'express-validator'
import bcrypt from 'bcryptjs'
import config from '../config/env.js'
import { asyncHandler } from '../utils/async-handler.js'
import { verifyToken } from '../lib/jwt-encryption.js'

export const createInlineAuthRouter = ({
  db,
  checkAuth,
  hashedAdminPassword,
  hashedEditorPassword,
  generateToken,
  generateRefreshToken,
  readToken,
  withCookieDefaults,
  clearCookieAllPaths,
  deriveCSRFSecretFromUser,
  tokens,
  authLimiter,
  refreshLimiter,
  loginLimiter,
  handleValidationErrors
}) => {
  const router = Router()

  // ── Login ──────────────────────────────────────────────────────────────
  router.post('/api/auth/login',
    loginLimiter,
    authLimiter,
    [
      body('username').trim().isLength({ min: 1, max: 50 }),
      body('password').trim().isLength({ min: 1, max: 100 })
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      try {
        const { username, password } = req.body
        let user = null, isDbUser = false

        // Check database users first
        try {
          const dbUser = await db.getUserByUsername(username)
          if (dbUser && dbUser.is_active) {
            if (await bcrypt.compare(password, dbUser.password_hash)) {
              user = {
                id: dbUser.id, username: dbUser.username, email: dbUser.email,
                role: dbUser.role, displayName: dbUser.display_name,
                tokenVersion: dbUser.token_version || 0
              }
              isDbUser = true
              await db.updateUserLastLogin(dbUser.id)
            }
          }
        } catch { /* continue to env-based check */ }

        // Fallback to env-based admin/editor
        if (!user) {
          if (username === config.admin.username &&
              await bcrypt.compare(password, hashedAdminPassword)) {
            user = {
              username: config.admin.username, email: config.admin.email,
              role: 'admin', displayName: 'System Admin'
            }
          } else if (username === config.editor.username &&
                     await bcrypt.compare(password, hashedEditorPassword)) {
            user = {
              username: config.editor.username, email: config.editor.email,
              role: 'editor', displayName: 'System Editor'
            }
          }
        }

        if (!user) return res.status(401).json({ error: 'Invalid credentials' })

        const token = generateToken(user)
        const refreshToken = generateRefreshToken(user)

        res.cookie('authToken', token, withCookieDefaults({ httpOnly: true, maxAge: 15 * 60 * 1000 }))
        res.cookie('refreshToken', refreshToken, withCookieDefaults({ httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 }))

        const csrfToken = tokens.create(deriveCSRFSecretFromUser(user))

        const isAPIClient = !req.headers.accept?.includes('text/html') && req.headers.accept?.includes('application/json')
        const response = {
          success: true, message: 'Login successful', csrfToken,
          user: {
            id: user.id, username: user.username, email: user.email,
            role: user.role, displayName: user.displayName, isSystemUser: !isDbUser
          }
        }
        if (isAPIClient) { response.token = token; response.authMethod = 'bearer_token' }
        else { response.authMethod = 'httponly_cookie' }

        res.json(response)
      } catch (error) {
        console.error('Login error:', error)
        res.status(500).json({ error: 'Login failed' })
      }
    })
  )

  // ── Logout ─────────────────────────────────────────────────────────────
  router.post('/api/auth/logout', checkAuth, asyncHandler(async (req, res) => {
    try {
      if (res.headersSent) return
      if (req.isAuthenticated) {
        const token = req.get('X-CSRF-Token') || req.body._csrf
        if (!token || !tokens.verify(req.csrfSecret, token)) {
          return res.status(403).json({ error: 'Invalid CSRF token', csrfRequired: true })
        }
        // Increment token_version for DB users to revoke all existing tokens
        if (req.user?.id && typeof db.incrementTokenVersion === 'function') {
          try { await db.incrementTokenVersion(req.user.id) } catch { /* best-effort */ }
        }
      }
      // Nuclear option: force browser to destroy all cookies for this site
      res.setHeader('Clear-Site-Data', '"cookies"')
      clearCookieAllPaths(res, 'authToken')
      clearCookieAllPaths(res, 'refreshToken')
      return res.json({ success: true, message: 'Logged out successfully' })
    } catch (error) {
      console.error('Logout error:', error)
      if (!res.headersSent) return res.status(500).json({ success: false, error: 'Logout failed' })
    }
  }))

  // ── Auth status ────────────────────────────────────────────────────────
  router.get('/api/auth/status', checkAuth, (req, res) => {
    if (req.isAuthenticated) {
      res.json({ authenticated: true, user: req.user, csrfToken: tokens.create(req.csrfSecret) })
    } else {
      res.json({ authenticated: false })
    }
  })

  // ── Refresh token ──────────────────────────────────────────────────────
  router.post('/api/auth/refresh', refreshLimiter, asyncHandler(async (req, res) => {
    try {
      const enc = req.cookies?.refreshToken
      if (!enc) return res.status(401).json({ error: 'No refresh token provided' })

      let decoded
      try {
        const rawToken = readToken(enc) || enc
        decoded = verifyToken(rawToken)
        if (!decoded) return res.status(401).json({ error: 'Invalid refresh token' })
        if (decoded.type !== 'refresh') return res.status(401).json({ error: 'Invalid token type' })
      } catch { return res.status(401).json({ error: 'Invalid refresh token' }) }

      // Server-side token revocation check for database users
      if (decoded.id && db && typeof db.getTokenVersion === 'function') {
        const currentVersion = await db.getTokenVersion(decoded.id)
        if (currentVersion === null) {
          clearCookieAllPaths(res, 'authToken')
          clearCookieAllPaths(res, 'refreshToken')
          return res.status(401).json({ error: 'User no longer exists' })
        }
        if (typeof decoded.tokenVersion === 'number' && decoded.tokenVersion !== currentVersion) {
          clearCookieAllPaths(res, 'authToken')
          clearCookieAllPaths(res, 'refreshToken')
          return res.status(401).json({ error: 'Token has been revoked' })
        }
      }

      const user = {
        id: decoded.id, username: decoded.username,
        role: decoded.role, tokenVersion: decoded.tokenVersion
      }
      res.cookie('authToken', generateToken(user), withCookieDefaults({ httpOnly: true, maxAge: 15 * 60 * 1000 }))
      res.json({
        success: true,
        csrfToken: tokens.create(deriveCSRFSecretFromUser(user)),
        user
      })
    } catch (error) {
      console.error('Token refresh error:', error)
      res.status(500).json({ error: 'Token refresh failed' })
    }
  }))

  return router
}
