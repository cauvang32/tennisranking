import crypto from 'crypto'

// Timing-safe string comparison to prevent timing attacks
export const timingSafeCompare = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false
  }
  // Use same-length comparison to prevent timing leak
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) {
    // Compare against self to maintain constant time
    crypto.timingSafeEqual(bufA, bufA)
    return false
  }
  return crypto.timingSafeEqual(bufA, bufB)
}

export const createSecurityHelpers = ({
  jwtSecret,
  csrfSecret,
  cookieDefaults,
  cookiePaths,
  tokens
}) => {
  if (!jwtSecret) throw new Error('jwtSecret is required')
  if (!csrfSecret) throw new Error('csrfSecret is required')

  // Pre-compute scrypt key once at startup (scrypt is intentionally slow ~100ms)
  const jwtKey = crypto.scryptSync(jwtSecret, 'jwt-salt', 32)

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
    const iv = crypto.randomBytes(12) // 96-bit IV for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', jwtKey, iv)

    let encrypted = cipher.update(token, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    const authTag = cipher.getAuthTag().toString('hex')
    return `${iv.toString('hex')}:${encrypted}:${authTag}`
  }

  const decryptJWT = (encryptedToken) => {
    try {
      const parts = encryptedToken.split(':')
      if (parts.length === 2) {
        // Legacy CBC format (iv:encrypted) — decrypt with CBC for backward compatibility
        const [ivHex, encrypted] = parts
        if (!ivHex || !encrypted) throw new Error('Invalid token format')
        const legacyKey = crypto.scryptSync(jwtSecret, 'jwt-salt', 32)
        const decipher = crypto.createDecipheriv('aes-256-cbc', legacyKey, Buffer.from(ivHex, 'hex'))
        let decrypted = decipher.update(encrypted, 'hex', 'utf8')
        decrypted += decipher.final('utf8')
        return decrypted
      }
      if (parts.length !== 3) throw new Error('Invalid encrypted token format')
      const [ivHex, encrypted, authTagHex] = parts
      if (!ivHex || !encrypted || !authTagHex) throw new Error('Invalid token format')
      const decipher = crypto.createDecipheriv('aes-256-gcm', jwtKey, Buffer.from(ivHex, 'hex'))
      decipher.setAuthTag(Buffer.from(authTagHex, 'hex'))
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

  // Session fixation protection: regenerate session ID after authentication
  const regenerateSession = (res) => {
    const newSessionId = generateSessionId()
    issueCSRFCookie(res, newSessionId)
    return newSessionId
  }

  // Timing-safe CSRF token verification wrapper
  const verifyCSRFToken = (token, secret, tokensLib) => {
    if (!token || !secret) return false
    try {
      // Verify using library (handles crypto) with timing normalization
      const isValid = tokensLib.verify(secret, token)
      const expectedToken = tokensLib.create(secret)
      const timingMatch = timingSafeCompare(token, expectedToken)
      return isValid && timingMatch
    } catch {
      return false
    }
  }

  return {
    withCookieDefaults,
    clearCookieAllPaths,
    deriveCSRFSecret,
    encryptJWT,
    decryptJWT,
    generateSessionId,
    ensureCSRFCookie,
    regenerateSession,
    verifyCSRFToken,
    timingSafeCompare
  }
}
