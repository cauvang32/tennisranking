import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import config from '../config/env.js'

/**
 * JWT encryption, decryption, and token generation.
 *
 * Encryption uses AES-256-GCM (authenticated encryption) to wrap JWT tokens
 * before storing them in httpOnly cookies. This prevents token extraction
 * even if an XSS vulnerability exists.
 *
 * Legacy CBC-encrypted tokens are automatically migrated on read.
 */

// Pre-compute scrypt key once at startup (scrypt is intentionally slow ~100ms)
const jwtEncryptionKey = crypto.scryptSync(config.jwtSecret, 'jwt-salt', 32)

/**
 * Encrypt a JWT token with AES-256-GCM before storing in cookie.
 * @param {string} token - Plain JWT token
 * @returns {string} Encrypted token in format iv:ciphertext:authTag
 */
export function encryptJWT(token) {
  const iv = crypto.randomBytes(12) // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', jwtEncryptionKey, iv)

  let encrypted = cipher.update(token, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  const authTag = cipher.getAuthTag().toString('hex')

  return `${iv.toString('hex')}:${encrypted}:${authTag}`
}

/**
 * Decrypt a JWT token from cookie storage.
 * Supports both GCM (current) and legacy CBC format for migration.
 * @param {string} encryptedToken - Encrypted token string
 * @returns {string|null} Decrypted JWT or null on failure
 */
export function decryptJWT(encryptedToken) {
  try {
    const parts = encryptedToken.split(':')

    if (parts.length === 2) {
      // Legacy CBC format (iv:encrypted) — backward compatibility
      const [ivHex, encrypted] = parts
      if (!ivHex || !encrypted) throw new Error('Invalid token format')
      const decipher = crypto.createDecipheriv('aes-256-cbc', jwtEncryptionKey, Buffer.from(ivHex, 'hex'))
      let decrypted = decipher.update(encrypted, 'hex', 'utf8')
      decrypted += decipher.final('utf8')
      return decrypted
    }

    if (parts.length !== 3) {
      throw new Error('Invalid encrypted token format')
    }

    const [ivHex, encrypted, authTagHex] = parts
    if (!ivHex || !encrypted || !authTagHex) throw new Error('Invalid token format')

    const decipher = crypto.createDecipheriv('aes-256-gcm', jwtEncryptionKey, Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'))

    let decrypted = decipher.update(encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')

    return decrypted
  } catch (error) {
    console.error('JWT decryption failed:', error)
    return null
  }
}

/**
 * Generate a short-lived access token.
 */
export function generateToken(user) {
  return jwt.sign(
    {
      id: user.id || null,
      username: user.username,
      email: user.email,
      role: user.role || 'admin',
      tokenVersion: user.tokenVersion ?? user.token_version ?? 0,
      type: 'access'
    },
    config.jwtSecret,
    { expiresIn: config.jwtAccessTokenExpiry, algorithm: config.jwtAlgorithm }
  )
}

/**
 * Generate a long-lived refresh token.
 */
export function generateRefreshToken(user) {
  return jwt.sign(
    {
      username: user.username,
      role: user.role || 'admin',
      type: 'refresh'
    },
    config.jwtSecret,
    { expiresIn: config.jwtRefreshTokenExpiry, algorithm: config.jwtAlgorithm }
  )
}
