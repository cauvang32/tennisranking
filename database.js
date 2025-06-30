import sqlite3 from 'sqlite3'
import { open } from 'sqlite'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs/promises'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

class TennisDatabase {
  constructor() {
    this.db = null
    this.dbPath = join(__dirname, 'data', 'tennis.db')
  }

  async init() {
    // Ensure data directory exists
    const dataDir = join(__dirname, 'data')
    try {
      await fs.access(dataDir)
    } catch {
      await fs.mkdir(dataDir, { recursive: true })
    }

    // Open database connection
    this.db = await open({
      filename: this.dbPath,
      driver: sqlite3.Database
    })

    // Create tables
    await this.createTables()
    
    // Don't automatically create default season - let admin create seasons manually
  }

  async createTables() {
    // Players table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Seasons table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS seasons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE,
        is_active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Matches table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        season_id INTEGER NOT NULL,
        play_date DATE NOT NULL,
        player1_id INTEGER NOT NULL,
        player2_id INTEGER NOT NULL,
        player3_id INTEGER NOT NULL,
        player4_id INTEGER NOT NULL,
        team1_score INTEGER NOT NULL,
        team2_score INTEGER NOT NULL,
        winning_team INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (season_id) REFERENCES seasons(id),
        FOREIGN KEY (player1_id) REFERENCES players(id),
        FOREIGN KEY (player2_id) REFERENCES players(id),
        FOREIGN KEY (player3_id) REFERENCES players(id),
        FOREIGN KEY (player4_id) REFERENCES players(id)
      )
    `)

    // Create indexes for better performance
    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_matches_play_date ON matches(play_date);
      CREATE INDEX IF NOT EXISTS idx_matches_season_id ON matches(season_id);
      CREATE INDEX IF NOT EXISTS idx_seasons_active ON seasons(is_active);
    `)
  }

  async createDefaultSeason() {
    const existingSeasons = await this.db.get('SELECT COUNT(*) as count FROM seasons')
    if (existingSeasons.count === 0) {
      const currentDate = new Date().toISOString().split('T')[0]
      await this.db.run(`
        INSERT INTO seasons (name, start_date, is_active) 
        VALUES (?, ?, 1)
      `, ['Mùa giải đầu tiên', currentDate])
    }
  }

  // Players CRUD operations
  async getPlayers() {
    return await this.db.all('SELECT * FROM players ORDER BY name')
  }

  async addPlayer(name) {
    const result = await this.db.run('INSERT INTO players (name) VALUES (?)', [name])
    return result.lastID
  }

  async removePlayer(playerId) {
    // First remove all matches involving this player
    await this.db.run(`
      DELETE FROM matches 
      WHERE player1_id = ? OR player2_id = ? OR player3_id = ? OR player4_id = ?
    `, [playerId, playerId, playerId, playerId])
    
    // Then remove the player
    await this.db.run('DELETE FROM players WHERE id = ?', [playerId])
  }

  // Seasons CRUD operations
  async getSeasons() {
    return await this.db.all('SELECT * FROM seasons ORDER BY start_date DESC')
  }

  async getActiveSeason() {
    return await this.db.get('SELECT * FROM seasons WHERE is_active = 1')
  }

  async createSeason(name, startDate) {
    // Deactivate current active season
    await this.db.run('UPDATE seasons SET is_active = 0 WHERE is_active = 1')
    
    // Create new season
    const result = await this.db.run(`
      INSERT INTO seasons (name, start_date, is_active) 
      VALUES (?, ?, 1)
    `, [name, startDate])
    return result.lastID
  }

  async updateSeason(seasonId, name, startDate, endDate) {
    await this.db.run(`
      UPDATE seasons 
      SET name = ?, start_date = ?, end_date = ? 
      WHERE id = ?
    `, [name, startDate, endDate, seasonId])
  }

  async endSeason(seasonId, endDate) {
    await this.db.run(`
      UPDATE seasons 
      SET end_date = ?, is_active = 0 
      WHERE id = ?
    `, [endDate, seasonId])
  }

  async getSeasonById(seasonId) {
    return await this.db.get(`
      SELECT * FROM seasons WHERE id = ?
    `, [seasonId])
  }

  async deleteSeason(seasonId) {
    // First delete all matches in this season
    await this.db.run(`
      DELETE FROM matches WHERE season_id = ?
    `, [seasonId])
    
    // Then delete the season
    await this.db.run(`
      DELETE FROM seasons WHERE id = ?
    `, [seasonId])
  }

  // Matches CRUD operations
  async addMatch(seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam) {
    const result = await this.db.run(`
      INSERT INTO matches (season_id, play_date, player1_id, player2_id, player3_id, player4_id, team1_score, team2_score, winning_team) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam])
    return result.lastID
  }

  async getMatches(limit = null) {
    let query = `
      SELECT m.*, s.name as season_name,
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
      query += ` LIMIT ${limit}`
    }
    
    return await this.db.all(query)
  }

  async getMatchesByPlayDate(playDate) {
    return await this.db.all(`
      SELECT m.*, s.name as season_name,
        p1.name as player1_name, p2.name as player2_name, 
        p3.name as player3_name, p4.name as player4_name
      FROM matches m
      JOIN seasons s ON m.season_id = s.id
      JOIN players p1 ON m.player1_id = p1.id
      JOIN players p2 ON m.player2_id = p2.id
      JOIN players p3 ON m.player3_id = p3.id
      JOIN players p4 ON m.player4_id = p4.id
      WHERE m.play_date = ?
      ORDER BY m.created_at DESC
    `, [playDate])
  }

  async getMatchesBySeason(seasonId) {
    return await this.db.all(`
      SELECT m.*, s.name as season_name,
        p1.name as player1_name, p2.name as player2_name, 
        p3.name as player3_name, p4.name as player4_name
      FROM matches m
      JOIN seasons s ON m.season_id = s.id
      JOIN players p1 ON m.player1_id = p1.id
      JOIN players p2 ON m.player2_id = p2.id
      JOIN players p3 ON m.player3_id = p3.id
      JOIN players p4 ON m.player4_id = p4.id
      WHERE m.season_id = ?
      ORDER BY m.play_date DESC, m.created_at DESC
    `, [seasonId])
  }

  async getPlayDates() {
    return await this.db.all(`
      SELECT DISTINCT play_date 
      FROM matches 
      ORDER BY play_date DESC
    `)
  }

  async getLatestPlayDate() {
    const result = await this.db.get(`
      SELECT play_date 
      FROM matches 
      ORDER BY play_date DESC 
      LIMIT 1
    `)
    return result?.play_date
  }

  // Statistics and rankings
  async getPlayerStatsLifetime() {
    return await this.db.all(`
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
  }

  async getPlayerStatsBySeason(seasonId) {
    return await this.db.all(`
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
          AND m.season_id = ?
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
  }

  async getPlayerStatsByPlayDate(playDate) {
    return await this.db.all(`
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
          AND m.play_date <= ?
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
  }

  async getPlayerStatsBySpecificDate(playDate) {
    return await this.db.all(`
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
          AND m.play_date = ?
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
  }

  async getPlayerForm(playerId, limit = 5) {
    return await this.db.all(`
      SELECT 
        CASE WHEN 
          (m.winning_team = 1 AND (m.player1_id = ? OR m.player2_id = ?)) OR 
          (m.winning_team = 2 AND (m.player3_id = ? OR m.player4_id = ?))
          THEN 'win' ELSE 'loss' 
        END as result,
        m.play_date
      FROM matches m
      WHERE m.player1_id = ? OR m.player2_id = ? OR m.player3_id = ? OR m.player4_id = ?
      ORDER BY m.play_date DESC, m.created_at DESC
      LIMIT ?
    `, [playerId, playerId, playerId, playerId, playerId, playerId, playerId, playerId, limit])
  }

  async getPlayerFormBySeason(playerId, seasonId, limit = 5) {
    return await this.db.all(`
      SELECT 
        CASE WHEN 
          (m.winning_team = 1 AND (m.player1_id = ? OR m.player2_id = ?)) OR 
          (m.winning_team = 2 AND (m.player3_id = ? OR m.player4_id = ?))
          THEN 'win' ELSE 'loss' 
        END as result,
        m.play_date
      FROM matches m
      WHERE (m.player1_id = ? OR m.player2_id = ? OR m.player3_id = ? OR m.player4_id = ?)
        AND m.season_id = ?
      ORDER BY m.play_date DESC, m.created_at DESC
      LIMIT ?
    `, [playerId, playerId, playerId, playerId, playerId, playerId, playerId, playerId, seasonId, limit])
  }

  async getPlayerFormByDate(playerId, date, limit = 5) {
    return await this.db.all(`
      SELECT 
        CASE WHEN 
          (m.winning_team = 1 AND (m.player1_id = ? OR m.player2_id = ?)) OR 
          (m.winning_team = 2 AND (m.player3_id = ? OR m.player4_id = ?))
          THEN 'win' ELSE 'loss' 
        END as result,
        m.play_date
      FROM matches m
      WHERE (m.player1_id = ? OR m.player2_id = ? OR m.player3_id = ? OR m.player4_id = ?)
        AND m.play_date <= ?
      ORDER BY m.play_date DESC, m.created_at DESC
      LIMIT ?
    `, [playerId, playerId, playerId, playerId, playerId, playerId, playerId, playerId, date, limit])
  }

  async getPlayerFormOnSpecificDate(playerId, date, limit = 5) {
    return await this.db.all(`
      SELECT 
        CASE WHEN 
          (m.winning_team = 1 AND (m.player1_id = ? OR m.player2_id = ?)) OR 
          (m.winning_team = 2 AND (m.player3_id = ? OR m.player4_id = ?))
          THEN 'win' ELSE 'loss' 
        END as result,
        m.play_date
      FROM matches m
      WHERE (m.player1_id = ? OR m.player2_id = ? OR m.player3_id = ? OR m.player4_id = ?)
        AND DATE(m.play_date) = ?
      ORDER BY m.created_at DESC
      LIMIT ?
    `, [playerId, playerId, playerId, playerId, playerId, playerId, playerId, playerId, date, limit])
  }

  async clearAllData() {
    // Clear all tables in the correct order (respecting foreign key constraints)
    await this.db.run('DELETE FROM matches')
    await this.db.run('DELETE FROM seasons')
    await this.db.run('DELETE FROM players')
    
    // Reset auto-increment counters
    await this.db.run('DELETE FROM sqlite_sequence WHERE name IN ("players", "seasons", "matches")')
    
    console.log('🗑️ All data cleared from database')
  }

  async close() {
    if (this.db) {
      await this.db.close()
    }
  }

  async updateMatch(matchId, seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam) {
    await this.db.run(`
      UPDATE matches 
      SET season_id = ?, play_date = ?, player1_id = ?, player2_id = ?, 
          player3_id = ?, player4_id = ?, team1_score = ?, team2_score = ?, 
          winning_team = ?
      WHERE id = ?
    `, [seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam, matchId])
  }

  async deleteMatch(matchId) {
    await this.db.run('DELETE FROM matches WHERE id = ?', [matchId])
  }

  async getMatchById(matchId) {
    return await this.db.get(`
      SELECT m.*, s.name as season_name,
        p1.name as player1_name, p2.name as player2_name, 
        p3.name as player3_name, p4.name as player4_name
      FROM matches m
      JOIN seasons s ON m.season_id = s.id
      JOIN players p1 ON m.player1_id = p1.id
      JOIN players p2 ON m.player2_id = p2.id
      JOIN players p3 ON m.player3_id = p3.id
      JOIN players p4 ON m.player4_id = p4.id
      WHERE m.id = ?
    `, [matchId])
  }
}

export default TennisDatabase
