import { DatabaseCore } from './core.js'

export class UsersMethods extends DatabaseCore {
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


}
