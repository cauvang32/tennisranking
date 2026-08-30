import { DatabaseCore } from './core.js'

export class CupsMethods extends DatabaseCore {
  // ── Cup tournaments ────────────────────────────────────────────────────────
  async getCups(limit = 100) {
    const selectCols = `id, name, season_id, format, num_teams, regulation_text,
             status, start_date, end_date, created_by,
             COALESCE(final_results, '') as final_results,
             created_at, updated_at`
    // eslint-disable-next-line eqeqeq -- intentional null check for both null and undefined
    const sql = limit != null
      ? `SELECT ${selectCols} FROM cups ORDER BY created_at DESC LIMIT $1`
      : `SELECT ${selectCols} FROM cups ORDER BY created_at DESC`
    // eslint-disable-next-line eqeqeq -- intentional null check for both null and undefined
    const result = await this.query(sql, limit != null ? [limit] : [])
    return result.rows
  }


  async getCupById(cupId) {
    const result = await this.query(`
      SELECT id, name, season_id, format, num_teams, regulation_text,
             status, start_date, end_date, created_by,
             COALESCE(final_results, '') as final_results,
             COALESCE(conclusion_image_path, '') as conclusion_image_path,
             COALESCE(conclusion_image_filename, '') as conclusion_image_filename,
             COALESCE(conclusion_image_content_type, '') as conclusion_image_content_type,
             created_at,
             updated_at
      FROM cups WHERE id = $1
    `, [cupId])
    return result.rows[0] || null
  }


  async createCup(name, seasonId, format, numTeams, regulationText, createdBy) {
    const result = await this.query(`
      INSERT INTO cups (name, season_id, format, num_teams, regulation_text, status, created_by)
      VALUES ($1, $2, $3, $4, $5, 'draft', $6)
      RETURNING id
    `, [name, seasonId || null, format, numTeams, regulationText || null, createdBy])
    return result.rows[0].id
  }


  async updateCup(cupId, updates) {
    const sets = []
    const params = []
    let idx = 1
    for (const key of ['name', 'season_id', 'format', 'num_teams', 'regulation_text', 'status', 'start_date', 'end_date', 'final_results']) {
      if (updates[key] !== undefined) {
        sets.push(`${key} = $${idx}`)
        params.push(updates[key])
        idx++
      }
    }
    if (sets.length > 0) {
      sets.push('updated_at = NOW()')
      params.push(cupId)
      await this.query(`UPDATE cups SET ${sets.join(', ')} WHERE id = $${idx}`, params)
    }
  }


  async deleteCup(cupId) {
    await this.query(`DELETE FROM cups WHERE id = $1`, [cupId])
  }


  async getCupParticipants(cupId) {
    const result = await this.query(`
      SELECT cp.id, cp.cup_id, cp.player1_id, cp.player2_id, cp.team_name, cp.seed,
             p1.name as player1_name, p2.name as player2_name
      FROM cup_participants cp
      JOIN players p1 ON cp.player1_id = p1.id
      LEFT JOIN players p2 ON cp.player2_id = p2.id
      WHERE cp.cup_id = $1
      ORDER BY cp.seed ASC, cp.id ASC
    `, [cupId])
    return result.rows
  }


  async addCupParticipant(cupId, player1Id, player2Id, teamName, seed) {
    const result = await this.query(`
      INSERT INTO cup_participants (cup_id, player1_id, player2_id, team_name, seed)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (cup_id, player1_id, player2_id) DO NOTHING
      RETURNING id
    `, [cupId, player1Id, player2Id, teamName || null, seed || null])
    return result.rows[0]?.id || null
  }


  async removeCupParticipant(cupId, participantId) {
    await this.query(`DELETE FROM cup_participants WHERE id = $1 AND cup_id = $2`, [participantId, cupId])
  }


