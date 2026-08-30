import { DatabaseCore } from './core.js'

export class RankingsMethods extends DatabaseCore {
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


}
