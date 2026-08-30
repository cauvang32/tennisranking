import pg from 'pg'
import config from '../../config/env.js'
import { readFileSync } from 'fs'
import { normalize, resolve } from 'path'

const { Pool } = pg

// Build SSL configuration synchronously (required for constructor)
function buildSSLConfig() {
  if (process.env.DB_SSL !== 'true') {
    return false
  }

  const rejectUnauthorized = config.isProduction
    ? true
    : process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false'
  const sslConfig: { rejectUnauthorized: boolean; ca?: string } = { rejectUnauthorized }

  // Support custom CA certificate for self-signed certs
  if (process.env.DB_SSL_CA) {
    try {
      // Path traversal protection: check raw env value for '..' BEFORE normalize()
      const rawCaPath = process.env.DB_SSL_CA
      if (rawCaPath.includes('..')) {
        console.warn('⚠️ Invalid DB_SSL_CA path: path traversal detected, skipping CA cert')
      } else {
        const certPath = normalize(rawCaPath)
        const resolvedPath = resolve(certPath)
        sslConfig.ca = readFileSync(resolvedPath, 'utf8')
      }
    } catch (err) {
      console.warn('⚠️ Could not load DB_SSL_CA certificate:', err.message)
    }
  }

  // Security warning for disabled certificate validation
  if (!rejectUnauthorized) {
    console.warn('⚠️ WARNING: DB SSL certificate validation is DISABLED. Only use for local development!')
  }

  return sslConfig
}


class DatabaseCore {
  [key: string]: any

  constructor() {
    this.config = {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: buildSSLConfig(),
      max: config.dbPoolMax,
      idleTimeoutMillis: config.dbIdleTimeoutMs,
      connectionTimeoutMillis: config.dbConnectionTimeoutMs,
      statement_timeout: config.dbStatementTimeoutMs,
      query_timeout: config.dbStatementTimeoutMs + 1000,
    }
    this.pool = null
    this.isConnected = false
    this.initPromise = null
    this.reconnectTimer = null
    this.retryAttempt = 0
    this.maxReconnectDelayMs = 60000
    
    // Validate required database configuration
    if (!this.config.database) {
      console.error('❌ DB_NAME environment variable is required')
      process.exit(1)
    }
    
    if (!this.config.user) {
      console.error('❌ DB_USER environment variable is required')
      process.exit(1)
    }
    
    if (!this.config.password) {
      console.error('❌ DB_PASSWORD environment variable is required')
      process.exit(1)
    }
  }


  async init() {
    if (this.initPromise) {
      return this.initPromise
    }

    this.initPromise = this._initOnce()

    try {
      return await this.initPromise
    } finally {
      this.initPromise = null
    }
  }


  async _initOnce() {
    try {
      if (!this.pool) {
        // Create connection pool once and reuse it for retries
        this.pool = new Pool(this.config)
        this.pool.on('error', (error) => {
          this.isConnected = false
          console.error('❌ PostgreSQL pool error:', error.message)
          this.scheduleReconnect()
        })
      }

      // Test connection
      const client = await this.pool.connect()
      console.log('✅ PostgreSQL connection established successfully')
      client.release()

      // Preserve self-bootstrapping for the existing PM2/Compose deployment.
      // K3s application pods disable this and rely on the release migration Job
      // so multiple replicas never perform DDL during a rollout.
      if (config.dbAutoSchema) {
        await this.createTables()
      }
      
      this.isConnected = true
      this.retryAttempt = 0
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }

      console.log('✅ PostgreSQL database initialized successfully')
      return true
    } catch (error) {
      this.isConnected = false
      console.error('❌ PostgreSQL connection failed:', error.message)
      this.scheduleReconnect()
      return false
    }
  }

  /**
   * Publish the single cache-invalidation notification for a bulk operation
   * (restore, clear-all-data). Bulk transactions set the tennis.cache_bulk_tx GUC so
   * the per-row triggers stay silent; this one call after commit is what bumps
   * the data version exactly once for the whole bulk transaction.
   */

  async notifyBulkTx() {
    await this.query('SELECT notify_cache_invalidation_tx()')
  }


  scheduleReconnect() {
    if (this.reconnectTimer) {
      return
    }

    const baseDelayMs = Math.min(5000 * (2 ** this.retryAttempt), this.maxReconnectDelayMs)
    const delayMs = Math.round(baseDelayMs * (0.8 + Math.random() * 0.4))
    this.retryAttempt += 1

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      try {
        await this.init()
      } catch (error) {
        console.error('❌ PostgreSQL reconnect attempt failed:', error.message)
      }
    }, delayMs)

    this.reconnectTimer.unref?.()
    console.warn(`⚠️ PostgreSQL unavailable, retrying connection in ${Math.round(delayMs / 1000)}s`)
  }


  async query(text, params = []) {
    const startedAt = performance.now()
    try {
      return await this.pool.query(text, params)
    } finally {
      const durationMs = performance.now() - startedAt
      if (durationMs >= config.dbSlowQueryMs) {
        const operation = String(text).trim().split(/\s+/, 1)[0]?.toUpperCase() || 'QUERY'
        console.warn(`⚠️ Slow database ${operation}: ${Math.round(durationMs)}ms`)
      }
    }
  }


  async close() {
    if (this.pool) {
      await this.pool.end()
    }
  }


}

export { DatabaseCore }