  async reorderCupParticipants(cupId, orderedParticipantIds) {
    if (!orderedParticipantIds || orderedParticipantIds.length === 0) return
    // Guard against unbounded loop from user-controlled input
    if (orderedParticipantIds.length > 500) {
      throw new Error('Too many participants (max 500)')
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (let i = 0; i < orderedParticipantIds.length; i++) {
        await client.query(`UPDATE cup_participants SET seed = $1 WHERE id = $2 AND cup_id = $3`,
          [i + 1, orderedParticipantIds[i], cupId])
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }


  async getCupBracket(cupId) {
    const matches = await this.query(`
      SELECT cm.id, cm.round_number, cm.match_number, cm.bracket_position,
             cm.team1_participant_id, cm.team2_participant_id,
             cm.team1_score, cm.team2_score, cm.winner_participant_id,
             cm.goal_difference,
             cm.status,
             TO_CHAR(cm.play_date, 'YYYY-MM-DD') as play_date,
             cm1.player1_id as t1_p1, cm1.player2_id as t1_p2,
             cm1.player1_name as t1_p1_name, cm1.player2_name as t1_p2_name,
             cm1.team_name as t1_team_name,
             cm2.player1_id as t2_p1, cm2.player2_id as t2_p2,
             cm2.player1_name as t2_p1_name, cm2.player2_name as t2_p2_name,
             cm2.team_name as t2_team_name
      FROM cup_matches cm
      LEFT JOIN (
        SELECT cp.id, cp.player1_id, cp.player2_id,
               p1.name as player1_name, p2.name as player2_name,
               cp.team_name
        FROM cup_participants cp
        JOIN players p1 ON cp.player1_id = p1.id
        LEFT JOIN players p2 ON cp.player2_id = p2.id
      ) cm1 ON cm.team1_participant_id = cm1.id
      LEFT JOIN (
        SELECT cp.id, cp.player1_id, cp.player2_id,
               p1.name as player1_name, p2.name as player2_name,
               cp.team_name
        FROM cup_participants cp
        JOIN players p1 ON cp.player1_id = p1.id
        LEFT JOIN players p2 ON cp.player2_id = p2.id
      ) cm2 ON cm.team2_participant_id = cm2.id
      WHERE cm.cup_id = $1
      ORDER BY cm.round_number ASC, cm.match_number ASC
    `, [cupId])
    return matches.rows
  }


  async generateBracket(cupId) {
    const cup = await this.getCupById(cupId)
    if (!cup) throw new Error('Cup not found')

    // Only single_elimination is implemented; reject other formats early
    if (cup.format !== 'single_elimination') {
      throw new Error(`Bracket generation not supported for format: ${cup.format}. Only 'single_elimination' is available.`)
    }

    const participants = await this.getCupParticipants(cupId)
    const numTeams = participants.length

    if (numTeams < 2) throw new Error('Need at least 2 participants')
    if (numTeams > cup.num_teams) throw new Error(`Too many participants for ${cup.num_teams}-team format`)

    // Pad to power of 2 with byes
    let size = 2
    while (size < numTeams) size *= 2

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      // Clear existing bracket
      await client.query(`DELETE FROM cup_advancements WHERE from_match_id IN (SELECT id FROM cup_matches WHERE cup_id = $1)`, [cupId])
      await client.query(`DELETE FROM cup_matches WHERE cup_id = $1`, [cupId])

      const rounds = Math.log2(size)
      const matchesPerRound = size / 2

      // Create first round matches
      const firstRoundMatches = []
      for (let i = 0; i < matchesPerRound; i++) {
        const p1 = participants[i * 2]
        const p2 = participants[i * 2 + 1]

        const result = await client.query(`
          INSERT INTO cup_matches (cup_id, round_number, match_number, bracket_position,
                                   team1_participant_id, team2_participant_id, status)
          VALUES ($1, 1, $2, $3, $4, $5, $6)
          RETURNING id
        `, [
          cupId,
          i + 1,
          i < matchesPerRound / 2 ? 'top' : 'bottom',
          p1?.id || null,
          p2?.id || null,
          (!p1 || !p2) ? 'completed' : 'scheduled'
        ])

        const matchId = result.rows[0].id
        firstRoundMatches.push({ id: matchId, team1: p1, team2: p2 })

        // Auto-complete bye matches
        if (!p1 && p2) {
          await client.query(`
            UPDATE cup_matches SET team1_score = 0, team2_score = 0, winner_participant_id = $1, status = 'completed'
            WHERE id = $2
          `, [p2.id, matchId])
        } else if (p1 && !p2) {
          await client.query(`
            UPDATE cup_matches SET team1_score = 0, team2_score = 0, winner_participant_id = $1, status = 'completed'
            WHERE id = $2
          `, [p1.id, matchId])
        }
      }

      // Create subsequent rounds
      for (let r = 2; r <= rounds; r++) {
        const currentMatches = []

        for (let i = 0; i < matchesPerRound / Math.pow(2, r - 1); i++) {
          const result = await client.query(`
            INSERT INTO cup_matches (cup_id, round_number, match_number, bracket_position, status)
            VALUES ($1, $2, $3, $4, 'scheduled')
            RETURNING id
          `, [
            cupId,
            r,
            i + 1,
            i < (matchesPerRound / Math.pow(2, r - 1) / 2) ? 'top' : 'bottom'
          ])
          currentMatches.push(result.rows[0].id)
        }

        // Create advancement rules from previous round to this round
        const prevRoundMatchesList = r === 2 ? firstRoundMatches : (await client.query(
          `SELECT id FROM cup_matches WHERE cup_id = $1 AND round_number = $2 ORDER BY match_number`,
          [cupId, r - 1]
        )).rows

        let advIdx = 0
        for (const prevMatch of prevRoundMatchesList) {
          if (advIdx < currentMatches.length) {
            const slot = (advIdx % 2 === 0) ? 'team1' : 'team2'
            const targetMatchId = currentMatches[Math.floor(advIdx / 2)]
            await client.query(`
              INSERT INTO cup_advancements (from_match_id, to_match_id, winner_slot)
              VALUES ($1, $2, $3)
            `, [prevMatch.id, targetMatchId, slot])
            advIdx++
          }
        }
      }

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }


  async updateCupMatchScore(cupId, matchId, team1Score, team2Score) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      const result = await client.query(`
        UPDATE cup_matches
        SET team1_score = $1, team2_score = $2, status = 'completed', updated_at = NOW()
        WHERE id = $3 AND cup_id = $4
        RETURNING id, team1_participant_id, team2_participant_id, winner_participant_id, round_number
      `, [team1Score, team2Score, matchId, cupId])

      if (result.rows.length === 0) {
        throw new Error('Match not found')
      }

      const match = result.rows[0]
      let winnerId = null

      if (team1Score > team2Score) winnerId = match.team1_participant_id
      else if (team2Score > team1Score) winnerId = match.team2_participant_id

      if (winnerId) {
        // Just record the winner — do NOT cascade to next round.
        // Winner advancement happens via advanceRound() with shuffle.
        await client.query(`
          UPDATE cup_matches SET winner_participant_id = $1 WHERE id = $2
        `, [winnerId, matchId])
      }

      // Check if all matches in this round are now completed — signal to frontend
      // that the round is ready for advancement.
      const roundCheck = await client.query(`
        SELECT COUNT(*) FILTER (WHERE status IN ('scheduled', 'in_progress')) AS pending
        FROM cup_matches WHERE cup_id = $1 AND round_number = $2
      `, [cupId, match.round_number])
      const roundComplete = parseInt(roundCheck.rows[0].pending, 10) === 0

      await client.query('COMMIT')
      return { success: true, winnerId, roundComplete }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }


  async updateCupMatchDate(cupId, matchId, playDate) {
    await this.query(`
      UPDATE cup_matches SET play_date = $1, updated_at = NOW()
      WHERE id = $2 AND cup_id = $3
    `, [playDate, matchId, cupId])
  }

  /**
   * Set a cup match winner manually (no scores required).
   * Does NOT cascade — winner is recorded only. Advancement happens via advanceRound().
   */

  async setCupMatchWinner(cupId, matchId, winnerParticipantId) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      // 1. Validate the match exists and the winner is one of the two participants
      const matchRes = await client.query(`
        SELECT id, team1_participant_id, team2_participant_id, winner_participant_id,
               round_number, status
        FROM cup_matches
        WHERE id = $1 AND cup_id = $2
      `, [matchId, cupId])

      if (matchRes.rows.length === 0) {
        throw new Error('Match not found')
      }

      const match = matchRes.rows[0]
      const t1 = match.team1_participant_id
      const t2 = match.team2_participant_id

      if (t1 !== null && t1 === winnerParticipantId) {
        // Valid: winner is team 1
      } else if (t2 !== null && t2 === winnerParticipantId) {
        // Valid: winner is team 2
      } else {
        throw new Error('The selected participant is not in this match')
      }

      // 2. Set the winner and mark match as completed — no cascade
      await client.query(`
        UPDATE cup_matches
        SET winner_participant_id = $1, status = 'completed', updated_at = NOW()
        WHERE id = $2
      `, [winnerParticipantId, matchId])

      // Check if all matches in this round are now completed
      const roundCheck = await client.query(`
        SELECT COUNT(*) FILTER (WHERE status IN ('scheduled', 'in_progress')) AS pending
        FROM cup_matches WHERE cup_id = $1 AND round_number = $2
      `, [cupId, match.round_number])
      const roundComplete = parseInt(roundCheck.rows[0].pending, 10) === 0

      await client.query('COMMIT')
      return { success: true, winnerId: winnerParticipantId, roundComplete }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  /**
   * Advance winners from a completed round to the next round with shuffle.
   * - Collects all winners from the specified round
   * - Shuffles them randomly
   * - Assigns them to next round matches (2 per match)
   * - Marks the current round as locked (status = 'locked')
   */

  async advanceRound(cupId, fromRound) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      // 1. Guard against double-advance: check if round is already locked
      const lockedCheck = await client.query(`
        SELECT COUNT(*) AS locked FROM cup_matches
        WHERE cup_id = $1 AND round_number = $2 AND status = 'locked'
      `, [cupId, fromRound])
      if (parseInt(lockedCheck.rows[0].locked, 10) > 0) {
        await client.query('ROLLBACK')
        throw new Error('This round has already been advanced')
      }

      // 2. Verify all matches in the current round are completed
      const pendingCheck = await client.query(`
        SELECT COUNT(*) FILTER (WHERE status IN ('scheduled', 'in_progress')) AS pending
        FROM cup_matches WHERE cup_id = $1 AND round_number = $2
      `, [cupId, fromRound])
      if (parseInt(pendingCheck.rows[0].pending, 10) > 0) {
        throw new Error('Not all matches in this round are completed')
      }

      // 2. Get all winners from this round
      const winners = await client.query(`
        SELECT cm.id, cm.winner_participant_id
        FROM cup_matches cm
        WHERE cm.cup_id = $1 AND cm.round_number = $2
          AND cm.status = 'completed' AND cm.winner_participant_id IS NOT NULL
      `, [cupId, fromRound])

      if (winners.rows.length === 0) {
        throw new Error('No winners to advance')
      }

      // 3. Shuffle winners (Fisher-Yates)
      const shuffled = winners.rows.map(w => w.winner_participant_id)
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
      }

