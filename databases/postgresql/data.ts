import { DatabaseCore } from './core.js'

export class DataMethods extends DatabaseCore {
  async clearAllData() {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // Silence per-row cache-invalidation triggers for the bulk TRUNCATE;
      // the caller publishes one notification after commit (see backup routes).
      await client.query("SELECT set_config('tennis.cache_bulk_tx', '1', false)")

      // Use TRUNCATE for faster, cleaner deletion (resets sequences automatically)
      // Cup tables must be included — cups has SET NULL on season_id so it won't cascade from seasons
      await client.query('TRUNCATE cup_advancements, cup_matches, cup_participants, cups, matches, season_players, player_daily_stats, seasons, players CASCADE')

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
      // Silence per-row cache-invalidation triggers for the bulk TRUNCATE;
      // the caller publishes one notification after commit (see backup routes).
      await client.query("SELECT set_config('tennis.cache_bulk_tx', '1', false)")

      // Use TRUNCATE for faster deletion
      // Cup tables must be included — cups has SET NULL on season_id so it won't cascade from seasons
      await client.query('TRUNCATE cup_advancements, cup_matches, cup_participants, cups, matches, season_players, player_daily_stats, seasons, players CASCADE')

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


}
