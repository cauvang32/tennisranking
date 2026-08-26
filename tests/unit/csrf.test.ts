import { describe, it, expect } from 'vitest'

// Set required env vars before importing modules
process.env.ADMIN_USERNAME = 'test_admin'
process.env.ADMIN_PASSWORD = 'test_password'
process.env.EDITOR_USERNAME = 'test_editor'
process.env.EDITOR_PASSWORD = 'test_password'
process.env.JWT_SECRET = 'test_jwt_secret_at_least_32_characters_long_xyz'
process.env.CSRF_SECRET = 'test_csrf_secret_at_least_32_characters_long_xyz'

const { deriveCSRFSecretFromUser, tokens } = await import('../../middleware/csrf.js')

describe('CSRF middleware', () => {
  describe('deriveCSRFSecretFromUser', () => {
    it('should derive a consistent secret from the same user ID', () => {
      const secret1 = deriveCSRFSecretFromUser({ id: 1 })
      const secret2 = deriveCSRFSecretFromUser({ id: 1 })
      expect(secret1).toBe(secret2)
    })

    it('should derive different secrets for different user IDs', () => {
      const s1 = deriveCSRFSecretFromUser({ id: 1 })
      const s2 = deriveCSRFSecretFromUser({ id: 2 })
      expect(s1).not.toBe(s2)
    })

    it('should use "anonymous" when no user is provided', () => {
      const s1 = deriveCSRFSecretFromUser(null)
      const s2 = deriveCSRFSecretFromUser(undefined)
      expect(s1).toBe(s2)
      expect(s1).toBe(deriveCSRFSecretFromUser({ id: 'anonymous' }))
    })

    it('should handle numeric and string IDs (toString makes them equal)', () => {
      const s1 = deriveCSRFSecretFromUser({ id: 42 })
      const s2 = deriveCSRFSecretFromUser({ id: '42' })
      expect(s1).toBe(s2)
    })
  })

  describe('CSRF token create + verify', () => {
    it('should create a token that verifies against the same user secret', () => {
      const secret = deriveCSRFSecretFromUser({ id: 1 })
      const token = tokens.create(secret)

      expect(tokens.verify(secret, token)).toBe(true)
    })

    it('should fail verification with a different user secret', () => {
      const secret1 = deriveCSRFSecretFromUser({ id: 1 })
      const secret2 = deriveCSRFSecretFromUser({ id: 2 })
      const token = tokens.create(secret1)

      expect(tokens.verify(secret2, token)).toBe(false)
    })

    it('should fail verification with a tampered token', () => {
      const secret = deriveCSRFSecretFromUser({ id: 1 })
      const token = tokens.create(secret)
      const tampered = token.slice(0, -2) + 'XX'

      expect(tokens.verify(secret, tampered)).toBe(false)
    })
  })
})