      // 4. Get next round matches
      const nextRound = fromRound + 1
      const nextMatches = await client.query(`
        SELECT id, match_number FROM cup_matches
        WHERE cup_id = $1 AND round_number = $2
        ORDER BY match_number ASC
      `, [cupId, nextRound])

      if (nextMatches.rows.length === 0) {
        // This was the final round — tournament is over
        await client.query(`
          UPDATE cups SET status = 'completed', updated_at = NOW() WHERE id = $1
        `, [cupId])
        // Lock current round
        await client.query(`
          UPDATE cup_matches SET status = 'locked'
          WHERE cup_id = $1 AND round_number = $2
        `, [cupId, fromRound])
        await client.query('COMMIT')
        return { success: true, isFinal: true, winners: shuffled }
      }

      // 5. Assign shuffled winners to next round matches (2 per match)
      let winnerIdx = 0
      for (const match of nextMatches.rows) {
        // team1 gets winner at current index
        if (winnerIdx < shuffled.length) {
          await client.query(`
            UPDATE cup_matches SET team1_participant_id = $1, updated_at = NOW()
            WHERE id = $2
          `, [shuffled[winnerIdx], match.id])
          winnerIdx++
        }
        // team2 gets next winner
        if (winnerIdx < shuffled.length) {
          await client.query(`
            UPDATE cup_matches SET team2_participant_id = $1, updated_at = NOW()
            WHERE id = $2
          `, [shuffled[winnerIdx], match.id])
          winnerIdx++
        }
      }

