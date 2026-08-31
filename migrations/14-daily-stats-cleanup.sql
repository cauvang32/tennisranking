-- Migration 14: Make player_daily_stats maintenance self-cleaning
--
-- Background:
--   player_daily_stats.player_id has a NO-ACTION FK to players. The legacy
--   trg_matches_daily_stats trigger (migration 07) only rebuilt stats for
--   players who STILL have matches on the affected date (it queried the
--   matches table after the row change). Consequences:
--     1. Deleting a player's last match on a date left an orphaned
--        player_daily_stats row — a later `DELETE FROM players` then failed
--        with 23503 (player_daily_stats_player_id_fkey).
--     2. Moving a match to a new date (or swapping its players) left stale
--        rows for the old date / removed players, polluting the daily ranking.
--     3. The trigger's pg_notify only carried the NEW date, so the old
--        date's cached rankings were never invalidated on a date move.
--
-- Fixes (idempotent, no data loss):
--   1. rebuild_player_daily_stats() now DELETES the (player, date) row when
--      the player has no matches on that date, instead of upserting zeros.
--   2. trg_matches_daily_stats() collects the affected (player, date) pairs
--      from the OLD row(s) as well as the NEW row, per TG_OP, so every
--      deletion/update rebuilds (and self-cleans) the right rows.
--   3. One pg_notify is sent per affected play_date.
--   4. A one-time backfill recomputes every (player, date) pair from matches
--      and purges any pre-existing orphaned rows.
--
-- The table definition is re-declared (IF NOT EXISTS) so numbered-migration
-- hosts that never ran the legacy 07 shell script get a consistent schema.

CREATE TABLE IF NOT EXISTS player_daily_stats (
    player_id      INTEGER REFERENCES players(id),
    play_date      DATE NOT NULL,
    wins           INTEGER DEFAULT 0,
    losses         INTEGER DEFAULT 0,
    total_matches  INTEGER DEFAULT 0,
    money_lost     BIGINT  DEFAULT 0,
    points         INTEGER DEFAULT 0,
    score_difference BIGINT DEFAULT 0,
    updated_at     TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (player_id, play_date)
);

CREATE INDEX IF NOT EXISTS idx_pds_date ON player_daily_stats(play_date);
CREATE INDEX IF NOT EXISTS idx_pds_date_points_diff ON player_daily_stats(play_date, points DESC, score_difference DESC);

-- =====================================================================
-- Rebuild daily stats for one player on one specific date.
-- NEW (migration 14): when the player has no matches on that date the row
-- is DELETED (previously a zero-valued row was upserted and never removed).
-- =====================================================================
CREATE OR REPLACE FUNCTION rebuild_player_daily_stats(p_player_id INTEGER, p_play_date DATE)
RETURNS VOID AS $$
DECLARE
    v_wins       INTEGER := 0;
    v_losses     INTEGER := 0;
    v_total      INTEGER := 0;
    v_money      BIGINT  := 0;
    v_score_diff BIGINT  := 0;
BEGIN
    -- Aggregate from matches on this specific date
    SELECT
        COUNT(*) FILTER (WHERE get_match_result_for_player(
            p_player_id, m.player1_id, m.player2_id, m.player3_id, m.player4_id, m.winning_team
        ) = 'win'),
        COUNT(*) FILTER (WHERE get_match_result_for_player(
            p_player_id, m.player1_id, m.player2_id, m.player3_id, m.player4_id, m.winning_team
        ) = 'loss'),
        COUNT(*),
        COALESCE(SUM(
            CASE WHEN get_match_result_for_player(
                p_player_id, m.player1_id, m.player2_id, m.player3_id, m.player4_id, m.winning_team
            ) = 'loss'
            THEN COALESCE(s.lose_money_per_loss, 20000) ELSE 0 END
        ), 0),
        -- score_difference (BIGINT to avoid overflow across many matches)
        COALESCE(SUM(
            CASE
                WHEN p_player_id = m.player1_id OR p_player_id = m.player2_id
                    THEN m.team1_score - m.team2_score
                WHEN p_player_id = m.player3_id OR p_player_id = m.player4_id
                    THEN m.team2_score - m.team1_score
            END
        ), 0)
    INTO v_wins, v_losses, v_total, v_money, v_score_diff
    FROM matches m
    JOIN seasons s ON m.season_id = s.id
    WHERE m.play_date = p_play_date
      AND (m.player1_id = p_player_id OR m.player2_id = p_player_id
        OR m.player3_id = p_player_id OR m.player4_id = p_player_id);

    -- No matches left on this date: drop the row so no orphaned/zero row
    -- remains (orphaned rows block player deletes via the NO-ACTION FK).
    IF v_total = 0 THEN
        DELETE FROM player_daily_stats
        WHERE player_id = p_player_id AND play_date = p_play_date;
        RETURN;
    END IF;

    -- Upsert into player_daily_stats
    INSERT INTO player_daily_stats (player_id, play_date, wins, losses, total_matches, money_lost, points, score_difference, updated_at)
    VALUES (p_player_id, p_play_date, v_wins, v_losses, v_total, v_money, v_wins * 4 + v_losses, v_score_diff, NOW())
    ON CONFLICT (player_id, play_date) DO UPDATE SET
        wins = EXCLUDED.wins,
        losses = EXCLUDED.losses,
        total_matches = EXCLUDED.total_matches,
        money_lost = EXCLUDED.money_lost,
        points = EXCLUDED.points,
        score_difference = EXCLUDED.score_difference,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- Trigger function: rebuild daily stats for every (player, date) pair
