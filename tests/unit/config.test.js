import { describe, it, expect, vi, beforeEach } from 'vitest'

// Set required env vars before importing modules
process.env.ADMIN_USERNAME = 'test_admin'
process.env.ADMIN_PASSWORD = 'test_password'
process.env.EDITOR_USERNAME = 'test_editor'
process.env.EDITOR_PASSWORD = 'test_password'
process.env.JWT_SECRET = 'test_jwt_secret_at_least_32_characters_long_xyz'
process.env.CSRF_SECRET = 'test_csrf_secret_at_least_32_characters_long_xyz'

const configModule = await import('../../config/env.js')
const config = configModule.default

describe('config/env.js', () => {
  describe('envFlagTrue', () => {
    const { envFlagTrue } = configModule

    it('should return true for "true", "1", "yes"', () => {
      expect(envFlagTrue('true')).toBe(true)
      expect(envFlagTrue('TRUE')).toBe(true)
      expect(envFlagTrue('1')).toBe(true)
      expect(envFlagTrue('yes')).toBe(true)
      expect(envFlagTrue('YES')).toBe(true)
    })

    it('should return false for "false", "0", "no", undefined, null', () => {
      expect(envFlagTrue('false')).toBe(false)
      expect(envFlagTrue('0')).toBe(false)
      expect(envFlagTrue('no')).toBe(false)
      expect(envFlagTrue(undefined)).toBe(false)
      expect(envFlagTrue(null)).toBe(false)
    })
  })

  describe('parseNumberEnv', () => {
    const { parseNumberEnv } = configModule

    it('should parse valid numbers from env vars', () => {
      process.env.TEST_NUM = '42'
      expect(parseNumberEnv('TEST_NUM', 0)).toBe(42)
    })

    it('should return fallback for missing vars', () => {
      expect(parseNumberEnv('NONEXISTENT_VAR', 99)).toBe(99)
    })

    it('should return fallback for non-numeric values', () => {
      process.env.TEST_NAN = 'not-a-number'
      expect(parseNumberEnv('TEST_NAN', 77)).toBe(77)
    })
  })

  describe('clampNumber', () => {
    const { clampNumber } = configModule

    it('should clamp values within range', () => {
      expect(clampNumber(50, 0, 100)).toBe(50)
      expect(clampNumber(-5, 0, 100)).toBe(0)
      expect(clampNumber(150, 0, 100)).toBe(100)
    })

    it('should return min for NaN/Infinity', () => {
      expect(clampNumber(NaN, 10, 100)).toBe(10)
      expect(clampNumber(Infinity, 10, 100)).toBe(10)
    })
  })

  describe('config object', () => {
    it('should have required fields', () => {
      expect(config.port).toBeDefined()
      expect(config.jwtSecret).toBeDefined()
      expect(config.csrfSecret).toBeDefined()
      expect(config.admin.username).toBe('test_admin')
      expect(config.editor.username).toBe('test_editor')
    })

    it('should have rate limit config', () => {
      expect(config.rateLimit).toBeDefined()
      expect(config.rateLimit.windowMs).toBeGreaterThan(0)
      expect(config.rateLimit.dynamic).toBeDefined()
    })

    it('should have cookie config', () => {
      expect(config.cookie).toBeDefined()
      expect(config.cookie.defaults).toBeDefined()
      expect(config.cookie.defaults.httpOnly).toBe(true)
    })
  })
})

const { withCookieDefaults, clearCookieAllPaths, getCookiePathsToClear } = await import('../../config/cookie.js')

describe('config/cookie.js', () => {
  describe('withCookieDefaults', () => {
    it('should include httpOnly, secure, sameSite defaults', () => {
      const result = withCookieDefaults()
      expect(result.httpOnly).toBe(true)
      expect(result.path).toBe('/')
      expect(result.sameSite).toBeDefined()
    })

    it('should allow overriding options', () => {
      const result = withCookieDefaults({ maxAge: 5000 })
      expect(result.maxAge).toBe(5000)
      expect(result.httpOnly).toBe(true) // default preserved
    })
  })

  describe('getCookiePathsToClear', () => {
    it('should always include root path', () => {
      const paths = getCookiePathsToClear()
      expect(paths).toContain('/')
    })

    it('should include /api paths', () => {
      const paths = getCookiePathsToClear()
      expect(paths).toContain('/api')
      expect(paths).toContain('/api/')
    })
  })
})