      // 6. Lock the current round (status = 'locked' so it can't be edited)
      await client.query(`
        UPDATE cup_matches SET status = 'locked'
        WHERE cup_id = $1 AND round_number = $2
      `, [cupId, fromRound])

      await client.query('COMMIT')
      return { success: true, isFinal: false, winners: shuffled, nextRound }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  /**
   * Recursively clear a winner's path through the bracket, starting from a given match.
   * Only clears matches where the given participant was the actual winner.
   */

  async _clearCupWinnerDownstream(client, cupId, matchId, participantId, currentRound) {
    // Clear from this match's advancement destinations
    const advancements = await client.query(`
      SELECT to_match_id, winner_slot FROM cup_advancements WHERE from_match_id = $1
    `, [matchId])

    // SECURITY: winner_slot is interpolated into a column name. Whitelist it
    // to the two known values so a tampered row (e.g. from a malicious
    // restored backup) can never inject SQL into the column identifier.
    const slotColumn = { team1: 'team1_participant_id', team2: 'team2_participant_id' }
    for (const adv of advancements.rows) {
      const col = slotColumn[adv.winner_slot]
      if (!col) continue
      await client.query(`
        UPDATE cup_matches
        SET ${col} = NULL, updated_at = NOW()
        WHERE id = $1
      `, [adv.to_match_id])
    }

    // Find all downstream matches where this participant appears
    const destMatches = await client.query(`
      SELECT id, winner_participant_id, round_number
      FROM cup_matches
      WHERE (team1_participant_id = $1 OR team2_participant_id = $1)
        AND cup_id = $2
        AND round_number > $3
    `, [participantId, cupId, currentRound])

    for (const dm of destMatches.rows) {
      // Only clear if THIS participant was the winner of the downstream match
      if (dm.winner_participant_id === participantId) {
        // Clear the downstream match's winner, scores, and status
        await client.query(`
          UPDATE cup_matches SET winner_participant_id = NULL, status = 'scheduled',
            team1_score = NULL, team2_score = NULL, updated_at = NOW()
          WHERE id = $1
        `, [dm.id])
        // Recurse: clear from this match's downstream too
        await this._clearCupWinnerDownstream(client, cupId, dm.id, participantId, dm.round_number)
      }
    }
  }

