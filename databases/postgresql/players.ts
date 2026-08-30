import { DatabaseCore } from './core.js'

export class PlayersMethods extends DatabaseCore {
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


}
