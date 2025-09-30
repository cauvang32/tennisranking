import pg from 'pg'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs/promises'

const { Pool } = pg

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

class TennisDatabasePostgreSQL {
  constructor() {
    this.config = {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      max: 20, // Maximum pool size
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

      // Seasons table
      await client.query(`
        CREATE TABLE IF NOT EXISTS seasons (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          start_date DATE NOT NULL,
          end_date DATE,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)

      // Matches table
      await client.query(`
        CREATE TABLE IF NOT EXISTS matches (
          id SERIAL PRIMARY KEY,
          season_id INTEGER NOT NULL REFERENCES seasons(id),
          play_date DATE NOT NULL,
          player1_id INTEGER NOT NULL REFERENCES players(id),
          player2_id INTEGER NOT NULL REFERENCES players(id),
          player3_id INTEGER NOT NULL REFERENCES players(id),
          player4_id INTEGER NOT NULL REFERENCES players(id),
          team1_score INTEGER NOT NULL,
          team2_score INTEGER NOT NULL,
          winning_team INTEGER NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
        CREATE INDEX IF NOT EXISTS idx_seasons_active ON seasons(is_active);
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
    const client = await this.pool.connect()
    try {
      const result = await client.query(text, params)
      return result
    } finally {
      client.release()
    }
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
    const result = await this.query(`
      SELECT id, name, 
        TO_CHAR(start_date, 'YYYY-MM-DD') as start_date,
        CASE 
          WHEN end_date IS NOT NULL THEN TO_CHAR(end_date, 'YYYY-MM-DD')
          ELSE NULL 
        END as end_date,
        is_active, created_at
      FROM seasons 
      ORDER BY start_date DESC
    `)
    return result.rows
  }

  async getActiveSeason() {
    const result = await this.query(`
      SELECT id, name, 
        TO_CHAR(start_date, 'YYYY-MM-DD') as start_date,
        CASE 
          WHEN end_date IS NOT NULL THEN TO_CHAR(end_date, 'YYYY-MM-DD')
          ELSE NULL 
        END as end_date,
        is_active, created_at
      FROM seasons 
      WHERE is_active = true
    `)
    return result.rows[0] || null
  }

  async createSeason(name, startDate) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      
      // Deactivate current active season
      await client.query('UPDATE seasons SET is_active = false WHERE is_active = true')
      
      // Create new season
      const result = await client.query(`
        INSERT INTO seasons (name, start_date, is_active) 
        VALUES ($1, $2, true) RETURNING id
      `, [name, startDate])
      
      await client.query('COMMIT')
      return result.rows[0].id
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async updateSeason(seasonId, name, startDate, endDate) {
    await this.query(`
      UPDATE seasons 
      SET name = $1, start_date = $2, end_date = $3 
      WHERE id = $4
    `, [name, startDate, endDate, seasonId])
  }

  async endSeason(seasonId, endDate) {
    await this.query(`
      UPDATE seasons 
      SET end_date = $1, is_active = false 
      WHERE id = $2
    `, [endDate, seasonId])
  }

  async getSeasonById(seasonId) {
    const result = await this.query(`
      SELECT id, name, 
        TO_CHAR(start_date, 'YYYY-MM-DD') as start_date,
        CASE 
          WHEN end_date IS NOT NULL THEN TO_CHAR(end_date, 'YYYY-MM-DD')
          ELSE NULL 
        END as end_date,
        is_active, created_at
      FROM seasons 
      WHERE id = $1
    `, [seasonId])
    return result.rows[0] || null
  }

  async deleteSeason(seasonId) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      
      // First delete all matches in this season
      await client.query('DELETE FROM matches WHERE season_id = $1', [seasonId])
      
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
  async addMatch(seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam) {
    const result = await this.query(`
      INSERT INTO matches (season_id, play_date, player1_id, player2_id, player3_id, player4_id, team1_score, team2_score, winning_team) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id
    `, [seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam])
    return result.rows[0].id
  }

  async getMatches(limit = null) {
    let query = `
      SELECT m.id, m.season_id, TO_CHAR(m.play_date, 'YYYY-MM-DD') as play_date,
        m.player1_id, m.player2_id, m.player3_id, m.player4_id,
        m.team1_score, m.team2_score, m.winning_team, m.created_at,
        s.name as season_name,
        p1.name as player1_name, p2.name as player2_name, 
        p3.name as player3_name, p4.name as player4_name
      FROM matches m
      JOIN seasons s ON m.season_id = s.id
      JOIN players p1 ON m.player1_id = p1.id
      JOIN players p2 ON m.player2_id = p2.id
      JOIN players p3 ON m.player3_id = p3.id
      JOIN players p4 ON m.player4_id = p4.id
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
        m.team1_score, m.team2_score, m.winning_team, m.created_at,
        s.name as season_name,
        p1.name as player1_name, p2.name as player2_name, 
        p3.name as player3_name, p4.name as player4_name
      FROM matches m
      JOIN seasons s ON m.season_id = s.id
      JOIN players p1 ON m.player1_id = p1.id
      JOIN players p2 ON m.player2_id = p2.id
      JOIN players p3 ON m.player3_id = p3.id
      JOIN players p4 ON m.player4_id = p4.id
      WHERE DATE(m.play_date) = $1
      ORDER BY m.created_at DESC
    `, [playDate])
    return result.rows
  }

  async getMatchesBySeason(seasonId) {
    const result = await this.query(`
      SELECT m.id, m.season_id, TO_CHAR(m.play_date, 'YYYY-MM-DD') as play_date,
        m.player1_id, m.player2_id, m.player3_id, m.player4_id,
        m.team1_score, m.team2_score, m.winning_team, m.created_at,
        s.name as season_name,
        p1.name as player1_name, p2.name as player2_name, 
        p3.name as player3_name, p4.name as player4_name
      FROM matches m
      JOIN seasons s ON m.season_id = s.id
      JOIN players p1 ON m.player1_id = p1.id
      JOIN players p2 ON m.player2_id = p2.id
      JOIN players p3 ON m.player3_id = p3.id
      JOIN players p4 ON m.player4_id = p4.id
      WHERE m.season_id = $1
      ORDER BY m.play_date DESC, m.created_at DESC
    `, [seasonId])
    return result.rows
  }

  async getMatchesByDate(date) {
    const result = await this.query(`
      SELECT m.*, s.name as season_name,
        p1.name as player1_name, p2.name as player2_name, 
        p3.name as player3_name, p4.name as player4_name
      FROM matches m
      JOIN seasons s ON m.season_id = s.id
      JOIN players p1 ON m.player1_id = p1.id
      JOIN players p2 ON m.player2_id = p2.id
      JOIN players p3 ON m.player3_id = p3.id
      JOIN players p4 ON m.player4_id = p4.id
      WHERE DATE(m.play_date) = $1
      ORDER BY m.created_at DESC
    `, [date])
    return result.rows
  }

  async getMatchById(matchId) {
    const result = await this.query(`
      SELECT m.*, s.name as season_name,
        p1.name as player1_name, p2.name as player2_name, 
        p3.name as player3_name, p4.name as player4_name
      FROM matches m
      JOIN seasons s ON m.season_id = s.id
      JOIN players p1 ON m.player1_id = p1.id
      JOIN players p2 ON m.player2_id = p2.id
      JOIN players p3 ON m.player3_id = p3.id
      JOIN players p4 ON m.player4_id = p4.id
      WHERE m.id = $1
    `, [matchId])
    return result.rows[0] || null
  }

  async updateMatch(matchId, seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam) {
    await this.query(`
      UPDATE matches 
      SET season_id = $1, play_date = $2, player1_id = $3, player2_id = $4, 
          player3_id = $5, player4_id = $6, team1_score = $7, team2_score = $8, 
          winning_team = $9
      WHERE id = $10
    `, [seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam, matchId])
  }

  async deleteMatch(matchId) {
    await this.query('DELETE FROM matches WHERE id = $1', [matchId])
  }

  async getPlayDates() {
    const result = await this.query(`
      SELECT DISTINCT TO_CHAR(DATE(play_date), 'YYYY-MM-DD') as play_date 
      FROM matches 
      ORDER BY TO_CHAR(DATE(play_date), 'YYYY-MM-DD') DESC
    `)
    return result.rows
  }

  async getLatestPlayDate() {
    const result = await this.query(`
      SELECT TO_CHAR(DATE(play_date), 'YYYY-MM-DD') as play_date 
      FROM matches 
      ORDER BY TO_CHAR(DATE(play_date), 'YYYY-MM-DD') DESC 
      LIMIT 1
    `)
    return result.rows[0]?.play_date || null
  }

  // Statistics and rankings
  async getPlayerStatsLifetime() {
    const result = await this.query(`
      WITH player_stats AS (
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
        LEFT JOIN matches m ON (m.player1_id = p.id OR m.player2_id = p.id OR m.player3_id = p.id OR m.player4_id = p.id)
        GROUP BY p.id, p.name
      )
      SELECT 
        *,
        (wins * 4 + losses * 1) as points,
        CASE WHEN (wins + losses) > 0 THEN ROUND((wins * 100.0) / (wins + losses), 1) ELSE 0 END as win_percentage,
        losses * 20000 as money_lost
      FROM player_stats
      ORDER BY points DESC, win_percentage DESC, name ASC
    `)
    return result.rows
  }

  async getPlayerStatsBySeason(seasonId) {
    const result = await this.query(`
      WITH player_stats AS (
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
        LEFT JOIN matches m ON (m.player1_id = p.id OR m.player2_id = p.id OR m.player3_id = p.id OR m.player4_id = p.id)
          AND m.season_id = $1
        GROUP BY p.id, p.name
      )
      SELECT 
        *,
        (wins * 4 + losses * 1) as points,
        CASE WHEN (wins + losses) > 0 THEN ROUND((wins * 100.0) / (wins + losses), 1) ELSE 0 END as win_percentage,
        losses * 20000 as money_lost
      FROM player_stats
      ORDER BY points DESC, win_percentage DESC, name ASC
    `, [seasonId])
    return result.rows
  }

  async getPlayerStatsByPlayDate(playDate) {
    const result = await this.query(`
      WITH player_stats AS (
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
        LEFT JOIN matches m ON (m.player1_id = p.id OR m.player2_id = p.id OR m.player3_id = p.id OR m.player4_id = p.id)
          AND DATE(m.play_date) <= $1
        GROUP BY p.id, p.name
      )
      SELECT 
        *,
        (wins * 4 + losses * 1) as points,
        CASE WHEN (wins + losses) > 0 THEN ROUND((wins * 100.0) / (wins + losses), 1) ELSE 0 END as win_percentage,
        losses * 20000 as money_lost
      FROM player_stats
      ORDER BY points DESC, win_percentage DESC, name ASC
    `, [playDate])
    return result.rows
  }

  async getPlayerStatsBySpecificDate(playDate) {
    const result = await this.query(`
      WITH player_stats AS (
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
        LEFT JOIN matches m ON (m.player1_id = p.id OR m.player2_id = p.id OR m.player3_id = p.id OR m.player4_id = p.id)
          AND DATE(m.play_date) = $1
        GROUP BY p.id, p.name
      )
      SELECT 
        *,
        (wins * 4 + losses * 1) as points,
        CASE WHEN (wins + losses) > 0 THEN ROUND((wins * 100.0) / (wins + losses), 1) ELSE 0 END as win_percentage,
        losses * 20000 as money_lost
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
        AND DATE(m.play_date) <= $2
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
        AND DATE(m.play_date) = $2
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
        AND DATE(m.play_date) = $2
      ORDER BY m.play_date DESC, m.created_at DESC
      LIMIT $3
    `, [playerId, date, limit])
    return result.rows
  }

  async clearAllData() {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      
      // Clear all tables in the correct order (respecting foreign key constraints)
      await client.query('DELETE FROM matches')
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

  async close() {
    if (this.pool) {
      await this.pool.end()
    }
  }
}

export default TennisDatabasePostgreSQL
