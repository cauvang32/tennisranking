export const buildAuthMiddleware = ({
  jwt,
  security,
  tokens,
  roles = ['admin', 'editor']
}) => {
  const { decryptJWT, clearCookieAllPaths, deriveCSRFSecret, ensureCSRFCookie } = security

  const authenticateToken = (req, res, next) => {
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

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
      if (err) {
        if (req.cookies.authToken) {
          clearCookieAllPaths(res, 'authToken')
        }
        return res.status(403).json({ error: 'Invalid or expired token' })
      }
      req.user = user
      req.isAuthenticated = true
      next()
    })
  }

  const checkAuth = (req, res, next) => {
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

      jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (!err) {
          req.user = user
          req.isAuthenticated = true
        } else if (req.cookies.authToken && !res.headersSent) {
          clearCookieAllPaths(res, 'authToken')
        }
      })
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
        return res.status(403).json({
          error: 'Insufficient permissions',
          required: rolesArray,
          current: userRole
        })
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
