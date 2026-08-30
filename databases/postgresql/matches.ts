import { DatabaseCore } from './core.js'

export class MatchesMethods extends DatabaseCore {
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


}