  /**
   * Get a single cup match by ID (scoped to cup).
   */

  async getCupMatchById(matchId, cupId) {
    const result = await this.query(`
      SELECT id, cup_id, round_number, match_number, status,
             team1_participant_id, team2_participant_id,
             winner_participant_id, team1_score, team2_score
      FROM cup_matches WHERE id = $1 AND cup_id = $2
    `, [matchId, cupId])
    return result.rows[0] || null
  }

  /**
   * Check if all matches in a given round of a cup are completed.
   * Used to enforce round-by-round progression in cup tournaments.
   */

  async areAllMatchesInRoundCompleted(cupId, roundNumber) {
    const result = await this.query(`
      SELECT COUNT(*) AS pending
      FROM cup_matches
      WHERE cup_id = $1 AND round_number = $2 AND status IN ('scheduled', 'in_progress')
    `, [cupId, roundNumber])
    return parseInt(result.rows[0].pending, 10) === 0
  }


  async resetCupMatch(cupId, matchId) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      // Check status of match
      const result = await client.query(`
        SELECT status FROM cup_matches WHERE id = $1 AND cup_id = $2
      `, [matchId, cupId])

      if (result.rows.length === 0) {
        throw new Error('Match not found')
      }

      if (result.rows[0].status === 'locked') {
        throw new Error('Cannot reset a locked match')
      }

