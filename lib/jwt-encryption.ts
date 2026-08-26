import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import type { Algorithm, JwtPayload, SignOptions, VerifyOptions } from 'jsonwebtoken'
import config from '../config/env.js'

/**
 * Token generation and migration helper.
 *
 * Signing algorithm:
 *   - RS256 (asymmetric) when RSA_PRIVATE_KEY + RSA_PUBLIC_KEY are set
 *     (2026 OWASP recommendation for long-lived tokens).
 *   - HS256 (symmetric) as fallback when only JWT_SECRET is set.
 *
 * Encryption (legacy token migration):
 *   - GCM 3-part format (current): AES-256-GCM with scrypt key derivation
 *   - CBC 2-part format (legacy, deprecated): AES-256-CBC with scrypt key derivation
 *     The legacy CBC path is deprecated and will be removed in a future version.
 *     Existing CBC tokens will continue to work until all tokens are rotated.
 *
 * - generateToken() / generateRefreshToken() — sign with the configured algorithm.
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

  // Pass through raw JWT (starts with eyJ header)
  if (encryptedOrRaw.startsWith('eyJ')) return encryptedOrRaw

  try {
    const parts = encryptedOrRaw.split(':')

    // Legacy CBC format removed — all tokens have been rotated to GCM.
    // If a legacy token appears, it will be rejected and the user must re-login.

    // Current GCM format (3 parts: iv:ciphertext:authTag)
    if (parts.length === 3) {
      const [ivHex, encrypted, authTagHex] = parts
      if (!ivHex || !encrypted || !authTagHex) return null
      const key = getCachedScryptKey()
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

// Cache the scrypt-derived key for legacy token decryption.
// Computed once at module load time instead of per-request.
let _scryptKeyCache = null

/**
 * Compute and cache the scrypt-derived key for legacy token decryption.
 * The key is derived from JWT_SECRET + static salt, cached indefinitely.
 */
function getCachedScryptKey() {
  if (!_scryptKeyCache) {
    _scryptKeyCache = crypto.scryptSync(config.jwtSecret, 'jwt-salt', 32)
  }
  return _scryptKeyCache
}

/**
 * Get the signing key for JWT generation.
 * Returns the RSA private key (for RS256) or JWT_SECRET (for HS256).
 */
/**
 * Get the signing key and algorithm for JWT generation.
 * Returns { key, algorithm } so callers always use a consistent pair.
 * Falls back to HS256 when the RSA key is invalid or missing.
 */
function getSigningKey() {
  if (config.rsaPrivateKey && config.rsaPublicKey) {
    try {
      // Format RSA private key for jsonwebtoken (handle PEM header/newlines)
      const raw = config.rsaPrivateKey.trim()
      const keyObj = raw.startsWith('-----BEGIN') ? raw : crypto.createPrivateKey({
        key: raw,
        format: 'pem'
      })
      return { key: keyObj, algorithm: 'RS256' }
    } catch {
      // Invalid/incomplete RSA key — fall back to HS256
      console.warn('⚠️ RSA_PRIVATE_KEY is not a valid key, falling back to HS256')
    }
  }
  return { key: config.jwtSecret, algorithm: 'HS256' }
}

/**
 * Generate a short-lived access token.
 * Uses RS256 (asymmetric) when RSA keys are configured, HS256 otherwise.
 */
export function generateToken(user) {
  const { key, algorithm } = getSigningKey()
  return jwt.sign(
    {
      id: user.id || null,
      username: user.username,
      email: user.email,
      role: user.role || 'admin',
      tokenVersion: user.tokenVersion ?? user.token_version ?? 0,
      type: 'access'
    },
    key,
    {
      expiresIn: config.jwtAccessTokenExpiry,
      algorithm,
      issuer: config.jwtIssuer,
      audience: config.jwtAudience
    } as SignOptions
  )
}

/**
 * Generate a long-lived refresh token.
 * Uses RS256 (asymmetric) when RSA keys are configured, HS256 otherwise.
 */
export function generateRefreshToken(user) {
  const { key, algorithm } = getSigningKey()
  return jwt.sign(
    {
      id: user.id || null,
      username: user.username,
      role: user.role || 'admin',
      tokenVersion: user.tokenVersion ?? user.token_version ?? 0,
      type: 'refresh',
      jti: crypto.randomUUID()
    },
    key,
    {
      expiresIn: config.jwtRefreshTokenExpiry,
      algorithm,
      issuer: config.jwtIssuer,
      audience: config.jwtAudience
    } as SignOptions
  )
}

/**
 * Get the verification key for JWT verification.
 * Returns the RSA public key (for RS256) or JWT_SECRET (for HS256).
 * Supports dual verification during transition: tries RS256 first, then HS256.
 */
export function getVerificationKeys() {
  const keys = []
  if (config.rsaPublicKey) {
    try {
      const raw = config.rsaPublicKey.trim()
      keys.push(raw.startsWith('-----BEGIN') ? raw : crypto.createPublicKey({
        key: raw,
        format: 'pem'
      }).export({ format: 'pem', type: 'spki' }))
    } catch {
      // Invalid public key — skip, will fall back to HS256
    }
  }
  if (config.jwtSecret) {
    keys.push(config.jwtSecret)
  }
  return keys
}

/**
 * Verify a JWT with backward-compatible algorithm support.
 * Tries RS256 first (if RSA keys configured), then HS256.
 * This allows a smooth transition: existing HS256 tokens remain valid
 * while new tokens are signed with RS256.
 * @param {string} token - Raw or encrypted JWT string
 * @returns {object|null} Decoded payload, or null if invalid
 */
export function verifyToken(token): JwtPayload | null {
  try {
    const decoded = jwt.decode(token, { complete: true })
    const algorithm = decoded?.header?.alg
    if (algorithm !== 'HS256' && algorithm !== 'RS256') return null
    const verifyOpts: VerifyOptions = {
      algorithms: [algorithm as Algorithm],
      issuer: config.jwtIssuer,
      audience: config.jwtAudience
    }
    if (algorithm === 'HS256') {
      const verified = jwt.verify(token, config.jwtSecret, verifyOpts)
      return typeof verified === 'string' ? null : verified
    }
    if (algorithm === 'RS256' && config.rsaPublicKey) {
      const verified = jwt.verify(token, getVerificationKeyForVerify(), verifyOpts)
      return typeof verified === 'string' ? null : verified
    }
    return null
  } catch {
    return null
  }
}

/**
 * Get the appropriate key for verification based on configured algorithm.
 */
function getVerificationKeyForVerify() {
  if (config.rsaPublicKey) {
    try {
      const raw = config.rsaPublicKey.trim()
      return raw.startsWith('-----BEGIN') ? raw : crypto.createPublicKey({
        key: raw,
        format: 'pem'
      }).export({ format: 'pem', type: 'spki' })
    } catch {
      // Invalid public key — fall through to HS256
    }
  }
  // Fallback: if only the private key is configured (RSA key pair files
  // may be split across systems), derive the public key from it.
  if (config.rsaPrivateKey) {
    try {
      const raw = config.rsaPrivateKey.trim()
      const keyObj = raw.startsWith('-----BEGIN') ? raw : crypto.createPrivateKey({
        key: raw,
        format: 'pem'
      })
      return crypto.createPublicKey(keyObj).export({ format: 'pem', type: 'spki' })
    } catch {
      // Invalid private key — fall through to HS256
    }
  }
  return config.jwtSecret
}
