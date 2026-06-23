import { describe, it, expect } from 'vitest'

process.env.ADMIN_USERNAME = 'test_admin'
process.env.ADMIN_PASSWORD = 'test_password'
process.env.EDITOR_USERNAME = 'test_editor'
process.env.EDITOR_PASSWORD = 'test_password'
process.env.JWT_SECRET = 'test_jwt_secret_at_least_32_characters_long_xyz'
process.env.CSRF_SECRET = 'test_csrf_secret_at_least_32_characters_long_xyz'
// Disable RSA keys in tests so jwtAlgorithm stays HS256 (symmetric).
process.env.RSA_PRIVATE_KEY_PATH = ''
process.env.RSA_PUBLIC_KEY_PATH = ''

const { readToken, generateToken } = await import('../../lib/jwt-encryption.js')
const jwt = await import('jsonwebtoken')
const config = await import('../../config/env.js')

describe('Token migration (readToken)', () => {
  it('should pass through a raw JWT unchanged', () => {
    // Real JWT starts with eyJ
    const raw = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.dyrkGtXXkdAgdLl5aECJtAAG3M3xzoORz72sfEwLPCc'
    expect(readToken(raw)).toBe(raw)
  })

  it('should pass through any eyJ-starting string (raw JWT)', () => {
    const raw = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.payload'
    expect(readToken(raw)).toBe(raw)
  })

  it('should return null for null / undefined / empty string', () => {
    expect(readToken(null)).toBeNull()
    expect(readToken(undefined)).toBeNull()
    expect(readToken('')).toBeNull()
  })

  it('should return null for unrecognized format (4+ colon-separated parts)', () => {
    expect(readToken('a:b:c:d')).toBeNull()
    expect(readToken('a:b:c:d:e')).toBeNull()
  })

  it('should return null for a single non-JWT string', () => {
    expect(readToken('just-garbage')).toBeNull()
    expect(readToken('random-string-here')).toBeNull()
  })

  it('should handle legacy CBC format (2 parts) without crashing', () => {
    // Legacy CBC: ivHex:ciphertextHex (no authTag)
    // With the test JWT_SECRET, this will decrypt to garbage — but should not throw.
    const legacy = 'abcdef0123456789abcdef01234567890:deadbeef12345678'
    const result = readToken(legacy)
    expect(result === null || typeof result === 'string').toBe(true)
  })

  it('readToken output can be verified with jwt.verify', () => {
    // Generate a real JWT, confirm readToken passes it through, then verify it
    const user = { username: 'migration_test', email: 'test@test.com', role: 'admin' }
    const rawToken = generateToken(user)
    const passedThrough = readToken(rawToken)
    expect(passedThrough).toBe(rawToken)

    // Verify the JWT is valid
    const decoded = jwt.default.verify(passedThrough, config.default.jwtSecret, {
      algorithms: [config.default.jwtAlgorithm]
    })
    expect(decoded.username).toBe('migration_test')
    expect(decoded.type).toBe('access')
  })
})
