import { DatabaseCore } from './core.js'

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


export class SeasonsMethods extends DatabaseCore {
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


}
