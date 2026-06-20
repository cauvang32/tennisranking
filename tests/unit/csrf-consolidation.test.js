import { describe, it, expect } from 'vitest'

process.env.ADMIN_USERNAME = 'test_admin'
process.env.ADMIN_PASSWORD = 'test_password'
process.env.EDITOR_USERNAME = 'test_editor'
process.env.EDITOR_PASSWORD = 'test_password'
process.env.JWT_SECRET = 'test_jwt_secret_at_least_32_characters_long_xyz'
process.env.CSRF_SECRET = 'test_csrf_secret_at_least_32_characters_long_xyz'

const { deriveCSRFSecretFromUser, tokens } = await import('../../middleware/csrf.js')

describe('CSRF consolidation', () => {
  it('deriveCSRFSecretFromUser({ id: 1 }) produces consistent output across calls', () => {
    const s1 = deriveCSRFSecretFromUser({ id: 1 })
    const s2 = deriveCSRFSecretFromUser({ id: 1 })
    const s3 = deriveCSRFSecretFromUser({ id: 1 })
    expect(s1).toBe(s2)
    expect(s2).toBe(s3)
  })

  it('deriveCSRFSecretFromUser(null) and undefined both use "anonymous"', () => {
    const s1 = deriveCSRFSecretFromUser(null)
    const s2 = deriveCSRFSecretFromUser(undefined)
    const s3 = deriveCSRFSecretFromUser({ id: 'anonymous' })
    expect(s1).toBe(s2)
    expect(s2).toBe(s3)
  })

  it('different users get different secrets', () => {
    const secrets = new Set()
    for (let i = 1; i <= 50; i++) {
      secrets.add(deriveCSRFSecretFromUser({ id: i }))
    }
    expect(secrets.size).toBe(50) // all unique
  })

  it('CSRF tokens created with the new secret verify correctly', () => {
    const secret = deriveCSRFSecretFromUser({ id: 42 })
    const token = tokens.create(secret)
    expect(tokens.verify(secret, token)).toBe(true)
  })

  it('tokens from different users do not cross-verify', () => {
    const s1 = deriveCSRFSecretFromUser({ id: 1 })
    const s2 = deriveCSRFSecretFromUser({ id: 2 })
    const token = tokens.create(s1)
    expect(tokens.verify(s2, token)).toBe(false)
  })
})
