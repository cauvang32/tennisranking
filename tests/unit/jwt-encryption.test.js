import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// We test the JWT encryption module directly — no Redis or DB needed.
// Set required env vars before importing the module under test.
process.env.ADMIN_USERNAME = 'test_admin'
process.env.ADMIN_PASSWORD = 'test_password'
process.env.EDITOR_USERNAME = 'test_editor'
process.env.EDITOR_PASSWORD = 'test_password'
process.env.JWT_SECRET = 'test_jwt_secret_at_least_32_characters_long_xyz'
process.env.CSRF_SECRET = 'test_csrf_secret_at_least_32_characters_long_xyz'

const { encryptJWT, decryptJWT, generateToken, generateRefreshToken } = await import('../../lib/jwt-encryption.js')

describe('JWT Encryption', () => {
  describe('encryptJWT / decryptJWT', () => {
    it('should encrypt and decrypt a token correctly', () => {
      const originalToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.payload'
      const encrypted = encryptJWT(originalToken)
      const decrypted = decryptJWT(encrypted)

      expect(decrypted).toBe(originalToken)
    })

    it('should produce different ciphertexts for the same input (random IV)', () => {
      const token = 'same-token'
      const enc1 = encryptJWT(token)
      const enc2 = encryptJWT(token)

      expect(enc1).not.toBe(enc2) // different IVs
      expect(decryptJWT(enc1)).toBe(token) // both decrypt correctly
      expect(decryptJWT(enc2)).toBe(token)
    })

    it('should return iv:ciphertext:authTag format (GCM)', () => {
      const encrypted = encryptJWT('test')
      const parts = encrypted.split(':')

      expect(parts).toHaveLength(3)
      expect(parts[0]).toHaveLength(24) // 12 bytes = 24 hex chars (IV)
      expect(parts[2].length).toBeGreaterThan(0) // auth tag present
    })

    it('should return null for corrupted ciphertext', () => {
      const encrypted = encryptJWT('valid-token')
      const corrupted = encrypted.replace(/[a-f0-9]{2}/, 'XX')

      const result = decryptJWT(corrupted)
      expect(result).toBeNull()
    })

    it('should return null for completely invalid input', () => {
      expect(decryptJWT('not-a-valid-encrypted-token')).toBeNull()
      expect(decryptJWT('')).toBeNull()
      expect(decryptJWT('a:b:c:d')).toBeNull() // too many parts
    })

    it('should handle legacy CBC format (2-part token)', () => {
      // Legacy CBC format: iv:ciphertext (no authTag)
      // This test verifies the code path exists and doesn't crash,
      // though the actual legacy key derivation may differ.
      const legacyToken = 'abcdef0123456789abcdef01234567890:deadbeef'
      const result = decryptJWT(legacyToken)
      // Legacy tokens with wrong key should return null (not crash)
      expect(result).toBeNull()
    })
  })

  describe('generateToken', () => {
    it('should generate a valid JWT access token', () => {
      const user = { username: 'testuser', email: 'test@test.com', role: 'admin' }
      const token = generateToken(user)

      expect(token).toBeTruthy()
      expect(typeof token).toBe('string')
      expect(token.split('.')).toHaveLength(3) // JWT has 3 parts
    })

    it('should include correct claims', () => {
      const user = { username: 'testuser', email: 'test@test.com', role: 'editor' }
      const token = generateToken(user)

      // Decode payload (base64url)
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())

      expect(payload.username).toBe('testuser')
      expect(payload.email).toBe('test@test.com')
      expect(payload.role).toBe('editor')
      expect(payload.type).toBe('access')
      expect(payload.exp).toBeDefined()
    })
  })

  describe('generateRefreshToken', () => {
    it('should generate a refresh token with type "refresh"', () => {
      const user = { username: 'testuser', role: 'admin' }
      const token = generateRefreshToken(user)

      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())

      expect(payload.type).toBe('refresh')
      expect(payload.username).toBe('testuser')
      expect(payload.role).toBe('admin')
    })

    it('should have a longer expiry than access tokens', () => {
      const user = { username: 'testuser', role: 'admin' }
      const access = generateToken(user)
      const refresh = generateRefreshToken(user)

      const accessPayload = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString())
      const refreshPayload = JSON.parse(Buffer.from(refresh.split('.')[1], 'base64url').toString())

      expect(refreshPayload.exp).toBeGreaterThan(accessPayload.exp)
    })
  })
})
