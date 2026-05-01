export const buildAuthMiddleware = ({
  jwt,
  security,
  tokens,
  db,
  roles = ['admin', 'editor']
}) => {
  const { decryptJWT, clearCookieAllPaths, deriveCSRFSecret, ensureCSRFCookie } = security

  const authenticateToken = async (req, res, next) => {
    let token = req.cookies.authToken || (req.headers['authorization'] && req.headers['authorization'].split(' ')[1])

    if (!token) {
      return res.status(401).json({ error: 'Access token required' })
    }

    if (req.cookies.authToken && token === req.cookies.authToken) {
      token = decryptJWT(token)
      if (!token) {
        clearCookieAllPaths(res, 'authToken')
        return res.status(401).json({ error: 'Invalid encrypted token' })
      }
    }

    try {
      const user = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] })

      // Reject refresh tokens used as access tokens
      if (user.type && user.type !== 'access') {
        return res.status(401).json({ error: 'Invalid token type' })
      }

      // Server-side token revocation check for database users
      // System users (env-based admin/editor) don't have a DB id, skip this check
      if (user.id && db && typeof db.getTokenVersion === 'function') {
        try {
          const currentVersion = await db.getTokenVersion(user.id)
          if (typeof user.tokenVersion === 'number' && user.tokenVersion !== currentVersion) {
            if (req.cookies.authToken) {
              clearCookieAllPaths(res, 'authToken')
            }
            return res.status(401).json({ error: 'Token has been revoked' })
          }
        } catch {
          // If DB check fails, allow through (fail-open for availability)
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
        token = decryptJWT(token)
        if (!token) {
          if (!res.headersSent) {
            clearCookieAllPaths(res, 'authToken')
          }
          req.isAuthenticated = false
          req.csrfSecret = deriveCSRFSecret(ensureCSRFCookie(req, res))
          return next()
        }
      }

      try {
        const user = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] })

        // Server-side token revocation check (same as authenticateToken)
        if (user.id && db && typeof db.getTokenVersion === 'function') {
          try {
            const currentVersion = await db.getTokenVersion(user.id)
            if (typeof user.tokenVersion === 'number' && user.tokenVersion !== currentVersion) {
              if (req.cookies.authToken && !res.headersSent) {
                clearCookieAllPaths(res, 'authToken')
              }
              req.isAuthenticated = false
              req.csrfSecret = deriveCSRFSecret(ensureCSRFCookie(req, res))
              return next()
            }
          } catch {
            // If DB check fails, allow through (fail-open for availability)
          }
        }

        req.user = user
        req.isAuthenticated = true
      } catch {
        if (req.cookies.authToken && !res.headersSent) {
          clearCookieAllPaths(res, 'authToken')
        }
      }
    }

    req.isAuthenticated = req.isAuthenticated || false

    const sessionId = ensureCSRFCookie(req, res)
    req.csrfSecret = deriveCSRFSecret(sessionId)
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
