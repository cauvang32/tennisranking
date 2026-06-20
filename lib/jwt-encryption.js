import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import config from '../config/env.js'

/**
 * Token generation and migration helper.
 *
 * - generateToken() / generateRefreshToken() — produce JWTs signed with HS256.
 * - readToken() — migration helper that decrypts legacy AES-wrapped tokens
 *   (GCM 3-part or CBC 2-part format) and passes through raw JWTs unchanged.
 */

/**
 * Migration helper: decrypt legacy encrypted tokens, or pass through raw JWTs.
 * Keeps the scrypt key computation scoped here so it is not exported.
 * @param {string} encryptedOrRaw - Encrypted token (old format) or raw JWT
 * @returns {string|null} Decrypted / raw JWT, or null for truly invalid input
 */
export function readToken(encryptedOrRaw) {
  if (!encryptedOrRaw || typeof encryptedOrRaw !== 'string') return null

  // Pass through raw JWT (starts witheyJ header)
  if (encryptedOrRaw.startsWith('eyJ')) return encryptedOrRaw

  try {
    const parts = encryptedOrRaw.split(':')

    // Legacy CBC format (2 parts: iv:encrypted)
    if (parts.length === 2) {
      const [ivHex, encrypted] = parts
      if (!ivHex || !encrypted) return null
      const key = crypto.scryptSync(config.jwtSecret, 'jwt-salt', 32)
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'))
      return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8')
    }

    // Current GCM format (3 parts: iv:ciphertext:authTag)
    if (parts.length === 3) {
      const [ivHex, encrypted, authTagHex] = parts
      if (!ivHex || !encrypted || !authTagHex) return null
      const key = crypto.scryptSync(config.jwtSecret, 'jwt-salt', 32)
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'))
      decipher.setAuthTag(Buffer.from(authTagHex, 'hex'))
      return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8')
    }

    return null // unrecognized format
  } catch (error) {
    console.error('readToken migration failed:', error.message)
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
      id: user.id || null,
      username: user.username,
      role: user.role || 'admin',
      tokenVersion: user.tokenVersion ?? user.token_version ?? 0,
      type: 'refresh'
    },
    config.jwtSecret,
    { expiresIn: config.jwtRefreshTokenExpiry, algorithm: config.jwtAlgorithm }
  )
}
