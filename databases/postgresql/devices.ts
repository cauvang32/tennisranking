import { DatabaseCore } from './core.js'

export class DevicesMethods extends DatabaseCore {
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


}
