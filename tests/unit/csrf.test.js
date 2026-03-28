import { describe, it, expect } from 'vitest'

// Set required env vars before importing modules
process.env.ADMIN_USERNAME = 'test_admin'
process.env.ADMIN_PASSWORD = 'test_password'
process.env.EDITOR_USERNAME = 'test_editor'
process.env.EDITOR_PASSWORD = 'test_password'
process.env.JWT_SECRET = 'test_jwt_secret_at_least_32_characters_long_xyz'
process.env.CSRF_SECRET = 'test_csrf_secret_at_least_32_characters_long_xyz'

const { deriveCSRFSecret, ensureCSRFCookie, tokens, generateSessionId } = await import('../../middleware/csrf.js')

describe('CSRF middleware', () => {
  describe('generateSessionId', () => {
    it('should generate a base64url string', () => {
      const id = generateSessionId()
      expect(typeof id).toBe('string')
      expect(id.length).toBeGreaterThan(20)
    })

    it('should generate unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateSessionId()))
      expect(ids.size).toBe(100) // all unique
    })
  })

  describe('deriveCSRFSecret', () => {
    it('should derive a consistent secret from the same session ID', () => {
      const sessionId = generateSessionId()
      const secret1 = deriveCSRFSecret(sessionId)
      const secret2 = deriveCSRFSecret(sessionId)
      expect(secret1).toBe(secret2)
    })

    it('should derive different secrets for different session IDs', () => {
      const s1 = deriveCSRFSecret(generateSessionId())
      const s2 = deriveCSRFSecret(generateSessionId())
      expect(s1).not.toBe(s2)
    })

    it('should throw for missing session ID', () => {
      expect(() => deriveCSRFSecret(undefined)).toThrow()
      expect(() => deriveCSRFSecret('')).toThrow()
    })
  })

  describe('CSRF token create + verify', () => {
    it('should create a token that verifies against the same secret', () => {
      const sessionId = generateSessionId()
      const secret = deriveCSRFSecret(sessionId)
      const token = tokens.create(secret)

      expect(tokens.verify(secret, token)).toBe(true)
    })

    it('should fail verification with a different secret', () => {
      const secret1 = deriveCSRFSecret(generateSessionId())
      const secret2 = deriveCSRFSecret(generateSessionId())
      const token = tokens.create(secret1)

      expect(tokens.verify(secret2, token)).toBe(false)
    })

    it('should fail verification with a tampered token', () => {
      const secret = deriveCSRFSecret(generateSessionId())
      const token = tokens.create(secret)
      const tampered = token.slice(0, -2) + 'XX'

      expect(tokens.verify(secret, tampered)).toBe(false)
    })
  })

  describe('ensureCSRFCookie', () => {
    it('should return existing session ID from cookies', () => {
      const existingId = 'existing-session-id-abc'
      const req = { cookies: { csrfSessionId: existingId } }
      const res = { cookie: () => {} }

      const id = ensureCSRFCookie(req, res)
      expect(id).toBe(existingId)
    })

    it('should generate and set a new session ID when none exists', () => {
      const req = { cookies: {} }
      let setCookieName = null
      let setCookieValue = null
      const res = {
        cookie: (name, value, _opts) => {
          setCookieName = name
          setCookieValue = value
        }
      }

      const id = ensureCSRFCookie(req, res)
      expect(typeof id).toBe('string')
      expect(id.length).toBeGreaterThan(20)
      expect(setCookieName).toBe('csrfSessionId')
      expect(setCookieValue).toBe(id)
    })
  })
})
