import pg from 'pg'
import { normalize, resolve } from 'path'
import { readFileSync } from 'fs'
import config from './config/env.js'

const { Pool } = pg

// Build SSL configuration synchronously (required for constructor)
function buildSSLConfig() {
  if (process.env.DB_SSL !== 'true') {
    return false
  }

  const rejectUnauthorized = config.isProduction
    ? true
    : process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false'
  const sslConfig = { rejectUnauthorized }

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

// ── Shared query fragments (DRY) ────────────────────────────────────────────
const SEASON_SELECT_COLS = `
  id, name,
  TO_CHAR(start_date, 'YYYY-MM-DD') as start_date,
  CASE WHEN end_date IS NOT NULL THEN TO_CHAR(end_date, 'YYYY-MM-DD') ELSE NULL END as end_date,
  is_active, auto_end, description,
  COALESCE(lose_money_per_loss, 20000) as lose_money_per_loss,
  final_results,
  conclusion_image_path,
  conclusion_image_filename,
  conclusion_image_content_type,
  conclusion_image_size,
  created_at, ended_at, ended_by`

class TennisDatabasePostgreSQL {
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

  async createTables() {
    const client = await this.pool.connect()
    
    try {
      await client.query('BEGIN')
      // Serialize schema bootstrap across PM2 workers. Long-term schema changes
      // live in migrations; this lock protects legacy idempotent bootstrap DDL.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('tennis-schema-bootstrap'))`)

      // Players table
      await client.query(`
        CREATE TABLE IF NOT EXISTS players (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) UNIQUE NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)

      // Seasons table - supports multiple concurrent active seasons
      // lose_money_per_loss: configurable penalty amount per loss (default 20000 VND)
      await client.query(`
        CREATE TABLE IF NOT EXISTS seasons (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          start_date DATE NOT NULL,
          end_date DATE,
          is_active BOOLEAN DEFAULT true,
          auto_end BOOLEAN DEFAULT true,
          description TEXT,
          lose_money_per_loss INTEGER DEFAULT 20000,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          ended_at TIMESTAMP,
          ended_by VARCHAR(255)
        )
      `)

      // Season players junction table - controls which players can participate in each season
      await client.query(`
        CREATE TABLE IF NOT EXISTS season_players (
          id SERIAL PRIMARY KEY,
          season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
          player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          added_by VARCHAR(255),
          UNIQUE(season_id, player_id)
        )
      `)

      // Matches table
      // match_type: 'duo' (đánh đôi, 4 players) or 'solo' (đánh đơn, 2 players)
      await client.query(`
        CREATE TABLE IF NOT EXISTS matches (
          id SERIAL PRIMARY KEY,
          season_id INTEGER NOT NULL REFERENCES seasons(id),
          play_date DATE NOT NULL,
          player1_id INTEGER NOT NULL REFERENCES players(id),
          player2_id INTEGER REFERENCES players(id),
          player3_id INTEGER REFERENCES players(id),
          player4_id INTEGER REFERENCES players(id),
          team1_score INTEGER NOT NULL,
          team2_score INTEGER NOT NULL,
          winning_team INTEGER NOT NULL,
          match_type VARCHAR(10) DEFAULT 'duo',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT check_match_type CHECK (match_type IN ('solo', 'duo')),
          CONSTRAINT check_match_players CHECK (
            (match_type = 'duo' AND player2_id IS NOT NULL AND player4_id IS NOT NULL) OR
            (match_type = 'solo' AND player2_id IS NULL AND player4_id IS NULL)
          )
        )
      `)

      // Additional indexes for player lookups (form queries)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_matches_player1_id ON matches(player1_id);
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_matches_player2_id ON matches(player2_id);
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_matches_player3_id ON matches(player3_id);
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_matches_player4_id ON matches(player4_id);
      `)

      // Composite index for season+date queries
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_matches_season_date ON matches(season_id, play_date DESC);
      `)

      // Composite index for form lookup (covering index)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_matches_form_lookup
        ON matches(play_date DESC, created_at DESC)
        INCLUDE (player1_id, player2_id, player3_id, player4_id, winning_team);
      `)

      // Users must exist before devices declares its foreign key on a fresh DB.
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(100) UNIQUE NOT NULL,
          email VARCHAR(255),
          password_hash TEXT NOT NULL,
          role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
          display_name VARCHAR(255),
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_login TIMESTAMPTZ,
          token_version INTEGER NOT NULL DEFAULT 0,
          created_by VARCHAR(100),
          notes TEXT
        )
      `)

      // FCM device registry — self-bootstrapped so a fresh DB doesn't need the
      // separate migrations/add-devices-table.sh to be run first.
      await client.query(`
        CREATE TABLE IF NOT EXISTS devices (
          id          BIGSERIAL PRIMARY KEY,
          user_id     BIGINT NULL REFERENCES users(id) ON DELETE CASCADE,
          token       TEXT NOT NULL UNIQUE,
          platform    VARCHAR(8) NOT NULL CHECK (platform IN ('android', 'ios')),
          app_version VARCHAR(32) NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_devices_updated_at ON devices(updated_at);
      `)
      // Idempotent column add — captured registration IP, used for the
      // per-IP cap on guest devices (FCM bloat prevention).
      await client.query(`
        ALTER TABLE devices ADD COLUMN IF NOT EXISTS registered_ip VARCHAR(45) NULL;
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_devices_registered_ip ON devices(registered_ip);
      `)

      // ── Users table (account system) ────────────────────────────────────────
      // Created here so the app bootstraps without manual migration runs.
      // Existing accounts-migration DDL was already covered, but self-bootstrapping
      // ensures fresh Docker/PM2 deploys work immediately.
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(100) UNIQUE NOT NULL,
          email VARCHAR(255),
          password_hash TEXT NOT NULL,
          role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
          display_name VARCHAR(255),
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_login TIMESTAMPTZ,
          token_version INTEGER NOT NULL DEFAULT 0,
          created_by VARCHAR(100),
          notes TEXT
        )
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_users_is_active ON users(is_active)
      `)
      await client.query(`
        CREATE TABLE IF NOT EXISTS refresh_sessions (
          id BIGSERIAL PRIMARY KEY,
          token_hash CHAR(64) UNIQUE NOT NULL,
          user_id INTEGER NULL REFERENCES users(id) ON DELETE CASCADE,
          username VARCHAR(100) NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          rotated_at TIMESTAMPTZ,
          revoked_at TIMESTAMPTZ,
          replaced_by_hash CHAR(64)
        )
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_refresh_sessions_active
        ON refresh_sessions(token_hash, expires_at) WHERE revoked_at IS NULL
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_refresh_sessions_expires_at
        ON refresh_sessions(expires_at)
      `)

      // Notification preferences on users table (idempotent)
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'users' AND column_name = 'receive_match_notifications') THEN
            ALTER TABLE users ADD COLUMN receive_match_notifications BOOLEAN NOT NULL DEFAULT true;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'users' AND column_name = 'receive_season_notifications') THEN
            ALTER TABLE users ADD COLUMN receive_season_notifications BOOLEAN NOT NULL DEFAULT true;
          END IF;
        END $$;
      `)

      // ── Site images table (self-service image editor) ──────────────────────
      await client.query(`
        CREATE TABLE IF NOT EXISTS site_images (
          id            SERIAL PRIMARY KEY,
          key           VARCHAR(64) UNIQUE NOT NULL,
          filename      VARCHAR(255) NOT NULL,
          storage_path  VARCHAR(512) NOT NULL,
          content_type  VARCHAR(64) NOT NULL,
          file_size     INTEGER NOT NULL,
          alt_text      VARCHAR(255) DEFAULT '',
          is_active     BOOLEAN DEFAULT true,
          uploaded_by   VARCHAR(255),
          uploaded_at   TIMESTAMPTZ DEFAULT NOW(),
          updated_at    TIMESTAMPTZ DEFAULT NOW()
        )
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_site_images_key_active ON site_images(key, is_active)
      `)

      // ── Season result columns (idempotent) ─────────────────────────────────
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'seasons' AND column_name = 'final_results') THEN
            ALTER TABLE seasons ADD COLUMN final_results TEXT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'seasons' AND column_name = 'conclusion_image_path') THEN
            ALTER TABLE seasons ADD COLUMN conclusion_image_path VARCHAR(512);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'seasons' AND column_name = 'conclusion_image_filename') THEN
            ALTER TABLE seasons ADD COLUMN conclusion_image_filename VARCHAR(255);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'seasons' AND column_name = 'conclusion_image_content_type') THEN
            ALTER TABLE seasons ADD COLUMN conclusion_image_content_type VARCHAR(64);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'seasons' AND column_name = 'conclusion_image_size') THEN
            ALTER TABLE seasons ADD COLUMN conclusion_image_size INTEGER;
          END IF;
        END $$;
      `)

      // ── Cup tournament tables ───────────────────────────────────────────────
      await client.query(`
        CREATE TABLE IF NOT EXISTS cups (
          id                SERIAL PRIMARY KEY,
          name              VARCHAR(255) NOT NULL,
          season_id         INTEGER REFERENCES seasons(id) ON DELETE SET NULL,
          format            VARCHAR(20) NOT NULL DEFAULT 'single_elimination',
          num_teams         INTEGER NOT NULL DEFAULT 8,
          regulation_text   TEXT,
          status            VARCHAR(20) DEFAULT 'draft',
          start_date        DATE,
          end_date          DATE,
          created_by        VARCHAR(255),
          created_at        TIMESTAMPTZ DEFAULT NOW(),
          updated_at        TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT check_cup_format CHECK (format IN ('single_elimination', 'double_elimination', 'round_robin')),
          CONSTRAINT check_cup_status CHECK (status IN ('draft', 'scheduled', 'in_progress', 'completed', 'cancelled'))
        )
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_cups_season ON cups(season_id)
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_cups_status ON cups(status)
      `)

      // Cup participants
      await client.query(`
        CREATE TABLE IF NOT EXISTS cup_participants (
          id          SERIAL PRIMARY KEY,
          cup_id      INTEGER NOT NULL REFERENCES cups(id) ON DELETE CASCADE,
          player1_id  INTEGER NOT NULL REFERENCES players(id),
          player2_id  INTEGER REFERENCES players(id),
          team_name   VARCHAR(255),
          seed        INTEGER,
          UNIQUE(cup_id, player1_id, player2_id)
        )
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_cup_participants_cup ON cup_participants(cup_id)
      `)

      // Cup matches (bracket)
      await client.query(`
        CREATE TABLE IF NOT EXISTS cup_matches (
          id                   SERIAL PRIMARY KEY,
          cup_id               INTEGER NOT NULL REFERENCES cups(id) ON DELETE CASCADE,
          round_number         INTEGER NOT NULL,
          match_number         INTEGER NOT NULL,
          bracket_position     VARCHAR(32),
          team1_participant_id INTEGER REFERENCES cup_participants(id),
          team2_participant_id INTEGER REFERENCES cup_participants(id),
          team1_score          INTEGER,
          team2_score          INTEGER,
          winner_participant_id INTEGER REFERENCES cup_participants(id),
          play_date            DATE,
          status               VARCHAR(20) DEFAULT 'scheduled',
          goal_difference      INTEGER GENERATED ALWAYS AS (COALESCE(team1_score, 0) - COALESCE(team2_score, 0)) STORED,
          created_at           TIMESTAMPTZ DEFAULT NOW(),
          updated_at           TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT check_cup_match_status CHECK (status IN ('scheduled', 'in_progress', 'completed', 'forfeited', 'cancelled', 'locked'))
        )
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_cup_matches_cup ON cup_matches(cup_id)
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_cup_matches_round ON cup_matches(cup_id, round_number, match_number)
      `)

      // Cup advancements (auto-advance winners)
      await client.query(`
        CREATE TABLE IF NOT EXISTS cup_advancements (
          id              SERIAL PRIMARY KEY,
          from_match_id   INTEGER NOT NULL REFERENCES cup_matches(id) ON DELETE CASCADE,
          to_match_id     INTEGER NOT NULL REFERENCES cup_matches(id) ON DELETE CASCADE,
          winner_slot     VARCHAR(10) NOT NULL,
          UNIQUE(from_match_id, to_match_id, winner_slot)
        )
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_cup_advancements_from ON cup_advancements(from_match_id)
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_cup_advancements_to ON cup_advancements(to_match_id)
      `)

      // ── Cup result/image columns (idempotent, auto-create if missing) ──────
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'cups' AND column_name = 'final_results') THEN
            ALTER TABLE cups ADD COLUMN final_results TEXT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'cups' AND column_name = 'conclusion_image_path') THEN
            ALTER TABLE cups ADD COLUMN conclusion_image_path VARCHAR(512);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'cups' AND column_name = 'conclusion_image_filename') THEN
            ALTER TABLE cups ADD COLUMN conclusion_image_filename VARCHAR(255);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'cups' AND column_name = 'conclusion_image_content_type') THEN
            ALTER TABLE cups ADD COLUMN conclusion_image_content_type VARCHAR(64);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'cups' AND column_name = 'conclusion_image_size') THEN
            ALTER TABLE cups ADD COLUMN conclusion_image_size INTEGER;
          END IF;
        END $$;
      `)

      // ── Cup performance indexes ─────────────────────────────────────────────
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_cups_created_at ON cups(created_at DESC)
      `)

      // ── General performance indexes (matches, players, seasons) ─────────────
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_matches_play_date ON matches(play_date DESC)
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_matches_winning_team ON matches(winning_team)
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_matches_created_at ON matches(created_at DESC)
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_seasons_active_start_date ON seasons(is_active DESC, start_date DESC)
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_season_players_composite ON season_players(season_id, player_id)
      `)

      // Repair the historical constraint only when it lacks the locked state;
      // avoid taking an unnecessary table lock on every application startup.
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'cup_matches'::regclass
              AND conname = 'check_cup_match_status'
              AND pg_get_constraintdef(oid) LIKE '%locked%'
          ) THEN
            ALTER TABLE cup_matches DROP CONSTRAINT IF EXISTS check_cup_match_status;
            ALTER TABLE cup_matches ADD CONSTRAINT check_cup_match_status
              CHECK (status IN ('scheduled', 'in_progress', 'completed', 'forfeited', 'cancelled', 'locked'));
          END IF;
        END $$;
      `)

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async createDefaultSeason() {
    const existingSeasons = await this.query('SELECT COUNT(*) as count FROM seasons')
    if (existingSeasons.rows[0].count == 0) { // eslint-disable-line eqeqeq -- null check
      const currentDate = new Date().toISOString().split('T')[0]
      await this.query(`
        INSERT INTO seasons (name, start_date, is_active) 
        VALUES ($1, $2, $3)
      `, ['Mùa giải đầu tiên', currentDate, true])
    }
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

  // Players CRUD operations
  async getPlayers(limit) {
    // eslint-disable-next-line eqeqeq -- intentional null check for both null and undefined
    const sql = limit != null
      ? 'SELECT id, name, created_at FROM players ORDER BY name LIMIT $1'
      : 'SELECT id, name, created_at FROM players ORDER BY name'
    // eslint-disable-next-line eqeqeq -- intentional null check for both null and undefined
    const result = await this.query(sql, limit != null ? [limit] : [])
    return result.rows
  }

  async addPlayer(name) {
    const result = await this.query('INSERT INTO players (name) VALUES ($1) RETURNING id', [name])
    return result.rows[0].id
  }

  async removePlayer(playerId) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      // Remove from cup participants (both as primary and secondary player)
      await client.query(`
        DELETE FROM cup_participants
        WHERE player1_id = $1 OR player2_id = $1
      `, [playerId])

      // First remove all matches involving this player
      await client.query(`
        DELETE FROM matches
        WHERE player1_id = $1 OR player2_id = $1 OR player3_id = $1 OR player4_id = $1
      `, [playerId])

      // Then remove the player
      await client.query('DELETE FROM players WHERE id = $1', [playerId])

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  // Seasons CRUD operations
  async getSeasons(limit) {
    // eslint-disable-next-line eqeqeq -- intentional null check for both null and undefined
    const sql = limit != null
      ? `SELECT ${SEASON_SELECT_COLS} FROM seasons ORDER BY is_active DESC, start_date DESC LIMIT $1`
      : `SELECT ${SEASON_SELECT_COLS} FROM seasons ORDER BY is_active DESC, start_date DESC`
    // eslint-disable-next-line eqeqeq -- intentional null check for both null and undefined
    const result = await this.query(sql, limit != null ? [limit] : [])
    return result.rows
  }

  async getActiveSeasons() {
    const result = await this.query(`SELECT ${SEASON_SELECT_COLS} FROM seasons WHERE is_active = true ORDER BY start_date DESC LIMIT 50`)
    return result.rows
  }

  async getActiveSeason() {
    const result = await this.query(`SELECT ${SEASON_SELECT_COLS} FROM seasons WHERE is_active = true ORDER BY start_date DESC LIMIT 1`)
    return result.rows[0] || null
  }

  async createSeason(name, startDate, endDate = null, autoEnd = true, description = '', loseMoneyPerLoss = 20000, playerIds = []) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      
      const result = await client.query(`
        INSERT INTO seasons (name, start_date, end_date, is_active, auto_end, description, lose_money_per_loss) 
        VALUES ($1, $2, $3, true, $4, $5, $6) RETURNING id
      `, [name, startDate, endDate, autoEnd, description, loseMoneyPerLoss])
      
      const seasonId = result.rows[0].id
      
      // Add players to the season (batch insert for performance)
      if (playerIds && playerIds.length > 0) {
        const values = playerIds.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`)
        const params = []
        for (const playerId of playerIds) {
          params.push(seasonId, playerId, 'creator')
        }
        await client.query(`
          INSERT INTO season_players (season_id, player_id, added_by)
          VALUES ${values}
          ON CONFLICT (season_id, player_id) DO NOTHING
        `, params)
      }
      
      await client.query('COMMIT')
      return seasonId
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async updateSeason(seasonId, name, startDate, endDate, autoEnd, description, loseMoneyPerLoss = null, finalResults = null) {
    await this.query(`
      UPDATE seasons
      SET name = $1, start_date = $2, end_date = $3, auto_end = $4, description = $5,
          lose_money_per_loss = COALESCE($6, lose_money_per_loss),
          final_results = COALESCE($7, final_results)
      WHERE id = $8
    `, [name, startDate, endDate, autoEnd, description, loseMoneyPerLoss, finalResults, seasonId])
  }

  async endSeason(seasonId, endDate, endedBy) {
    await this.query(`
      UPDATE seasons 
      SET end_date = $1, is_active = false, ended_at = CURRENT_TIMESTAMP, ended_by = $2
      WHERE id = $3
    `, [endDate, endedBy, seasonId])
  }

  async reactivateSeason(seasonId) {
    await this.query(`
      UPDATE seasons 
      SET is_active = true, ended_at = NULL, ended_by = NULL
      WHERE id = $1
    `, [seasonId])
  }

  async checkAndEndExpiredSeasons() {
    // Automatically end seasons that have passed their end date and have auto_end enabled
    const result = await this.query(`
      UPDATE seasons 
      SET is_active = false, ended_at = CURRENT_TIMESTAMP, ended_by = 'system'
      WHERE is_active = true 
        AND auto_end = true 
        AND end_date IS NOT NULL 
        AND end_date < CURRENT_DATE
      RETURNING id, name
    `)
    return result.rows
  }

  async getSeasonById(seasonId) {
    const result = await this.query(`SELECT ${SEASON_SELECT_COLS} FROM seasons WHERE id = $1`, [seasonId])
    return result.rows[0] || null
  }

  // Season Players Management
  async getSeasonPlayers(seasonId) {
    const result = await this.query(`
      SELECT p.id, p.name, sp.added_at, sp.added_by
      FROM season_players sp
      JOIN players p ON sp.player_id = p.id
      WHERE sp.season_id = $1
      ORDER BY p.name
    `, [seasonId])
    return result.rows
  }

  /**
   * Get ALL season-player mappings in one query (eliminates N+1 in backup).
   * Returns a Map: seasonId -> [playerId, ...]
   */
  async getAllSeasonPlayers() {
    const result = await this.query('SELECT season_id, player_id FROM season_players')
    const map = new Map()
    for (const row of result.rows) {
      const sid = row.season_id
      if (!map.has(sid)) map.set(sid, [])
      map.get(sid).push(row.player_id)
    }
    return map
  }

  async addPlayerToSeason(seasonId, playerId, addedBy = 'admin') {
    const result = await this.query(`
      INSERT INTO season_players (season_id, player_id, added_by)
      VALUES ($1, $2, $3)
      ON CONFLICT (season_id, player_id) DO NOTHING
      RETURNING id
    `, [seasonId, playerId, addedBy])
    return result.rows[0]?.id || null
  }

  async removePlayerFromSeason(seasonId, playerId) {
    await this.query(`
      DELETE FROM season_players
      WHERE season_id = $1 AND player_id = $2
    `, [seasonId, playerId])
  }

  async setSeasonPlayers(seasonId, playerIds, addedBy = 'admin') {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      
      // Remove all existing players
      await client.query('DELETE FROM season_players WHERE season_id = $1', [seasonId])
      
      // Add new players (batch insert for performance)
      if (playerIds.length > 0) {
        const values = playerIds.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`)
        const params = []
        for (const playerId of playerIds) {
          params.push(seasonId, playerId, addedBy)
        }
        await client.query(`
          INSERT INTO season_players (season_id, player_id, added_by)
          VALUES ${values}
        `, params)
      }
      
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async isPlayerInSeason(seasonId, playerId) {
    const result = await this.query(`
      SELECT COUNT(*) as count FROM season_players
      WHERE season_id = $1 AND player_id = $2
    `, [seasonId, playerId])
    return parseInt(result.rows[0].count) > 0
  }

  async deleteSeason(seasonId) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      
      // First delete all matches in this season
      await client.query('DELETE FROM matches WHERE season_id = $1', [seasonId])
      
      // Delete season players (cascade should handle this, but explicit is clearer)
      await client.query('DELETE FROM season_players WHERE season_id = $1', [seasonId])
      
      // Then delete the season
      await client.query('DELETE FROM seasons WHERE id = $1', [seasonId])
      
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  // Matches CRUD operations
  // match_type: 'duo' (4 players) or 'solo' (2 players - player1 vs player3)
  async addMatch(seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam, matchType = 'duo', client = null) {
    const queryClient = client || this.pool
    const result = await queryClient.query(`
      INSERT INTO matches (season_id, play_date, player1_id, player2_id, player3_id, player4_id, team1_score, team2_score, winning_team, match_type) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id
    `, [seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam, matchType])
    return result.rows[0].id
  }

  // Add match with preserved created_at (for restore operations)
  async addMatchWithTimestamp(seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam, matchType = 'duo', createdAt = null) {
    if (createdAt) {
      const result = await this.query(`
        INSERT INTO matches (season_id, play_date, player1_id, player2_id, player3_id, player4_id, team1_score, team2_score, winning_team, match_type, created_at) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id
      `, [seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam, matchType, createdAt])
      return result.rows[0].id
    } else {
      return this.addMatch(seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam, matchType)
    }
  }

  async getMatches(limit = null) {
    let query = `
      SELECT m.id, m.season_id, TO_CHAR(m.play_date, 'YYYY-MM-DD') as play_date,
        m.player1_id, m.player2_id, m.player3_id, m.player4_id,
        m.team1_score, m.team2_score, m.winning_team, 
        COALESCE(m.match_type, 'duo') as match_type,
        m.created_at,
        s.name as season_name,
        COALESCE(s.lose_money_per_loss, 20000) as lose_money_per_loss,
        p1.name as player1_name, COALESCE(p2.name, '') as player2_name, 
        p3.name as player3_name, COALESCE(p4.name, '') as player4_name
      FROM matches m
      JOIN seasons s ON m.season_id = s.id
      JOIN players p1 ON m.player1_id = p1.id
      LEFT JOIN players p2 ON m.player2_id = p2.id
      JOIN players p3 ON m.player3_id = p3.id
      LEFT JOIN players p4 ON m.player4_id = p4.id
      ORDER BY m.play_date DESC, m.created_at DESC
    `
    
    if (limit) {
      query += ` LIMIT $1`
      const result = await this.query(query, [limit])
      return result.rows
    } else {
      const result = await this.query(query)
      return result.rows
    }
  }

  /**
   * Get matches with cursor-based pagination using keyset indexing.
   * Uses (play_date, created_at, id) tuple comparison for correct ordering.
   * The cursor is a base64-encoded JSON: { playDate, createdAt, id }.
   * Used for infinite scrolling through match history.
   */
  async getMatchesAfterCursor(cursor, limit) {
    // Decode cursor: base64(JSON.stringify({ playDate, createdAt, id }))
    // Validate cursor format — reject malformed input with a clear error
    let cursorObj
    try {
      cursorObj = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'))
    } catch (decodeError) {
      throw new Error(`Invalid cursor format: ${decodeError.message}`)
    }
    const { playDate, createdAt, id } = cursorObj
    if (!playDate || !createdAt || !id) {
      throw new Error('Invalid cursor: missing required fields (playDate, createdAt, id)')
    }
    const query = `
      SELECT m.id, m.season_id, TO_CHAR(m.play_date, 'YYYY-MM-DD') as play_date,
        m.player1_id, m.player2_id, m.player3_id, m.player4_id,
        m.team1_score, m.team2_score, m.winning_team,
        COALESCE(m.match_type, 'duo') as match_type,
        m.created_at,
        s.name as season_name,
        COALESCE(s.lose_money_per_loss, 20000) as lose_money_per_loss,
        p1.name as player1_name, COALESCE(p2.name, '') as player2_name,
        p3.name as player3_name, COALESCE(p4.name, '') as player4_name
      FROM matches m
      JOIN seasons s ON m.season_id = s.id
      JOIN players p1 ON m.player1_id = p1.id
      LEFT JOIN players p2 ON m.player2_id = p2.id
      JOIN players p3 ON m.player3_id = p3.id
      LEFT JOIN players p4 ON m.player4_id = p4.id
      WHERE (m.play_date, m.created_at, m.id) < ($1, $2, $3)
      ORDER BY m.play_date DESC, m.created_at DESC, m.id DESC
      LIMIT $4
    `
    const result = await this.query(query, [playDate, createdAt, id, limit])
    return result.rows
  }

  async getMatchesByPlayDate(playDate) {
    const result = await this.query(`
      SELECT m.id, m.season_id, TO_CHAR(m.play_date, 'YYYY-MM-DD') as play_date,
        m.player1_id, m.player2_id, m.player3_id, m.player4_id,
        m.team1_score, m.team2_score, m.winning_team,
        COALESCE(m.match_type, 'duo') as match_type,
        m.created_at,
        s.name as season_name,
        COALESCE(s.lose_money_per_loss, 20000) as lose_money_per_loss,
        p1.name as player1_name, COALESCE(p2.name, '') as player2_name, 
        p3.name as player3_name, COALESCE(p4.name, '') as player4_name
      FROM matches m
      JOIN seasons s ON m.season_id = s.id
      JOIN players p1 ON m.player1_id = p1.id
      LEFT JOIN players p2 ON m.player2_id = p2.id
      JOIN players p3 ON m.player3_id = p3.id
      LEFT JOIN players p4 ON m.player4_id = p4.id
      WHERE m.play_date = $1
      ORDER BY m.created_at DESC
    `, [playDate])
    return result.rows
  }

  async getMatchesBySeason(seasonId) {
    const result = await this.query(`
      SELECT m.id, m.season_id, TO_CHAR(m.play_date, 'YYYY-MM-DD') as play_date,
        m.player1_id, m.player2_id, m.player3_id, m.player4_id,
        m.team1_score, m.team2_score, m.winning_team, 
        COALESCE(m.match_type, 'duo') as match_type,
        m.created_at,
        s.name as season_name,
        COALESCE(s.lose_money_per_loss, 20000) as lose_money_per_loss,
        p1.name as player1_name, COALESCE(p2.name, '') as player2_name, 
        p3.name as player3_name, COALESCE(p4.name, '') as player4_name
      FROM matches m
      JOIN seasons s ON m.season_id = s.id
      JOIN players p1 ON m.player1_id = p1.id
      LEFT JOIN players p2 ON m.player2_id = p2.id
      JOIN players p3 ON m.player3_id = p3.id
      LEFT JOIN players p4 ON m.player4_id = p4.id
      WHERE m.season_id = $1
      ORDER BY m.play_date DESC, m.created_at DESC
    `, [seasonId])
    return result.rows
  }

  async getMatchesByDate(date) {
    const result = await this.query(`
      SELECT m.id, m.season_id, TO_CHAR(m.play_date, 'YYYY-MM-DD') as play_date,
        m.player1_id, m.player2_id, m.player3_id, m.player4_id,
        m.team1_score, m.team2_score, m.winning_team,
        COALESCE(m.match_type, 'duo') as match_type,
        m.created_at,
        s.name as season_name,
        COALESCE(s.lose_money_per_loss, 20000) as lose_money_per_loss,
        p1.name as player1_name, COALESCE(p2.name, '') as player2_name,
        p3.name as player3_name, COALESCE(p4.name, '') as player4_name
      FROM matches m
      JOIN seasons s ON m.season_id = s.id
      JOIN players p1 ON m.player1_id = p1.id
      LEFT JOIN players p2 ON m.player2_id = p2.id
      JOIN players p3 ON m.player3_id = p3.id
      LEFT JOIN players p4 ON m.player4_id = p4.id
      WHERE m.play_date = $1
      ORDER BY m.created_at DESC
    `, [date])
    return result.rows
  }

  async getMatchById(matchId) {
    const result = await this.query(`
      SELECT m.id, m.season_id, TO_CHAR(m.play_date, 'YYYY-MM-DD') as play_date,
        m.player1_id, m.player2_id, m.player3_id, m.player4_id,
        m.team1_score, m.team2_score, m.winning_team, m.created_at,
        COALESCE(m.match_type, 'duo') as match_type,
        s.name as season_name,
        COALESCE(s.lose_money_per_loss, 20000) as lose_money_per_loss,
        p1.name as player1_name, COALESCE(p2.name, '') as player2_name, 
        p3.name as player3_name, COALESCE(p4.name, '') as player4_name
      FROM matches m
      JOIN seasons s ON m.season_id = s.id
      JOIN players p1 ON m.player1_id = p1.id
      LEFT JOIN players p2 ON m.player2_id = p2.id
      JOIN players p3 ON m.player3_id = p3.id
      LEFT JOIN players p4 ON m.player4_id = p4.id
      WHERE m.id = $1
    `, [matchId])
    return result.rows[0] || null
  }

  async updateMatch(matchId, seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam, matchType = 'duo') {
    await this.query(`
      UPDATE matches 
      SET season_id = $1, play_date = $2, player1_id = $3, player2_id = $4, 
          player3_id = $5, player4_id = $6, team1_score = $7, team2_score = $8, 
          winning_team = $9, match_type = $10
      WHERE id = $11
    `, [seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam, matchType, matchId])
  }

  async deleteMatch(matchId) {
    await this.query('DELETE FROM matches WHERE id = $1', [matchId])
  }

  async getPlayDates() {
    const result = await this.query(`
      SELECT DISTINCT TO_CHAR(play_date, 'YYYY-MM-DD') as play_date
      FROM matches
      ORDER BY play_date DESC
    `)
    return result.rows
  }

  async getLatestPlayDate() {
    const result = await this.query(`
      SELECT TO_CHAR(play_date, 'YYYY-MM-DD') as play_date
      FROM matches
      ORDER BY play_date DESC
      LIMIT 1
    `)
    return result.rows[0]?.play_date || null
  }

  // Statistics and rankings — reads from pre-computed summary tables
  // Summary tables are updated automatically via PostgreSQL trigger on matches
  async getPlayerStatsLifetime() {
    const result = await this.query(`
      SELECT
        p.id, p.name,
        COALESCE(pls.wins, 0)::int as wins,
        COALESCE(pls.losses, 0)::int as losses,
        COALESCE(pls.total_matches, 0)::int as total_matches,
        COALESCE(pls.money_lost, 0)::bigint as money_lost,
        COALESCE(pls.points, 0)::int as points,
        COALESCE(pls.score_difference, 0) as score_difference,
        CASE WHEN COALESCE(pls.wins, 0) + COALESCE(pls.losses, 0) > 0
             THEN ROUND((COALESCE(pls.wins, 0) * 100.0) / (COALESCE(pls.wins, 0) + COALESCE(pls.losses, 0)), 1)
             ELSE 0 END as win_percentage
      FROM players p
      LEFT JOIN player_lifetime_stats pls ON pls.player_id = p.id
      ORDER BY COALESCE(pls.points, 0) DESC,
               COALESCE(pls.score_difference, 0) DESC,
               CASE WHEN COALESCE(pls.wins, 0) + COALESCE(pls.losses, 0) > 0
                    THEN ROUND((COALESCE(pls.wins, 0) * 100.0) / (COALESCE(pls.wins, 0) + COALESCE(pls.losses, 0)), 1)
                    ELSE 0 END DESC,
               p.name ASC
    `)
    return result.rows
  }

  async getPlayerStatsBySeason(seasonId) {
    const result = await this.query(`
      SELECT
        p.id, p.name,
        COALESCE(pss.wins, 0)::int as wins,
        COALESCE(pss.losses, 0)::int as losses,
        COALESCE(pss.total_matches, 0)::int as total_matches,
        COALESCE(pss.points, 0)::int as points,
        COALESCE(pss.score_difference, 0) as score_difference,
        CASE WHEN COALESCE(pss.wins, 0) + COALESCE(pss.losses, 0) > 0
             THEN ROUND((COALESCE(pss.wins, 0) * 100.0) / (COALESCE(pss.wins, 0) + COALESCE(pss.losses, 0)), 1)
             ELSE 0 END as win_percentage,
        COALESCE(pss.money_lost, 0)::bigint as money_lost
      FROM players p
      INNER JOIN season_players sp ON sp.player_id = p.id AND sp.season_id = $1
      LEFT JOIN player_season_stats pss ON pss.player_id = p.id AND pss.season_id = $1
      ORDER BY COALESCE(pss.points, 0) DESC,
               COALESCE(pss.score_difference, 0) DESC,
               CASE WHEN COALESCE(pss.wins, 0) + COALESCE(pss.losses, 0) > 0
                    THEN ROUND((COALESCE(pss.wins, 0) * 100.0) / (COALESCE(pss.wins, 0) + COALESCE(pss.losses, 0)), 1)
                    ELSE 0 END DESC,
               p.name ASC
    `, [seasonId])
    return result.rows
  }

  async getPlayerStatsByPlayDate(playDate) {
    const result = await this.query(`
      WITH match_participants AS (
        -- Unpivot: one row per player per match (index-friendly = joins)
        -- Also carry score columns for difference calculation
        SELECT m.id as match_id, m.player1_id as player_id, 1 as team, m.winning_team, m.team1_score, m.team2_score, COALESCE(s.lose_money_per_loss, 20000) as lose_money
        FROM matches m JOIN seasons s ON m.season_id = s.id WHERE m.play_date <= $1
        UNION ALL
        SELECT m.id, m.player2_id, 1, m.winning_team, m.team1_score, m.team2_score, COALESCE(s.lose_money_per_loss, 20000)
        FROM matches m JOIN seasons s ON m.season_id = s.id WHERE m.play_date <= $1 AND m.player2_id IS NOT NULL
        UNION ALL
        SELECT m.id, m.player3_id, 2, m.winning_team, m.team1_score, m.team2_score, COALESCE(s.lose_money_per_loss, 20000)
        FROM matches m JOIN seasons s ON m.season_id = s.id WHERE m.play_date <= $1
        UNION ALL
        SELECT m.id, m.player4_id, 2, m.winning_team, m.team1_score, m.team2_score, COALESCE(s.lose_money_per_loss, 20000)
        FROM matches m JOIN seasons s ON m.season_id = s.id WHERE m.play_date <= $1 AND m.player4_id IS NOT NULL
      ),
      player_stats AS (
        SELECT
          p.id, p.name,
          COUNT(CASE WHEN mp.team = mp.winning_team THEN 1 END) as wins,
          COUNT(CASE WHEN mp.team != mp.winning_team THEN 1 END) as losses,
          COUNT(mp.match_id) as total_matches,
          COALESCE(SUM(CASE WHEN mp.team != mp.winning_team THEN mp.lose_money ELSE 0 END), 0) as money_lost,
          -- NEW: score_difference (rounds won - rounds lost)
          COALESCE(SUM(
            CASE WHEN mp.team = 1
              THEN mp.team1_score - mp.team2_score
              ELSE mp.team2_score - mp.team1_score
            END
          ), 0) as score_difference
        FROM players p
        INNER JOIN match_participants mp ON mp.player_id = p.id
        GROUP BY p.id, p.name
      )
      SELECT
        id, name, wins, losses, total_matches, money_lost, score_difference,
        (wins * 4 + losses * 1) as points,
        CASE WHEN (wins + losses) > 0 THEN ROUND((wins * 100.0) / (wins + losses), 1) ELSE 0 END as win_percentage
      FROM player_stats
      ORDER BY points DESC, score_difference DESC, win_percentage DESC, name ASC
    `, [playDate])
    return result.rows
  }

  async getPlayerStatsBySpecificDate(playDate) {
    const result = await this.query(`
      SELECT
        ds.player_id as id,
        p.name,
        ds.wins,
        ds.losses,
        ds.total_matches,
        ds.money_lost,
        ds.score_difference,
        ds.points,
        CASE WHEN (ds.wins + ds.losses) > 0
             THEN ROUND((ds.wins * 100.0) / (ds.wins + ds.losses), 1)
             ELSE 0 END as win_percentage
      FROM player_daily_stats ds
      JOIN players p ON p.id = ds.player_id
      WHERE ds.play_date = $1
      ORDER BY ds.points DESC, ds.score_difference DESC, win_percentage DESC, p.name ASC
    `, [playDate])
    return result.rows
  }

  async getPlayerForm(playerId, limit = 5) {
    const result = await this.query(`
      SELECT 
        CASE WHEN 
          (m.winning_team = 1 AND (m.player1_id = $1 OR m.player2_id = $1)) OR 
          (m.winning_team = 2 AND (m.player3_id = $1 OR m.player4_id = $1))
          THEN 'win' ELSE 'loss' 
        END as result,
        TO_CHAR(m.play_date, 'YYYY-MM-DD') as play_date
      FROM matches m
      WHERE m.player1_id = $1 OR m.player2_id = $1 OR m.player3_id = $1 OR m.player4_id = $1
      ORDER BY m.play_date DESC, m.created_at DESC
      LIMIT $2
    `, [playerId, limit])
    return result.rows
  }

  async getPlayerFormBySeason(playerId, seasonId, limit = 5) {
    const result = await this.query(`
      SELECT 
        CASE WHEN 
          (m.winning_team = 1 AND (m.player1_id = $1 OR m.player2_id = $1)) OR 
          (m.winning_team = 2 AND (m.player3_id = $1 OR m.player4_id = $1))
          THEN 'win' ELSE 'loss' 
        END as result,
        TO_CHAR(m.play_date, 'YYYY-MM-DD') as play_date
      FROM matches m
      WHERE (m.player1_id = $1 OR m.player2_id = $1 OR m.player3_id = $1 OR m.player4_id = $1)
        AND m.season_id = $2
      ORDER BY m.play_date DESC, m.created_at DESC
      LIMIT $3
    `, [playerId, seasonId, limit])
    return result.rows
  }

  async getPlayerFormByDate(playerId, date, limit = 5) {
    const result = await this.query(`
      SELECT 
        CASE WHEN 
          (m.winning_team = 1 AND (m.player1_id = $1 OR m.player2_id = $1)) OR 
          (m.winning_team = 2 AND (m.player3_id = $1 OR m.player4_id = $1))
          THEN 'win' ELSE 'loss' 
        END as result,
        TO_CHAR(m.play_date, 'YYYY-MM-DD') as play_date
      FROM matches m
      WHERE (m.player1_id = $1 OR m.player2_id = $1 OR m.player3_id = $1 OR m.player4_id = $1)
        AND m.play_date <= $2
      ORDER BY m.play_date DESC, m.created_at DESC
      LIMIT $3
    `, [playerId, date, limit])
    return result.rows
  }

  async getPlayerFormOnSpecificDate(playerId, date, limit = 5) {
    const result = await this.query(`
      SELECT 
        CASE WHEN 
          (m.winning_team = 1 AND (m.player1_id = $1 OR m.player2_id = $1)) OR 
          (m.winning_team = 2 AND (m.player3_id = $1 OR m.player4_id = $1))
          THEN 'win' ELSE 'loss' 
        END as result,
        m.play_date
      FROM matches m
      WHERE (m.player1_id = $1 OR m.player2_id = $1 OR m.player3_id = $1 OR m.player4_id = $1)
        AND m.play_date = $2
      ORDER BY m.created_at DESC
      LIMIT $3
    `, [playerId, date, limit])
    return result.rows
  }

  async getPlayerFormBySpecificDate(playerId, date, limit = 5) {
    const result = await this.query(`
      SELECT 
        CASE WHEN 
          (m.winning_team = 1 AND (m.player1_id = $1 OR m.player2_id = $1)) OR 
          (m.winning_team = 2 AND (m.player3_id = $1 OR m.player4_id = $1))
          THEN 'win' ELSE 'loss' 
        END as result,
        TO_CHAR(m.play_date, 'YYYY-MM-DD') as play_date
      FROM matches m
      WHERE (m.player1_id = $1 OR m.player2_id = $1 OR m.player3_id = $1 OR m.player4_id = $1)
        AND m.play_date = $2
      ORDER BY m.play_date DESC, m.created_at DESC
      LIMIT $3
    `, [playerId, date, limit])
    return result.rows
  }

  /**
   * Batch get player forms for multiple players at once (avoids N+1 queries)
   * Returns Map<playerId, formResults[]>
   */
  async getPlayerFormsInBatch(playerIds, limit = 5) {
    if (!playerIds || playerIds.length === 0) {
      return new Map()
    }

    // Use ROW_NUMBER() to get last N matches per player
    const result = await this.query(`
      WITH player_matches AS (
        SELECT 
          p.id as player_id,
          CASE WHEN 
            (m.winning_team = 1 AND (m.player1_id = p.id OR m.player2_id = p.id)) OR 
            (m.winning_team = 2 AND (m.player3_id = p.id OR m.player4_id = p.id))
            THEN 'win' ELSE 'loss' 
          END as result,
          TO_CHAR(m.play_date, 'YYYY-MM-DD') as play_date,
          ROW_NUMBER() OVER (
            PARTITION BY p.id 
            ORDER BY m.play_date DESC, m.created_at DESC
          ) as rn
        FROM unnest($1::int[]) AS p(id)
        INNER JOIN matches m ON 
          m.player1_id = p.id OR m.player2_id = p.id OR 
          m.player3_id = p.id OR m.player4_id = p.id
      )
      SELECT player_id, result, play_date
      FROM player_matches
      WHERE rn <= $2
      ORDER BY player_id, rn
    `, [playerIds, limit])

    // Group results by player_id
    const formMap = new Map()
    for (const playerId of playerIds) {
      formMap.set(playerId, [])
    }
    for (const row of result.rows) {
      const forms = formMap.get(row.player_id) || []
      forms.push({ result: row.result, play_date: row.play_date })
      formMap.set(row.player_id, forms)
    }
    return formMap
  }

  /**
   * Batch get player forms for a specific season (avoids N+1 queries)
   * Returns Map<playerId, formResults[]>
   */
  async getPlayerFormsBySeasonBatch(playerIds, seasonId, limit = 5) {
    if (!playerIds || playerIds.length === 0) {
      return new Map()
    }

    const result = await this.query(`
      WITH player_matches AS (
        SELECT 
          p.id as player_id,
          CASE WHEN 
            (m.winning_team = 1 AND (m.player1_id = p.id OR m.player2_id = p.id)) OR 
            (m.winning_team = 2 AND (m.player3_id = p.id OR m.player4_id = p.id))
            THEN 'win' ELSE 'loss' 
          END as result,
          TO_CHAR(m.play_date, 'YYYY-MM-DD') as play_date,
          ROW_NUMBER() OVER (
            PARTITION BY p.id 
            ORDER BY m.play_date DESC, m.created_at DESC
          ) as rn
        FROM unnest($1::int[]) AS p(id)
        INNER JOIN matches m ON 
          (m.player1_id = p.id OR m.player2_id = p.id OR 
           m.player3_id = p.id OR m.player4_id = p.id)
          AND m.season_id = $2
      )
      SELECT player_id, result, play_date
      FROM player_matches
      WHERE rn <= $3
      ORDER BY player_id, rn
    `, [playerIds, seasonId, limit])

    // Group results by player_id
    const formMap = new Map()
    for (const playerId of playerIds) {
      formMap.set(playerId, [])
    }
    for (const row of result.rows) {
      const forms = formMap.get(row.player_id) || []
      forms.push({ result: row.result, play_date: row.play_date })
      formMap.set(row.player_id, forms)
    }
    return formMap
  }

  /**
   * Batch get player forms for a specific date (avoids N+1 queries)
   * Returns Map<playerId, formResults[]>
   */
  async getPlayerFormsByDateBatch(playerIds, date, limit = 5) {
    if (!playerIds || playerIds.length === 0) {
      return new Map()
    }

    const result = await this.query(`
      WITH player_matches AS (
        SELECT 
          p.id as player_id,
          CASE WHEN 
            (m.winning_team = 1 AND (m.player1_id = p.id OR m.player2_id = p.id)) OR 
            (m.winning_team = 2 AND (m.player3_id = p.id OR m.player4_id = p.id))
            THEN 'win' ELSE 'loss' 
          END as result,
          TO_CHAR(m.play_date, 'YYYY-MM-DD') as play_date,
          ROW_NUMBER() OVER (
            PARTITION BY p.id 
            ORDER BY m.play_date DESC, m.created_at DESC
          ) as rn
        FROM unnest($1::int[]) AS p(id)
        INNER JOIN matches m ON 
          (m.player1_id = p.id OR m.player2_id = p.id OR 
           m.player3_id = p.id OR m.player4_id = p.id)
          AND m.play_date = $2
      )
      SELECT player_id, result, play_date
      FROM player_matches
      WHERE rn <= $3
      ORDER BY player_id, rn
    `, [playerIds, date, limit])

    // Group results by player_id
    const formMap = new Map()
    for (const playerId of playerIds) {
      formMap.set(playerId, [])
    }
    for (const row of result.rows) {
      const forms = formMap.get(row.player_id) || []
      forms.push({ result: row.result, play_date: row.play_date })
      formMap.set(row.player_id, forms)
    }
    return formMap
  }

  /**
   * Get player stats with forms for a specific date in optimized batch
   */
  async getPlayerStatsWithFormsByDate(date, formLimit = 5) {
    const rankings = await this.getPlayerStatsBySpecificDate(date)
    if (rankings.length === 0) return rankings

    const playerIds = rankings.map(p => p.id)
    const formsMap = await this.getPlayerFormsByDateBatch(playerIds, date, formLimit)

    return rankings.map(player => ({
      ...player,
      form: formsMap.get(player.id) || []
    }))
  }

  /**
   * Get player stats with forms in a single query (lifetime)
   * Uses recent_form from player_lifetime_stats summary table
   */
  async getPlayerStatsWithFormsLifetime(formLimit = 5) {
    const result = await this.query(`
      SELECT
        p.id, p.name,
        COALESCE(pls.wins, 0)::int as wins,
        COALESCE(pls.losses, 0)::int as losses,
        COALESCE(pls.total_matches, 0)::int as total_matches,
        COALESCE(pls.money_lost, 0)::bigint as money_lost,
        COALESCE(pls.points, 0)::int as points,
        COALESCE(pls.score_difference, 0) as score_difference,
        CASE WHEN COALESCE(pls.wins, 0) + COALESCE(pls.losses, 0) > 0
             THEN ROUND((COALESCE(pls.wins, 0) * 100.0) / (COALESCE(pls.wins, 0) + COALESCE(pls.losses, 0)), 1)
             ELSE 0 END as win_percentage,
        COALESCE(pls.recent_form, '[]'::jsonb) as recent_form
      FROM players p
      LEFT JOIN player_lifetime_stats pls ON pls.player_id = p.id
      ORDER BY COALESCE(pls.points, 0) DESC,
               COALESCE(pls.score_difference, 0) DESC,
               CASE WHEN COALESCE(pls.wins, 0) + COALESCE(pls.losses, 0) > 0
                    THEN ROUND((COALESCE(pls.wins, 0) * 100.0) / (COALESCE(pls.wins, 0) + COALESCE(pls.losses, 0)), 1)
                    ELSE 0 END DESC,
               p.name ASC
    `)
    return result.rows.map(row => ({
      ...row,
      form: (row.recent_form || []).slice(0, formLimit),
      recent_form: undefined // don't expose raw JSONB field
    }))
  }

  /**
   * Get player stats with forms for a season in optimized batch
   */
  async getPlayerStatsWithFormsBySeason(seasonId, formLimit = 5) {
    const rankings = await this.getPlayerStatsBySeason(seasonId)
    if (rankings.length === 0) return rankings

    const playerIds = rankings.map(p => p.id)
    const formsMap = await this.getPlayerFormsBySeasonBatch(playerIds, seasonId, formLimit)

    return rankings.map(player => ({
      ...player,
      form: formsMap.get(player.id) || []
    }))
  }

  // ==========================================
  // User Account Management
  // ==========================================

  async getUsers() {
    const result = await this.query(`
      SELECT id, username, email, role, display_name, is_active, 
             created_at, updated_at, last_login, created_by, notes,
             COALESCE(receive_match_notifications, true) as receive_match_notifications,
             COALESCE(receive_season_notifications, true) as receive_season_notifications
      FROM users 
      ORDER BY created_at DESC
    `)
    return result.rows
  }

  // Get users with password hash for backup purposes
  async getUsersForBackup() {
    const result = await this.query(`
      SELECT id, username, email, password_hash, role, display_name, is_active, 
             created_at, updated_at, last_login, created_by, notes
      FROM users 
      ORDER BY created_at DESC
    `)
    return result.rows
  }

  async getUserById(userId) {
    const result = await this.query(`
      SELECT id, username, email, role, display_name, is_active, 
             created_at, updated_at, last_login, created_by, notes,
             COALESCE(receive_match_notifications, true) as receive_match_notifications,
             COALESCE(receive_season_notifications, true) as receive_season_notifications
      FROM users 
      WHERE id = $1
    `, [userId])
    return result.rows[0] || null
  }

  async getUserByUsername(username) {
    const result = await this.query(`
      SELECT id, username, email, password_hash, role, display_name, is_active, 
             created_at, updated_at, last_login, created_by, notes,
             COALESCE(token_version, 0) as token_version
      FROM users 
      WHERE username = $1 AND is_active = true
    `, [username])
    return result.rows[0] || null
  }

  async getUserByEmail(email) {
    const result = await this.query(`
      SELECT id, username, email, password_hash, role, display_name, is_active, 
             created_at, updated_at, last_login, created_by, notes
      FROM users 
      WHERE email = $1 AND is_active = true
    `, [email])
    return result.rows[0] || null
  }

  async createUser(username, email, passwordHash, role, displayName, createdBy, notes = null) {
    const result = await this.query(`
      INSERT INTO users (username, email, password_hash, role, display_name, created_by, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, username, email, role, display_name, is_active, created_at
    `, [username, email, passwordHash, role, displayName, createdBy, notes])
    return result.rows[0]
  }

  // Restore user from backup - uses existing password hash
  async restoreUser(username, email, passwordHash, role, displayName, isActive, notes = null) {
    const result = await this.query(`
      INSERT INTO users (username, email, password_hash, role, display_name, is_active, created_by, notes)
      VALUES ($1, $2, $3, $4, $5, $6, 'backup_restore', $7)
      RETURNING id, username, email, role, display_name, is_active, created_at
    `, [username, email, passwordHash, role, displayName, isActive !== false, notes])
    return result.rows[0]
  }

  async updateUser(userId, updates) {
    const { email, role, displayName, isActive, notes, bumpTokenVersion,
            receiveMatchNotifications, receiveSeasonNotifications } = updates
    const result = await this.query(`
      UPDATE users 
      SET email = COALESCE($2, email),
          role = COALESCE($3, role),
          display_name = COALESCE($4, display_name),
          is_active = COALESCE($5, is_active),
          notes = COALESCE($6, notes),
          receive_match_notifications = COALESCE($7, receive_match_notifications),
          receive_season_notifications = COALESCE($8, receive_season_notifications)
          ${bumpTokenVersion ? ', token_version = COALESCE(token_version, 0) + 1' : ''}
      WHERE id = $1
      RETURNING id, username, email, role, display_name, is_active, updated_at,
                receive_match_notifications, receive_season_notifications
    `, [userId, email, role, displayName, isActive, notes,
        receiveMatchNotifications, receiveSeasonNotifications])
    return result.rows[0] || null
  }

  async updateUserPassword(userId, passwordHash) {
    // Increment token_version to invalidate all existing tokens for this user
    await this.query(`
      UPDATE users SET password_hash = $2, token_version = COALESCE(token_version, 0) + 1 WHERE id = $1
    `, [userId, passwordHash])
  }

  /**
   * Increment token_version to invalidate all existing JWTs for this user.
   * Called on logout, disable, or other security-sensitive operations.
   * @returns {number} The new token_version
   */
  async incrementTokenVersion(userId) {
    const result = await this.query(`
      UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = $1
      RETURNING token_version
    `, [userId])
    return result.rows[0]?.token_version ?? 0
  }

  /**
   * Get current token_version for a user (used by auth middleware).
   * Returns null if user not found (deleted), allowing middleware to revoke.
   */
  async getTokenVersion(userId) {
    const result = await this.query(`
      SELECT COALESCE(token_version, 0) as token_version FROM users WHERE id = $1
    `, [userId])
    if (result.rows.length === 0) return null
    return result.rows[0].token_version
  }

  async createRefreshSession({ tokenHash, userId = null, username, expiresAt }) {
    await this.query(`
      DELETE FROM refresh_sessions
      WHERE expires_at < NOW() OR revoked_at < NOW() - INTERVAL '30 days'
    `)
    await this.query(`
      INSERT INTO refresh_sessions (token_hash, user_id, username, expires_at)
      VALUES ($1, $2, $3, $4)
    `, [tokenHash, userId, username, expiresAt])
  }

  async rotateRefreshSession({ oldTokenHash, newTokenHash, userId = null, username, expiresAt }) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const consumed = await client.query(`
        UPDATE refresh_sessions
        SET revoked_at = NOW(), rotated_at = NOW(), replaced_by_hash = $2
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()
        RETURNING id
      `, [oldTokenHash, newTokenHash])
      if (consumed.rowCount !== 1) {
        await client.query('ROLLBACK')
        return false
      }
      await client.query(`
        INSERT INTO refresh_sessions (token_hash, user_id, username, expires_at)
        VALUES ($1, $2, $3, $4)
      `, [newTokenHash, userId, username, expiresAt])
      await client.query('COMMIT')
      return true
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async revokeRefreshSession(tokenHash) {
    await this.query(`
      UPDATE refresh_sessions SET revoked_at = COALESCE(revoked_at, NOW())
      WHERE token_hash = $1
    `, [tokenHash])
  }

  async updateUserLastLogin(userId) {
    await this.query(`
      UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1
    `, [userId])
  }

  async deleteUser(userId) {
    // C1: Invalidate all existing JWTs before deleting the user
    await this.incrementTokenVersion(userId)
    await this.query('DELETE FROM users WHERE id = $1', [userId])
  }

  async checkUsernameExists(username, excludeUserId = null) {
    const query = excludeUserId 
      ? 'SELECT COUNT(*) as count FROM users WHERE username = $1 AND id != $2'
      : 'SELECT COUNT(*) as count FROM users WHERE username = $1'
    const params = excludeUserId ? [username, excludeUserId] : [username]
    const result = await this.query(query, params)
    return parseInt(result.rows[0].count) > 0
  }

  async checkEmailExists(email, excludeUserId = null) {
    if (!email) return false
    const query = excludeUserId
      ? 'SELECT COUNT(*) as count FROM users WHERE email = $1 AND id != $2'
      : 'SELECT COUNT(*) as count FROM users WHERE email = $1'
    const params = excludeUserId ? [email, excludeUserId] : [email]
    const result = await this.query(query, params)
    return parseInt(result.rows[0].count) > 0
  }

  // ── FCM device registry ─────────────────────────────────────────────────
  // Upsert keyed on the unique token: re-registering the same token (rotation,
  // reinstall, or a different user signing in on the same device) updates the
  // existing row instead of inserting a duplicate.
  async upsertDevice(userId, token, platform, appVersion = null, registeredIp = null) {
    const result = await this.query(`
      INSERT INTO devices (user_id, token, platform, app_version, registered_ip)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (token) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        platform = EXCLUDED.platform,
        app_version = EXCLUDED.app_version,
        registered_ip = COALESCE(EXCLUDED.registered_ip, devices.registered_ip),
        updated_at = NOW()
      RETURNING id
    `, [userId, token, platform, appVersion, registeredIp])
    return result.rows[0].id
  }

  // Per-user device count — used to enforce the device cap in routes/devices.js.
  async countDevicesByUserId(userId) {
    const result = await this.query(
      `SELECT COUNT(*)::int AS count FROM devices WHERE user_id = $1`,
      [userId]
    )
    return result.rows[0].count
  }

  // Per-IP guest device count — used to enforce the guest cap. A guest device
  // is any device with user_id IS NULL, narrowed to the registering IP.
  async countGuestDevicesByIp(ip) {
    if (!ip) return 0
    const result = await this.query(
      `SELECT COUNT(*)::int AS count FROM devices WHERE user_id IS NULL AND registered_ip = $1`,
      [ip]
    )
    return result.rows[0].count
  }

  /**
   * Paginated query for FCM multicast fan-out. Uses keyset pagination on
   * devices.id for O(1) page lookups regardless of total device count.
   * Returns tokens for:
   *   - Guest devices (user_id IS NULL) — always included.
   *   - Devices belonging to active users who have the corresponding
   *     notification preference enabled.
   * @param {'match'|'season'} type  — which preference column to check
   * @param {number} afterId         — last device id from previous batch (0 for first)
   * @param {number} limit           — batch size (max 500 for FCM multicast)
   * @returns {Promise<{id: number, token: string}[]>}
   */
  async getDeviceTokensBatch(type, afterId = 0, limit = 500) {
    let prefCondition = 'true' // For custom broadcasts, send to all active users
    if (type === 'season') prefCondition = 'COALESCE(u.receive_season_notifications, true) = true'
    else if (type === 'match') prefCondition = 'COALESCE(u.receive_match_notifications, true) = true'

    const result = await this.query(`
      SELECT d.id, d.token
      FROM devices d
      LEFT JOIN users u ON d.user_id = u.id
      WHERE d.id > $1
        AND (
          d.user_id IS NULL                           -- guest devices always included
          OR (
            u.is_active = true
            AND ${prefCondition}
          )
        )
      ORDER BY d.id ASC
      LIMIT $2
    `, [afterId, limit])
    return result.rows
  }

  /**
   * Remove invalid FCM tokens (returned by Firebase as unregistered).
   * Called by the sender worker after sendEachForMulticast.
   */
  async removeDevicesByTokens(tokens) {
    if (!tokens || tokens.length === 0) return 0
    const result = await this.query(
      `DELETE FROM devices WHERE token = ANY($1::text[])`,
      [tokens]
    )
    return result.rowCount || 0
  }

  /**
   * Get the total count of registered FCM devices.
   */
  async getDeviceCount() {
    const result = await this.query(`SELECT COUNT(*) as count FROM devices`)
    return parseInt(result.rows[0].count)
  }

  // Delete tokens not refreshed within `days` days — the client's onTokenRefresh
  // would have bumped updated_at otherwise, so these are stale.
  async deleteStaleDevices(days = 60) {
    // Defense in depth: String(NaN) → 'NaN days' (PG syntax error),
    // String(-1) → '-1 days' (NOW() - (-1 days) is the FUTURE → wipes the table).
    if (!Number.isFinite(days) || days < 0) {
      throw new TypeError(`deleteStaleDevices: days must be a non-negative finite number, got ${days}`)
    }
    const result = await this.query(
      `DELETE FROM devices WHERE updated_at < NOW() - ($1 || ' days')::interval`,
      [String(days)]
    )
    return result.rowCount || 0
  }

  // Fetch the subset of players needed for a notification body. Single query,
  // no JOIN — the route already has the IDs from req.body. Returns
  // `[{id, name}]` (empty array for null/empty input).
  async getPlayersByIds(ids) {
    const filtered = (ids || []).filter(id => Number.isInteger(id))
    if (filtered.length === 0) return []
    const result = await this.query(
      `SELECT id, name FROM players WHERE id = ANY($1::int[])`,
      [filtered]
    )
    return result.rows
  }

  async clearAllData() {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      // Use TRUNCATE for faster, cleaner deletion (resets sequences automatically)
      // Cup tables must be included — cups has SET NULL on season_id so it won't cascade from seasons
      await client.query('TRUNCATE cup_advancements, cup_matches, cup_participants, cups, matches, season_players, seasons, players CASCADE')

      // Reset sequences
      await client.query('ALTER SEQUENCE players_id_seq RESTART WITH 1')
      await client.query('ALTER SEQUENCE seasons_id_seq RESTART WITH 1')
      await client.query('ALTER SEQUENCE matches_id_seq RESTART WITH 1')
      await client.query('ALTER SEQUENCE cups_id_seq RESTART WITH 1')
      await client.query('ALTER SEQUENCE cup_participants_id_seq RESTART WITH 1')
      await client.query('ALTER SEQUENCE cup_matches_id_seq RESTART WITH 1')
      await client.query('ALTER SEQUENCE cup_advancements_id_seq RESTART WITH 1')

      await client.query('COMMIT')
      console.log('🗑️ All data cleared from PostgreSQL database')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  // Clear all data for restore (preserves specified user)
  async clearAllDataForRestore(preserveUserId) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      // Use TRUNCATE for faster deletion
      // Cup tables must be included — cups has SET NULL on season_id so it won't cascade from seasons
      await client.query('TRUNCATE cup_advancements, cup_matches, cup_participants, cups, matches, season_players, seasons, players CASCADE')

      // Delete all users except the one performing the restore
      if (preserveUserId) {
        await client.query('DELETE FROM users WHERE id != $1', [preserveUserId])
      }

      // Reset sequences
      await client.query('ALTER SEQUENCE players_id_seq RESTART WITH 1')
      await client.query('ALTER SEQUENCE seasons_id_seq RESTART WITH 1')
      await client.query('ALTER SEQUENCE matches_id_seq RESTART WITH 1')
      await client.query('ALTER SEQUENCE cups_id_seq RESTART WITH 1')
      await client.query('ALTER SEQUENCE cup_participants_id_seq RESTART WITH 1')
      await client.query('ALTER SEQUENCE cup_matches_id_seq RESTART WITH 1')
      await client.query('ALTER SEQUENCE cup_advancements_id_seq RESTART WITH 1')

      await client.query('COMMIT')
      console.log('🗑️ All data cleared for restore (preserved current user)')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  // ── Site Images (self-service image editor) ───────────────────────────────
  async getSiteImages() {
    const result = await this.query(`
      SELECT id, key, filename, storage_path, content_type, file_size,
             alt_text, is_active, uploaded_by,
             uploaded_at,
             updated_at
      FROM site_images
      ORDER BY
        CASE key WHEN 'hero_banner' THEN 1 WHEN 'logo' THEN 2 WHEN 'favicon' THEN 3 WHEN 'background' THEN 4 ELSE 5 END,
        id
    `)
    return result.rows
  }

  async getSiteImageByKey(key) {
    const result = await this.query(`
      SELECT id, key, filename, storage_path, content_type, file_size,
             alt_text, is_active, uploaded_by,
             uploaded_at,
             updated_at
      FROM site_images WHERE key = $1
    `, [key])
    return result.rows[0] || null
  }

  async upsertSiteImage({ key, filename, storage_path, content_type, file_size, alt_text = '', uploaded_by }) {
    await this.query(`
      INSERT INTO site_images (key, filename, storage_path, content_type, file_size, alt_text, is_active, uploaded_by, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, true, $7, NOW())
      ON CONFLICT (key) DO UPDATE SET
        filename = $2, storage_path = $3, content_type = $4, file_size = $5,
        alt_text = $6, uploaded_by = $7, updated_at = NOW()
    `, [key, filename, storage_path, content_type, file_size, alt_text, uploaded_by])
  }

  async updateSiteImageMeta(key, { altText, isActive }) {
    const updates = []
    const params = []
    let idx = 1
    if (altText !== undefined) { updates.push(`alt_text = $${idx}`); params.push(altText); idx++ }
    if (isActive !== undefined) { updates.push(`is_active = $${idx}`); params.push(isActive); idx++ }
    if (updates.length > 0) {
      updates.push(`updated_at = NOW()`)
      params.push(key)
      await this.query(`UPDATE site_images SET ${updates.join(', ')} WHERE key = $${idx}`, params)
    }
  }

  // ── Season conclusion image ────────────────────────────────────────────────
  async uploadSeasonConclusionImage(seasonId, { filename, storage_path, content_type, file_size }) {
    await this.query(`
      UPDATE seasons SET
        conclusion_image_path = $1,
        conclusion_image_filename = $2,
        conclusion_image_content_type = $3,
        conclusion_image_size = $4
      WHERE id = $5
    `, [storage_path, filename, content_type, file_size, seasonId])
  }

  async deleteSeasonConclusionImage(seasonId) {
    await this.query(`
      UPDATE seasons SET
        conclusion_image_path = NULL,
        conclusion_image_filename = NULL,
        conclusion_image_content_type = NULL,
        conclusion_image_size = NULL
      WHERE id = $1
    `, [seasonId])
  }

  // ── Cup tournaments ────────────────────────────────────────────────────────
  async getCups(limit = 100) {
    const selectCols = `id, name, season_id, format, num_teams, regulation_text,
             status, start_date, end_date, created_by,
             COALESCE(final_results, '') as final_results,
             created_at, updated_at`
    // eslint-disable-next-line eqeqeq -- intentional null check for both null and undefined
    const sql = limit != null
      ? `SELECT ${selectCols} FROM cups ORDER BY created_at DESC LIMIT $1`
      : `SELECT ${selectCols} FROM cups ORDER BY created_at DESC`
    // eslint-disable-next-line eqeqeq -- intentional null check for both null and undefined
    const result = await this.query(sql, limit != null ? [limit] : [])
    return result.rows
  }

  async getCupById(cupId) {
    const result = await this.query(`
      SELECT id, name, season_id, format, num_teams, regulation_text,
             status, start_date, end_date, created_by,
             COALESCE(final_results, '') as final_results,
             COALESCE(conclusion_image_path, '') as conclusion_image_path,
             COALESCE(conclusion_image_filename, '') as conclusion_image_filename,
             COALESCE(conclusion_image_content_type, '') as conclusion_image_content_type,
             created_at,
             updated_at
      FROM cups WHERE id = $1
    `, [cupId])
    return result.rows[0] || null
  }

  async createCup(name, seasonId, format, numTeams, regulationText, createdBy) {
    const result = await this.query(`
      INSERT INTO cups (name, season_id, format, num_teams, regulation_text, status, created_by)
      VALUES ($1, $2, $3, $4, $5, 'draft', $6)
      RETURNING id
    `, [name, seasonId || null, format, numTeams, regulationText || null, createdBy])
    return result.rows[0].id
  }

  async updateCup(cupId, updates) {
    const sets = []
    const params = []
    let idx = 1
    for (const key of ['name', 'season_id', 'format', 'num_teams', 'regulation_text', 'status', 'start_date', 'end_date', 'final_results']) {
      if (updates[key] !== undefined) {
        sets.push(`${key} = $${idx}`)
        params.push(updates[key])
        idx++
      }
    }
    if (sets.length > 0) {
      sets.push('updated_at = NOW()')
      params.push(cupId)
      await this.query(`UPDATE cups SET ${sets.join(', ')} WHERE id = $${idx}`, params)
    }
  }

  async deleteCup(cupId) {
    await this.query(`DELETE FROM cups WHERE id = $1`, [cupId])
  }

  async getCupParticipants(cupId) {
    const result = await this.query(`
      SELECT cp.id, cp.cup_id, cp.player1_id, cp.player2_id, cp.team_name, cp.seed,
             p1.name as player1_name, p2.name as player2_name
      FROM cup_participants cp
      JOIN players p1 ON cp.player1_id = p1.id
      LEFT JOIN players p2 ON cp.player2_id = p2.id
      WHERE cp.cup_id = $1
      ORDER BY cp.seed ASC, cp.id ASC
    `, [cupId])
    return result.rows
  }

  async addCupParticipant(cupId, player1Id, player2Id, teamName, seed) {
    const result = await this.query(`
      INSERT INTO cup_participants (cup_id, player1_id, player2_id, team_name, seed)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (cup_id, player1_id, player2_id) DO NOTHING
      RETURNING id
    `, [cupId, player1Id, player2Id, teamName || null, seed || null])
    return result.rows[0]?.id || null
  }

  async removeCupParticipant(cupId, participantId) {
    await this.query(`DELETE FROM cup_participants WHERE id = $1 AND cup_id = $2`, [participantId, cupId])
  }

  async reorderCupParticipants(cupId, orderedParticipantIds) {
    if (!orderedParticipantIds || orderedParticipantIds.length === 0) return
    // Guard against unbounded loop from user-controlled input
    if (orderedParticipantIds.length > 500) {
      throw new Error('Too many participants (max 500)')
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (let i = 0; i < orderedParticipantIds.length; i++) {
        await client.query(`UPDATE cup_participants SET seed = $1 WHERE id = $2 AND cup_id = $3`,
          [i + 1, orderedParticipantIds[i], cupId])
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async getCupBracket(cupId) {
    const matches = await this.query(`
      SELECT cm.id, cm.round_number, cm.match_number, cm.bracket_position,
             cm.team1_participant_id, cm.team2_participant_id,
             cm.team1_score, cm.team2_score, cm.winner_participant_id,
             cm.goal_difference,
             cm.status,
             TO_CHAR(cm.play_date, 'YYYY-MM-DD') as play_date,
             cm1.player1_id as t1_p1, cm1.player2_id as t1_p2,
             cm1.player1_name as t1_p1_name, cm1.player2_name as t1_p2_name,
             cm1.team_name as t1_team_name,
             cm2.player1_id as t2_p1, cm2.player2_id as t2_p2,
             cm2.player1_name as t2_p1_name, cm2.player2_name as t2_p2_name,
             cm2.team_name as t2_team_name
      FROM cup_matches cm
      LEFT JOIN (
        SELECT cp.id, cp.player1_id, cp.player2_id,
               p1.name as player1_name, p2.name as player2_name,
               cp.team_name
        FROM cup_participants cp
        JOIN players p1 ON cp.player1_id = p1.id
        LEFT JOIN players p2 ON cp.player2_id = p2.id
      ) cm1 ON cm.team1_participant_id = cm1.id
      LEFT JOIN (
        SELECT cp.id, cp.player1_id, cp.player2_id,
               p1.name as player1_name, p2.name as player2_name,
               cp.team_name
        FROM cup_participants cp
        JOIN players p1 ON cp.player1_id = p1.id
        LEFT JOIN players p2 ON cp.player2_id = p2.id
      ) cm2 ON cm.team2_participant_id = cm2.id
      WHERE cm.cup_id = $1
      ORDER BY cm.round_number ASC, cm.match_number ASC
    `, [cupId])
    return matches.rows
  }

  async generateBracket(cupId) {
    const cup = await this.getCupById(cupId)
    if (!cup) throw new Error('Cup not found')

    // Only single_elimination is implemented; reject other formats early
    if (cup.format !== 'single_elimination') {
      throw new Error(`Bracket generation not supported for format: ${cup.format}. Only 'single_elimination' is available.`)
    }

    const participants = await this.getCupParticipants(cupId)
    const numTeams = participants.length

    if (numTeams < 2) throw new Error('Need at least 2 participants')
    if (numTeams > cup.num_teams) throw new Error(`Too many participants for ${cup.num_teams}-team format`)

    // Pad to power of 2 with byes
    let size = 2
    while (size < numTeams) size *= 2

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      // Clear existing bracket
      await client.query(`DELETE FROM cup_advancements WHERE from_match_id IN (SELECT id FROM cup_matches WHERE cup_id = $1)`, [cupId])
      await client.query(`DELETE FROM cup_matches WHERE cup_id = $1`, [cupId])

      const rounds = Math.log2(size)
      const matchesPerRound = size / 2

      // Create first round matches
      const firstRoundMatches = []
      for (let i = 0; i < matchesPerRound; i++) {
        const p1 = participants[i * 2]
        const p2 = participants[i * 2 + 1]

        const result = await client.query(`
          INSERT INTO cup_matches (cup_id, round_number, match_number, bracket_position,
                                   team1_participant_id, team2_participant_id, status)
          VALUES ($1, 1, $2, $3, $4, $5, $6)
          RETURNING id
        `, [
          cupId,
          i + 1,
          i < matchesPerRound / 2 ? 'top' : 'bottom',
          p1?.id || null,
          p2?.id || null,
          (!p1 || !p2) ? 'completed' : 'scheduled'
        ])

        const matchId = result.rows[0].id
        firstRoundMatches.push({ id: matchId, team1: p1, team2: p2 })

        // Auto-complete bye matches
        if (!p1 && p2) {
          await client.query(`
            UPDATE cup_matches SET team1_score = 0, team2_score = 0, winner_participant_id = $1, status = 'completed'
            WHERE id = $2
          `, [p2.id, matchId])
        } else if (p1 && !p2) {
          await client.query(`
            UPDATE cup_matches SET team1_score = 0, team2_score = 0, winner_participant_id = $1, status = 'completed'
            WHERE id = $2
          `, [p1.id, matchId])
        }
      }

      // Create subsequent rounds
      for (let r = 2; r <= rounds; r++) {
        const currentMatches = []

        for (let i = 0; i < matchesPerRound / Math.pow(2, r - 1); i++) {
          const result = await client.query(`
            INSERT INTO cup_matches (cup_id, round_number, match_number, bracket_position, status)
            VALUES ($1, $2, $3, $4, 'scheduled')
            RETURNING id
          `, [
            cupId,
            r,
            i + 1,
            i < (matchesPerRound / Math.pow(2, r - 1) / 2) ? 'top' : 'bottom'
          ])
          currentMatches.push(result.rows[0].id)
        }

        // Create advancement rules from previous round to this round
        const prevRoundMatchesList = r === 2 ? firstRoundMatches : (await client.query(
          `SELECT id FROM cup_matches WHERE cup_id = $1 AND round_number = $2 ORDER BY match_number`,
          [cupId, r - 1]
        )).rows

        let advIdx = 0
        for (const prevMatch of prevRoundMatchesList) {
          if (advIdx < currentMatches.length) {
            const slot = (advIdx % 2 === 0) ? 'team1' : 'team2'
            const targetMatchId = currentMatches[Math.floor(advIdx / 2)]
            await client.query(`
              INSERT INTO cup_advancements (from_match_id, to_match_id, winner_slot)
              VALUES ($1, $2, $3)
            `, [prevMatch.id, targetMatchId, slot])
            advIdx++
          }
        }
      }

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async updateCupMatchScore(cupId, matchId, team1Score, team2Score) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      const result = await client.query(`
        UPDATE cup_matches
        SET team1_score = $1, team2_score = $2, status = 'completed', updated_at = NOW()
        WHERE id = $3 AND cup_id = $4
        RETURNING id, team1_participant_id, team2_participant_id, winner_participant_id, round_number
      `, [team1Score, team2Score, matchId, cupId])

      if (result.rows.length === 0) {
        throw new Error('Match not found')
      }

      const match = result.rows[0]
      let winnerId = null

      if (team1Score > team2Score) winnerId = match.team1_participant_id
      else if (team2Score > team1Score) winnerId = match.team2_participant_id

      if (winnerId) {
        // Just record the winner — do NOT cascade to next round.
        // Winner advancement happens via advanceRound() with shuffle.
        await client.query(`
          UPDATE cup_matches SET winner_participant_id = $1 WHERE id = $2
        `, [winnerId, matchId])
      }

      // Check if all matches in this round are now completed — signal to frontend
      // that the round is ready for advancement.
      const roundCheck = await client.query(`
        SELECT COUNT(*) FILTER (WHERE status IN ('scheduled', 'in_progress')) AS pending
        FROM cup_matches WHERE cup_id = $1 AND round_number = $2
      `, [cupId, match.round_number])
      const roundComplete = parseInt(roundCheck.rows[0].pending, 10) === 0

      await client.query('COMMIT')
      return { success: true, winnerId, roundComplete }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async updateCupMatchDate(cupId, matchId, playDate) {
    await this.query(`
      UPDATE cup_matches SET play_date = $1, updated_at = NOW()
      WHERE id = $2 AND cup_id = $3
    `, [playDate, matchId, cupId])
  }

  /**
   * Set a cup match winner manually (no scores required).
   * Does NOT cascade — winner is recorded only. Advancement happens via advanceRound().
   */
  async setCupMatchWinner(cupId, matchId, winnerParticipantId) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      // 1. Validate the match exists and the winner is one of the two participants
      const matchRes = await client.query(`
        SELECT id, team1_participant_id, team2_participant_id, winner_participant_id,
               round_number, status
        FROM cup_matches
        WHERE id = $1 AND cup_id = $2
      `, [matchId, cupId])

      if (matchRes.rows.length === 0) {
        throw new Error('Match not found')
      }

      const match = matchRes.rows[0]
      const t1 = match.team1_participant_id
      const t2 = match.team2_participant_id

      if (t1 !== null && t1 === winnerParticipantId) {
        // Valid: winner is team 1
      } else if (t2 !== null && t2 === winnerParticipantId) {
        // Valid: winner is team 2
      } else {
        throw new Error('The selected participant is not in this match')
      }

      // 2. Set the winner and mark match as completed — no cascade
      await client.query(`
        UPDATE cup_matches
        SET winner_participant_id = $1, status = 'completed', updated_at = NOW()
        WHERE id = $2
      `, [winnerParticipantId, matchId])

      // Check if all matches in this round are now completed
      const roundCheck = await client.query(`
        SELECT COUNT(*) FILTER (WHERE status IN ('scheduled', 'in_progress')) AS pending
        FROM cup_matches WHERE cup_id = $1 AND round_number = $2
      `, [cupId, match.round_number])
      const roundComplete = parseInt(roundCheck.rows[0].pending, 10) === 0

      await client.query('COMMIT')
      return { success: true, winnerId: winnerParticipantId, roundComplete }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  /**
   * Advance winners from a completed round to the next round with shuffle.
   * - Collects all winners from the specified round
   * - Shuffles them randomly
   * - Assigns them to next round matches (2 per match)
   * - Marks the current round as locked (status = 'locked')
   */
  async advanceRound(cupId, fromRound) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      // 1. Guard against double-advance: check if round is already locked
      const lockedCheck = await client.query(`
        SELECT COUNT(*) AS locked FROM cup_matches
        WHERE cup_id = $1 AND round_number = $2 AND status = 'locked'
      `, [cupId, fromRound])
      if (parseInt(lockedCheck.rows[0].locked, 10) > 0) {
        await client.query('ROLLBACK')
        throw new Error('This round has already been advanced')
      }

      // 2. Verify all matches in the current round are completed
      const pendingCheck = await client.query(`
        SELECT COUNT(*) FILTER (WHERE status IN ('scheduled', 'in_progress')) AS pending
        FROM cup_matches WHERE cup_id = $1 AND round_number = $2
      `, [cupId, fromRound])
      if (parseInt(pendingCheck.rows[0].pending, 10) > 0) {
        throw new Error('Not all matches in this round are completed')
      }

      // 2. Get all winners from this round
      const winners = await client.query(`
        SELECT cm.id, cm.winner_participant_id
        FROM cup_matches cm
        WHERE cm.cup_id = $1 AND cm.round_number = $2
          AND cm.status = 'completed' AND cm.winner_participant_id IS NOT NULL
      `, [cupId, fromRound])

      if (winners.rows.length === 0) {
        throw new Error('No winners to advance')
      }

      // 3. Shuffle winners (Fisher-Yates)
      const shuffled = winners.rows.map(w => w.winner_participant_id)
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
      }

      // 4. Get next round matches
      const nextRound = fromRound + 1
      const nextMatches = await client.query(`
        SELECT id, match_number FROM cup_matches
        WHERE cup_id = $1 AND round_number = $2
        ORDER BY match_number ASC
      `, [cupId, nextRound])

      if (nextMatches.rows.length === 0) {
        // This was the final round — tournament is over
        await client.query(`
          UPDATE cups SET status = 'completed', updated_at = NOW() WHERE id = $1
        `, [cupId])
        // Lock current round
        await client.query(`
          UPDATE cup_matches SET status = 'locked'
          WHERE cup_id = $1 AND round_number = $2
        `, [cupId, fromRound])
        await client.query('COMMIT')
        return { success: true, isFinal: true, winners: shuffled }
      }

      // 5. Assign shuffled winners to next round matches (2 per match)
      let winnerIdx = 0
      for (const match of nextMatches.rows) {
        // team1 gets winner at current index
        if (winnerIdx < shuffled.length) {
          await client.query(`
            UPDATE cup_matches SET team1_participant_id = $1, updated_at = NOW()
            WHERE id = $2
          `, [shuffled[winnerIdx], match.id])
          winnerIdx++
        }
        // team2 gets next winner
        if (winnerIdx < shuffled.length) {
          await client.query(`
            UPDATE cup_matches SET team2_participant_id = $1, updated_at = NOW()
            WHERE id = $2
          `, [shuffled[winnerIdx], match.id])
          winnerIdx++
        }
      }

      // 6. Lock the current round (status = 'locked' so it can't be edited)
      await client.query(`
        UPDATE cup_matches SET status = 'locked'
        WHERE cup_id = $1 AND round_number = $2
      `, [cupId, fromRound])

      await client.query('COMMIT')
      return { success: true, isFinal: false, winners: shuffled, nextRound }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  /**
   * Recursively clear a winner's path through the bracket, starting from a given match.
   * Only clears matches where the given participant was the actual winner.
   */
  async _clearCupWinnerDownstream(client, cupId, matchId, participantId, currentRound) {
    // Clear from this match's advancement destinations
    const advancements = await client.query(`
      SELECT to_match_id, winner_slot FROM cup_advancements WHERE from_match_id = $1
    `, [matchId])

    // SECURITY: winner_slot is interpolated into a column name. Whitelist it
    // to the two known values so a tampered row (e.g. from a malicious
    // restored backup) can never inject SQL into the column identifier.
    const slotColumn = { team1: 'team1_participant_id', team2: 'team2_participant_id' }
    for (const adv of advancements.rows) {
      const col = slotColumn[adv.winner_slot]
      if (!col) continue
      await client.query(`
        UPDATE cup_matches
        SET ${col} = NULL, updated_at = NOW()
        WHERE id = $1
      `, [adv.to_match_id])
    }

    // Find all downstream matches where this participant appears
    const destMatches = await client.query(`
      SELECT id, winner_participant_id, round_number
      FROM cup_matches
      WHERE (team1_participant_id = $1 OR team2_participant_id = $1)
        AND cup_id = $2
        AND round_number > $3
    `, [participantId, cupId, currentRound])

    for (const dm of destMatches.rows) {
      // Only clear if THIS participant was the winner of the downstream match
      if (dm.winner_participant_id === participantId) {
        // Clear the downstream match's winner, scores, and status
        await client.query(`
          UPDATE cup_matches SET winner_participant_id = NULL, status = 'scheduled',
            team1_score = NULL, team2_score = NULL, updated_at = NOW()
          WHERE id = $1
        `, [dm.id])
        // Recurse: clear from this match's downstream too
        await this._clearCupWinnerDownstream(client, cupId, dm.id, participantId, dm.round_number)
      }
    }
  }

  /**
   * Get a single cup match by ID (scoped to cup).
   */
  async getCupMatchById(matchId, cupId) {
    const result = await this.query(`
      SELECT id, cup_id, round_number, match_number, status,
             team1_participant_id, team2_participant_id,
             winner_participant_id, team1_score, team2_score
      FROM cup_matches WHERE id = $1 AND cup_id = $2
    `, [matchId, cupId])
    return result.rows[0] || null
  }

  /**
   * Check if all matches in a given round of a cup are completed.
   * Used to enforce round-by-round progression in cup tournaments.
   */
  async areAllMatchesInRoundCompleted(cupId, roundNumber) {
    const result = await this.query(`
      SELECT COUNT(*) AS pending
      FROM cup_matches
      WHERE cup_id = $1 AND round_number = $2 AND status IN ('scheduled', 'in_progress')
    `, [cupId, roundNumber])
    return parseInt(result.rows[0].pending, 10) === 0
  }

  async resetCupMatch(cupId, matchId) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      // Check status of match
      const result = await client.query(`
        SELECT status FROM cup_matches WHERE id = $1 AND cup_id = $2
      `, [matchId, cupId])

      if (result.rows.length === 0) {
        throw new Error('Match not found')
      }

      if (result.rows[0].status === 'locked') {
        throw new Error('Cannot reset a locked match')
      }

      await client.query(`
        UPDATE cup_matches
        SET team1_score = NULL, team2_score = NULL, winner_participant_id = NULL, status = 'scheduled', updated_at = NOW()
        WHERE id = $1 AND cup_id = $2
      `, [matchId, cupId])

      await client.query('COMMIT')
      return { success: true }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  // ── Cup backup/restore helpers ─────────────────────────────────────────────
  async getCupsForBackup() {
    const cups = await this.query(`
      SELECT c.id, c.name, c.season_id, c.format, c.num_teams, c.regulation_text,
             c.status, c.start_date, c.end_date, c.created_by,
             c.final_results, c.conclusion_image_path, c.conclusion_image_filename,
             c.conclusion_image_content_type, c.created_at, c.updated_at,
             s.name AS season_name
      FROM cups c
      LEFT JOIN seasons s ON s.id = c.season_id
      ORDER BY c.id
    `)
    if (cups.rows.length === 0) return []
    const cupIds = cups.rows.map(cup => cup.id)
    const [participants, matches, advancements] = await Promise.all([
      this.query(`
        SELECT cp.id, cp.cup_id, cp.player1_id, cp.player2_id, cp.team_name, cp.seed,
               p1.name as player1_name, p2.name as player2_name
        FROM cup_participants cp
        JOIN players p1 ON cp.player1_id = p1.id
        LEFT JOIN players p2 ON cp.player2_id = p2.id
        WHERE cp.cup_id = ANY($1::int[])
        ORDER BY cp.cup_id, cp.seed ASC, cp.id ASC
      `, [cupIds]),
      this.query(`
        SELECT id, cup_id, round_number, match_number, bracket_position,
               team1_participant_id, team2_participant_id,
               team1_score, team2_score, winner_participant_id,
               play_date, status, created_at, updated_at
        FROM cup_matches
        WHERE cup_id = ANY($1::int[])
        ORDER BY cup_id, round_number ASC, match_number ASC
      `, [cupIds]),
      this.query(`
        SELECT ca.id, cm.cup_id, ca.from_match_id, ca.to_match_id, ca.winner_slot
        FROM cup_advancements ca
        JOIN cup_matches cm ON cm.id = ca.from_match_id
        WHERE cm.cup_id = ANY($1::int[])
        ORDER BY cm.cup_id, ca.id
      `, [cupIds])
    ])

    const groupByCup = rows => rows.reduce((map, row) => {
      const list = map.get(row.cup_id) || []
      list.push(row)
      map.set(row.cup_id, list)
      return map
    }, new Map())
    const participantMap = groupByCup(participants.rows)
    const matchMap = groupByCup(matches.rows)
    const advancementMap = groupByCup(advancements.rows)

    return cups.rows.map(cup => {
      const { season_name: seasonName = null } = cup
      return {
        ...cup,
        season_name: seasonName,
        participants: participantMap.get(cup.id) || [],
        matches: matchMap.get(cup.id) || [],
        advancements: (advancementMap.get(cup.id) || []).map(({ cup_id: _cupId, ...row }) => row)
      }
    })
  }

  async createCupMatch(cupId, matchData) {
    const result = await this.query(`
      INSERT INTO cup_matches (cup_id, round_number, match_number, bracket_position,
                               team1_participant_id, team2_participant_id,
                               team1_score, team2_score, winner_participant_id,
                               play_date, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id
    `, [
      cupId, matchData.round_number, matchData.match_number, matchData.bracket_position,
      matchData.team1_participant_id, matchData.team2_participant_id,
      matchData.team1_score, matchData.team2_score, matchData.winner_participant_id,
      matchData.play_date, matchData.status, matchData.created_at
    ])
    return result.rows[0].id
  }

  async createCupAdvancement(fromMatchId, toMatchId, winnerSlot) {
    await this.query(`
      INSERT INTO cup_advancements (from_match_id, to_match_id, winner_slot)
      VALUES ($1, $2, $3)
    `, [fromMatchId, toMatchId, winnerSlot])
  }

  async close() {
    if (this.pool) {
      await this.pool.end()
    }
  }
}

export default TennisDatabasePostgreSQL
