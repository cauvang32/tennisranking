import pg from 'pg'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs/promises'
import { readFileSync } from 'fs'

const { Pool } = pg

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Build SSL configuration synchronously (required for constructor)
function buildSSLConfig() {
  if (process.env.DB_SSL !== 'true') {
    return false
  }

  const rejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false'
  const sslConfig = { rejectUnauthorized }

  // Support custom CA certificate for self-signed certs
  if (process.env.DB_SSL_CA) {
    try {
      const path = require('path')
      // Path traversal protection: Normalize and validate certificate path
      const certPath = path.normalize(process.env.DB_SSL_CA)
      const resolvedPath = path.resolve(certPath)
      
      // Ensure path doesn't contain traversal attempts
      if (certPath.includes('..') || !resolvedPath.startsWith(path.resolve('.'))) {
        console.warn('⚠️ Invalid DB_SSL_CA path: path traversal detected')
      } else {
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
      max: parseInt(process.env.DB_POOL_MAX) || 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    }
    
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
    try {
      // Create connection pool
      this.pool = new Pool(this.config)

      // Test connection
      const client = await this.pool.connect()
      console.log('✅ PostgreSQL connection established successfully')
      client.release()

      // Create tables
      await this.createTables()
      
      console.log('✅ PostgreSQL database initialized successfully')
    } catch (error) {
      console.error('❌ PostgreSQL connection failed:', error.message)
      throw error
    }
  }

  async createTables() {
    const client = await this.pool.connect()
    
    try {
      await client.query('BEGIN')

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
          player2_id INTEGER NOT NULL REFERENCES players(id),
          player3_id INTEGER REFERENCES players(id),
          player4_id INTEGER REFERENCES players(id),
          team1_score INTEGER NOT NULL,
          team2_score INTEGER NOT NULL,
          winning_team INTEGER NOT NULL,
          match_type VARCHAR(10) DEFAULT 'duo',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT check_match_type CHECK (match_type IN ('solo', 'duo'))
        )
      `)

      // Create indexes for better performance
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_matches_play_date ON matches(play_date);
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_matches_season_id ON matches(season_id);
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_matches_match_type ON matches(match_type);
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_seasons_active ON seasons(is_active);
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_season_players_season_id ON season_players(season_id);
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_season_players_player_id ON season_players(player_id);
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
      
      // Composite index for season_players
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_season_players_composite ON season_players(season_id, player_id);
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
    if (existingSeasons.rows[0].count == 0) {
      const currentDate = new Date().toISOString().split('T')[0]
      await this.query(`
        INSERT INTO seasons (name, start_date, is_active) 
        VALUES ($1, $2, $3)
      `, ['Mùa giải đầu tiên', currentDate, true])
    }
  }

  async query(text, params = []) {
    return this.pool.query(text, params)
  }

  // Players CRUD operations
  async getPlayers() {
    const result = await this.query('SELECT * FROM players ORDER BY name')
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
  async getSeasons() {
    const result = await this.query(`SELECT ${SEASON_SELECT_COLS} FROM seasons ORDER BY is_active DESC, start_date DESC`)
    return result.rows
  }

  async getActiveSeasons() {
    const result = await this.query(`SELECT ${SEASON_SELECT_COLS} FROM seasons WHERE is_active = true ORDER BY start_date DESC`)
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
      
      // Add players to the season
      if (playerIds && playerIds.length > 0) {
        for (const playerId of playerIds) {
          await client.query(`
            INSERT INTO season_players (season_id, player_id, added_by)
            VALUES ($1, $2, 'creator')
            ON CONFLICT (season_id, player_id) DO NOTHING
          `, [seasonId, playerId])
        }
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

  async updateSeason(seasonId, name, startDate, endDate, autoEnd, description, loseMoneyPerLoss = null) {
    if (loseMoneyPerLoss !== null) {
      await this.query(`
        UPDATE seasons 
        SET name = $1, start_date = $2, end_date = $3, auto_end = $4, description = $5, lose_money_per_loss = $6
        WHERE id = $7
      `, [name, startDate, endDate, autoEnd, description, loseMoneyPerLoss, seasonId])
    } else {
      await this.query(`
        UPDATE seasons 
        SET name = $1, start_date = $2, end_date = $3, auto_end = $4, description = $5
        WHERE id = $6
      `, [name, startDate, endDate, autoEnd, description, seasonId])
    }
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
      
      // Add new players
      for (const playerId of playerIds) {
        await client.query(`
          INSERT INTO season_players (season_id, player_id, added_by)
          VALUES ($1, $2, $3)
        `, [seasonId, playerId, addedBy])
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
  async addMatch(seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam, matchType = 'duo') {
    const result = await this.query(`
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
      SELECT m.*, 
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

  // Statistics and rankings
  // For lifetime stats, we use a weighted average of lose_money_per_loss from all seasons
  // or default to 20000 if no season data is available
  async getPlayerStatsLifetime() {
    const result = await this.query(`
      WITH match_money AS (
        SELECT 
          m.id as match_id,
          m.player1_id, m.player2_id, m.player3_id, m.player4_id,
          m.winning_team,
          COALESCE(s.lose_money_per_loss, 20000) as lose_money
        FROM matches m
        JOIN seasons s ON m.season_id = s.id
      ),
      player_stats AS (
        SELECT 
          p.id,
          p.name,
          COUNT(CASE WHEN 
            (mm.winning_team = 1 AND (mm.player1_id = p.id OR mm.player2_id = p.id)) OR 
            (mm.winning_team = 2 AND (mm.player3_id = p.id OR mm.player4_id = p.id))
            THEN 1 END) as wins,
          COUNT(CASE WHEN 
            (mm.winning_team = 2 AND (mm.player1_id = p.id OR mm.player2_id = p.id)) OR 
            (mm.winning_team = 1 AND (mm.player3_id = p.id OR mm.player4_id = p.id))
            THEN 1 END) as losses,
          COUNT(CASE WHEN mm.match_id IS NOT NULL THEN 1 END) as total_matches,
          COALESCE(SUM(CASE WHEN 
            (mm.winning_team = 2 AND (mm.player1_id = p.id OR mm.player2_id = p.id)) OR 
            (mm.winning_team = 1 AND (mm.player3_id = p.id OR mm.player4_id = p.id))
            THEN mm.lose_money ELSE 0 END), 0) as money_lost
        FROM players p
        LEFT JOIN match_money mm ON (mm.player1_id = p.id OR mm.player2_id = p.id OR mm.player3_id = p.id OR mm.player4_id = p.id)
        GROUP BY p.id, p.name
      )
      SELECT 
        id, name, wins, losses, total_matches, money_lost,
        (wins * 4 + losses * 1) as points,
        CASE WHEN (wins + losses) > 0 THEN ROUND((wins * 100.0) / (wins + losses), 1) ELSE 0 END as win_percentage
      FROM player_stats
      ORDER BY points DESC, win_percentage DESC, name ASC
    `)
    return result.rows
  }

  async getPlayerStatsBySeason(seasonId) {
    // Get the lose_money_per_loss for this specific season
    const result = await this.query(`
      WITH season_config AS (
        SELECT COALESCE(lose_money_per_loss, 20000) as lose_money FROM seasons WHERE id = $1
      ),
      player_stats AS (
        SELECT 
          p.id,
          p.name,
          COUNT(CASE WHEN 
            (m.winning_team = 1 AND (m.player1_id = p.id OR m.player2_id = p.id)) OR 
            (m.winning_team = 2 AND (m.player3_id = p.id OR m.player4_id = p.id))
            THEN 1 END) as wins,
          COUNT(CASE WHEN 
            (m.winning_team = 2 AND (m.player1_id = p.id OR m.player2_id = p.id)) OR 
            (m.winning_team = 1 AND (m.player3_id = p.id OR m.player4_id = p.id))
            THEN 1 END) as losses,
          COUNT(CASE WHEN m.id IS NOT NULL THEN 1 END) as total_matches
        FROM players p
        INNER JOIN season_players sp ON sp.player_id = p.id AND sp.season_id = $1
        LEFT JOIN matches m ON (m.player1_id = p.id OR m.player2_id = p.id OR m.player3_id = p.id OR m.player4_id = p.id)
          AND m.season_id = $1
        GROUP BY p.id, p.name
      )
      SELECT 
        ps.id, ps.name, ps.wins, ps.losses, ps.total_matches,
        (ps.wins * 4 + ps.losses * 1) as points,
        CASE WHEN (ps.wins + ps.losses) > 0 THEN ROUND((ps.wins * 100.0) / (ps.wins + ps.losses), 1) ELSE 0 END as win_percentage,
        ps.losses * sc.lose_money as money_lost
      FROM player_stats ps, season_config sc
      ORDER BY points DESC, win_percentage DESC, ps.name ASC
    `, [seasonId])
    return result.rows
  }

  async getPlayerStatsByPlayDate(playDate) {
    const result = await this.query(`
      WITH match_money AS (
        SELECT 
          m.id as match_id,
          m.player1_id, m.player2_id, m.player3_id, m.player4_id,
          m.winning_team, m.play_date,
          COALESCE(s.lose_money_per_loss, 20000) as lose_money
        FROM matches m
        JOIN seasons s ON m.season_id = s.id
        WHERE m.play_date <= $1
      ),
      player_stats AS (
        SELECT 
          p.id,
          p.name,
          COUNT(CASE WHEN 
            (mm.winning_team = 1 AND (mm.player1_id = p.id OR mm.player2_id = p.id)) OR 
            (mm.winning_team = 2 AND (mm.player3_id = p.id OR mm.player4_id = p.id))
            THEN 1 END) as wins,
          COUNT(CASE WHEN 
            (mm.winning_team = 2 AND (mm.player1_id = p.id OR mm.player2_id = p.id)) OR 
            (mm.winning_team = 1 AND (mm.player3_id = p.id OR mm.player4_id = p.id))
            THEN 1 END) as losses,
          COUNT(CASE WHEN mm.match_id IS NOT NULL THEN 1 END) as total_matches,
          COALESCE(SUM(CASE WHEN 
            (mm.winning_team = 2 AND (mm.player1_id = p.id OR mm.player2_id = p.id)) OR 
            (mm.winning_team = 1 AND (mm.player3_id = p.id OR mm.player4_id = p.id))
            THEN mm.lose_money ELSE 0 END), 0) as money_lost
        FROM players p
        LEFT JOIN match_money mm ON (mm.player1_id = p.id OR mm.player2_id = p.id OR mm.player3_id = p.id OR mm.player4_id = p.id)
        GROUP BY p.id, p.name
      )
      SELECT 
        id, name, wins, losses, total_matches, money_lost,
        (wins * 4 + losses * 1) as points,
        CASE WHEN (wins + losses) > 0 THEN ROUND((wins * 100.0) / (wins + losses), 1) ELSE 0 END as win_percentage
      FROM player_stats
      ORDER BY points DESC, win_percentage DESC, name ASC
    `, [playDate])
    return result.rows
  }

  async getPlayerStatsBySpecificDate(playDate) {
    const result = await this.query(`
      WITH match_money AS (
        SELECT 
          m.id as match_id,
          m.player1_id, m.player2_id, m.player3_id, m.player4_id,
          m.winning_team,
          COALESCE(s.lose_money_per_loss, 20000) as lose_money
        FROM matches m
        JOIN seasons s ON m.season_id = s.id
        WHERE m.play_date = $1
      ),
      player_stats AS (
        SELECT 
          p.id,
          p.name,
          COUNT(CASE WHEN 
            (mm.winning_team = 1 AND (mm.player1_id = p.id OR mm.player2_id = p.id)) OR 
            (mm.winning_team = 2 AND (mm.player3_id = p.id OR mm.player4_id = p.id))
            THEN 1 END) as wins,
          COUNT(CASE WHEN 
            (mm.winning_team = 2 AND (mm.player1_id = p.id OR mm.player2_id = p.id)) OR 
            (mm.winning_team = 1 AND (mm.player3_id = p.id OR mm.player4_id = p.id))
            THEN 1 END) as losses,
          COUNT(CASE WHEN mm.match_id IS NOT NULL THEN 1 END) as total_matches,
          COALESCE(SUM(CASE WHEN 
            (mm.winning_team = 2 AND (mm.player1_id = p.id OR mm.player2_id = p.id)) OR 
            (mm.winning_team = 1 AND (mm.player3_id = p.id OR mm.player4_id = p.id))
            THEN mm.lose_money ELSE 0 END), 0) as money_lost
        FROM players p
        LEFT JOIN match_money mm ON (mm.player1_id = p.id OR mm.player2_id = p.id OR mm.player3_id = p.id OR mm.player4_id = p.id)
        GROUP BY p.id, p.name
      )
      SELECT 
        id, name, wins, losses, total_matches, money_lost,
        (wins * 4 + losses * 1) as points,
        CASE WHEN (wins + losses) > 0 THEN ROUND((wins * 100.0) / (wins + losses), 1) ELSE 0 END as win_percentage
      FROM player_stats
      ORDER BY points DESC, win_percentage DESC, name ASC
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
   */
  async getPlayerStatsWithFormsLifetime(formLimit = 5) {
    const rankings = await this.getPlayerStatsLifetime()
    if (rankings.length === 0) return rankings

    const playerIds = rankings.map(p => p.id)
    const formsMap = await this.getPlayerFormsInBatch(playerIds, formLimit)

    return rankings.map(player => ({
      ...player,
      form: formsMap.get(player.id) || []
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
             created_at, updated_at, last_login, created_by, notes
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
             created_at, updated_at, last_login, created_by, notes
      FROM users 
      WHERE id = $1
    `, [userId])
    return result.rows[0] || null
  }

  async getUserByUsername(username) {
    const result = await this.query(`
      SELECT id, username, email, password_hash, role, display_name, is_active, 
             created_at, updated_at, last_login, created_by, notes
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
    const { email, role, displayName, isActive, notes } = updates
    const result = await this.query(`
      UPDATE users 
      SET email = COALESCE($2, email),
          role = COALESCE($3, role),
          display_name = COALESCE($4, display_name),
          is_active = COALESCE($5, is_active),
          notes = COALESCE($6, notes)
      WHERE id = $1
      RETURNING id, username, email, role, display_name, is_active, updated_at
    `, [userId, email, role, displayName, isActive, notes])
    return result.rows[0] || null
  }

  async updateUserPassword(userId, passwordHash) {
    await this.query(`
      UPDATE users SET password_hash = $2 WHERE id = $1
    `, [userId, passwordHash])
  }

  async updateUserLastLogin(userId) {
    await this.query(`
      UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1
    `, [userId])
  }

  async deleteUser(userId) {
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

  async clearAllData() {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      
      // Clear all tables in the correct order (respecting foreign key constraints)
      await client.query('DELETE FROM matches')
      await client.query('DELETE FROM season_players')
      await client.query('DELETE FROM seasons')
      await client.query('DELETE FROM players')
      
      // Reset sequences (PostgreSQL equivalent of SQLite's auto-increment reset)
      await client.query('ALTER SEQUENCE players_id_seq RESTART WITH 1')
      await client.query('ALTER SEQUENCE seasons_id_seq RESTART WITH 1')
      await client.query('ALTER SEQUENCE matches_id_seq RESTART WITH 1')
      
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
      
      // Clear all tables in the correct order (respecting foreign key constraints)
      await client.query('DELETE FROM matches')
      await client.query('DELETE FROM season_players')
      await client.query('DELETE FROM seasons')
      await client.query('DELETE FROM players')
      
      // Delete all users except the one performing the restore
      if (preserveUserId) {
        await client.query('DELETE FROM users WHERE id != $1', [preserveUserId])
      }
      
      // Reset sequences
      await client.query('ALTER SEQUENCE players_id_seq RESTART WITH 1')
      await client.query('ALTER SEQUENCE seasons_id_seq RESTART WITH 1')
      await client.query('ALTER SEQUENCE matches_id_seq RESTART WITH 1')
      
      await client.query('COMMIT')
      console.log('🗑️ All data cleared for restore (preserved current user)')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async close() {
    if (this.pool) {
      await this.pool.end()
    }
  }
}

export default TennisDatabasePostgreSQL
