import crypto from 'crypto'

export const createSecurityHelpers = ({
  jwtSecret,
  csrfSecret,
  cookieDefaults,
  cookiePaths,
  tokens
}) => {
  if (!jwtSecret) throw new Error('jwtSecret is required')
  if (!csrfSecret) throw new Error('csrfSecret is required')

  const withCookieDefaults = (options = {}) => ({
    ...cookieDefaults,
    path: '/',
    ...options
  })

  const clearCookieAllPaths = (res, name, extraOptions = {}) => {
    cookiePaths.forEach((path) => {
      res.clearCookie(name, {
        ...cookieDefaults,
        httpOnly: true,
        path,
        ...extraOptions
      })
    })
  }

  const generateSessionId = () => crypto.randomBytes(32).toString('base64url')

  const deriveCSRFSecret = (sessionId) => {
    if (!sessionId) {
      throw new Error('Session ID is required for CSRF secret derivation')
    }
    return crypto.createHmac('sha256', csrfSecret).update(sessionId).digest('base64')
  }

  const encryptJWT = (token) => {
    const algorithm = 'aes-256-cbc'
    const key = crypto.scryptSync(jwtSecret, 'jwt-salt', 32)
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv(algorithm, key, iv)

    let encrypted = cipher.update(token, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    return `${iv.toString('hex')}:${encrypted}`
  }

  const decryptJWT = (encryptedToken) => {
    try {
      const algorithm = 'aes-256-cbc'
      const key = crypto.scryptSync(jwtSecret, 'jwt-salt', 32)
      const [ivHex, encrypted] = encryptedToken.split(':')
      if (!ivHex || !encrypted) {
        throw new Error('Invalid encrypted token format')
      }
      const decipher = crypto.createDecipheriv(algorithm, key, Buffer.from(ivHex, 'hex'))
      let decrypted = decipher.update(encrypted, 'hex', 'utf8')
      decrypted += decipher.final('utf8')
      return decrypted
    } catch (error) {
      console.error('JWT decryption failed:', error)
      return null
    }
  }

  const issueCSRFCookie = (res, sessionId) => {
    res.cookie('csrfSessionId', sessionId, withCookieDefaults({
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000
    }))
  }

  const ensureCSRFCookie = (req, res) => {
    let sessionId = req.cookies.csrfSessionId
    if (!sessionId) {
      sessionId = generateSessionId()
      issueCSRFCookie(res, sessionId)
    }
    return sessionId
  }

  return {
    withCookieDefaults,
    clearCookieAllPaths,
    deriveCSRFSecret,
    encryptJWT,
    decryptJWT,
    generateSessionId,
    ensureCSRFCookie
  }
}