-- touched by the row change, including pairs from the OLD row.
--   INSERT: NEW players x NEW.play_date
--   UPDATE: (OLD + NEW players) x (OLD.play_date + NEW.play_date)
--   DELETE: OLD players x OLD.play_date
-- =====================================================================
CREATE OR REPLACE FUNCTION trg_matches_daily_stats()
RETURNS TRIGGER AS $$
DECLARE
    v_players INTEGER[];
    v_dates   DATE[];
    r RECORD;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_players := ARRAY[OLD.player1_id, OLD.player2_id, OLD.player3_id, OLD.player4_id];
        v_dates   := ARRAY[OLD.play_date];
    ELSIF TG_OP = 'UPDATE' THEN
        v_players := ARRAY[OLD.player1_id, OLD.player2_id, OLD.player3_id, OLD.player4_id,
                           NEW.player1_id, NEW.player2_id, NEW.player3_id, NEW.player4_id];
        v_dates   := ARRAY[OLD.play_date, NEW.play_date];
    ELSE -- INSERT
        v_players := ARRAY[NEW.player1_id, NEW.player2_id, NEW.player3_id, NEW.player4_id];
        v_dates   := ARRAY[NEW.play_date];
    END IF;

    -- Rebuild (and self-clean) every affected (player, date) pair
    FOR r IN
        SELECT DISTINCT val AS player_id, d AS play_date
        FROM unnest(v_players) AS val
        CROSS JOIN unnest(v_dates) AS d
        WHERE val IS NOT NULL AND d IS NOT NULL
    LOOP
        PERFORM rebuild_player_daily_stats(r.player_id, r.play_date);
    END LOOP;

    -- Invalidate the cached daily ranking for every affected date
    FOR r IN
        SELECT DISTINCT d AS play_date FROM unnest(v_dates) AS d WHERE d IS NOT NULL
    LOOP
        PERFORM pg_notify('cache_invalidation', json_build_object(
            'action', 'match_change',
            'date', r.play_date::text
        )::text);
    END LOOP;

    IF TG_OP = 'DELETE' THEN RETURN OLD;
    ELSE RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_matches_daily_stats ON matches;
CREATE TRIGGER trg_matches_daily_stats
    AFTER INSERT OR UPDATE OR DELETE ON matches
    FOR EACH ROW EXECUTE FUNCTION trg_matches_daily_stats();

-- =====================================================================
-- One-time backfill: recompute every (player, date) pair from matches,
-- then purge any pre-existing orphaned rows (players with no match left
-- on the stored date). Safe to re-run: the rebuild is idempotent.
-- =====================================================================
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT DISTINCT val AS player_id, m.play_date
        FROM matches m
        CROSS JOIN unnest(ARRAY[m.player1_id, m.player2_id, m.player3_id, m.player4_id]) AS val
        WHERE val IS NOT NULL AND m.play_date IS NOT NULL
    LOOP
        PERFORM rebuild_player_daily_stats(r.player_id, r.play_date);
    END LOOP;

    DELETE FROM player_daily_stats d
    WHERE NOT EXISTS (
        SELECT 1 FROM matches m
        WHERE m.play_date = d.play_date
          AND (m.player1_id = d.player_id OR m.player2_id = d.player_id
            OR m.player3_id = d.player_id OR m.player4_id = d.player_id)
    );
END;
$$;