      await client.query(`
        UPDATE cup_matches
        SET team1_score = NULL, team2_score = NULL, winner_participant_id = NULL, status = 'scheduled', updated_at = NOW()
        WHERE id = $1 AND cup_id = $2
      `, [matchId, cupId])

      await client.query('COMMIT')
      return { success: true }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }


  // ── Cup backup/restore helpers ─────────────────────────────────────────────
  async getCupsForBackup() {
    const cups = await this.query(`
      SELECT c.id, c.name, c.season_id, c.format, c.num_teams, c.regulation_text,
             c.status, c.start_date, c.end_date, c.created_by,
             c.final_results, c.conclusion_image_path, c.conclusion_image_filename,
             c.conclusion_image_content_type, c.created_at, c.updated_at,
             s.name AS season_name
      FROM cups c
      LEFT JOIN seasons s ON s.id = c.season_id
      ORDER BY c.id
    `)
    if (cups.rows.length === 0) return []
    const cupIds = cups.rows.map(cup => cup.id)
    const [participants, matches, advancements] = await Promise.all([
      this.query(`
        SELECT cp.id, cp.cup_id, cp.player1_id, cp.player2_id, cp.team_name, cp.seed,
               p1.name as player1_name, p2.name as player2_name
        FROM cup_participants cp
        JOIN players p1 ON cp.player1_id = p1.id
        LEFT JOIN players p2 ON cp.player2_id = p2.id
        WHERE cp.cup_id = ANY($1::int[])
        ORDER BY cp.cup_id, cp.seed ASC, cp.id ASC
      `, [cupIds]),
      this.query(`
        SELECT id, cup_id, round_number, match_number, bracket_position,
               team1_participant_id, team2_participant_id,
               team1_score, team2_score, winner_participant_id,
               play_date, status, created_at, updated_at
        FROM cup_matches
        WHERE cup_id = ANY($1::int[])
        ORDER BY cup_id, round_number ASC, match_number ASC
      `, [cupIds]),
      this.query(`
        SELECT ca.id, cm.cup_id, ca.from_match_id, ca.to_match_id, ca.winner_slot
        FROM cup_advancements ca
        JOIN cup_matches cm ON cm.id = ca.from_match_id
        WHERE cm.cup_id = ANY($1::int[])
        ORDER BY cm.cup_id, ca.id
      `, [cupIds])
    ])

    const groupByCup = rows => rows.reduce((map, row) => {
      const list = map.get(row.cup_id) || []
      list.push(row)
      map.set(row.cup_id, list)
      return map
    }, new Map())
    const participantMap = groupByCup(participants.rows)
    const matchMap = groupByCup(matches.rows)
    const advancementMap = groupByCup(advancements.rows)

    return cups.rows.map(cup => {
      const { season_name: seasonName = null } = cup
      return {
        ...cup,
        season_name: seasonName,
        participants: participantMap.get(cup.id) || [],
        matches: matchMap.get(cup.id) || [],
        advancements: (advancementMap.get(cup.id) || []).map(({ cup_id: _cupId, ...row }) => row)
      }
    })
  }


  async createCupMatch(cupId, matchData) {
    const result = await this.query(`
      INSERT INTO cup_matches (cup_id, round_number, match_number, bracket_position,
                               team1_participant_id, team2_participant_id,
                               team1_score, team2_score, winner_participant_id,
                               play_date, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id
    `, [
      cupId, matchData.round_number, matchData.match_number, matchData.bracket_position,
      matchData.team1_participant_id, matchData.team2_participant_id,
      matchData.team1_score, matchData.team2_score, matchData.winner_participant_id,
      matchData.play_date, matchData.status, matchData.created_at
    ])
    return result.rows[0].id
  }


  async createCupAdvancement(fromMatchId, toMatchId, winnerSlot) {
    await this.query(`
      INSERT INTO cup_advancements (from_match_id, to_match_id, winner_slot)
      VALUES ($1, $2, $3)
    `, [fromMatchId, toMatchId, winnerSlot])
  }


}
