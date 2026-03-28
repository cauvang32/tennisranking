-- Migration: Add match_details view to reduce repeated JOINs
-- This view encapsulates the common 6-table JOIN used across many queries.
-- Safe to run multiple times (CREATE OR REPLACE).
--
-- Usage: SELECT * FROM match_details WHERE season_id = 1 ORDER BY play_date DESC;

CREATE OR REPLACE VIEW match_details AS
SELECT
    m.id,
    m.season_id,
    m.play_date::text AS play_date,
    m.player1_id,
    m.player2_id,
    m.player3_id,
    m.player4_id,
    m.team1_score,
    m.team2_score,
    m.winning_team,
    COALESCE(m.match_type, 'duo') AS match_type,
    m.created_at,
    s.name AS season_name,
    s.is_active AS season_is_active,
    COALESCE(s.lose_money_per_loss, 20000) AS lose_money_per_loss,
    p1.name AS player1_name,
    COALESCE(p2.name, '') AS player2_name,
    p3.name AS player3_name,
    COALESCE(p4.name, '') AS player4_name
FROM matches m
JOIN seasons s ON m.season_id = s.id
JOIN players p1 ON m.player1_id = p1.id
LEFT JOIN players p2 ON m.player2_id = p2.id
JOIN players p3 ON m.player3_id = p3.id
LEFT JOIN players p4 ON m.player4_id = p4.id;

-- Add updated_at columns with auto-update triggers
-- These help track when rows were last modified for cache invalidation debugging.

-- Players
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'players' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE players ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    CREATE OR REPLACE FUNCTION update_players_updated_at()
    RETURNS TRIGGER AS $t$
    BEGIN NEW.updated_at = CURRENT_TIMESTAMP; RETURN NEW; END;
    $t$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS trg_players_updated_at ON players;
    CREATE TRIGGER trg_players_updated_at
      BEFORE UPDATE ON players
      FOR EACH ROW EXECUTE FUNCTION update_players_updated_at();
  END IF;
END $$;

-- Seasons
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'seasons' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE seasons ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    CREATE OR REPLACE FUNCTION update_seasons_updated_at()
    RETURNS TRIGGER AS $t$
    BEGIN NEW.updated_at = CURRENT_TIMESTAMP; RETURN NEW; END;
    $t$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS trg_seasons_updated_at ON seasons;
    CREATE TRIGGER trg_seasons_updated_at
      BEFORE UPDATE ON seasons
      FOR EACH ROW EXECUTE FUNCTION update_seasons_updated_at();
  END IF;
END $$;

-- Matches
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'matches' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE matches ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    CREATE OR REPLACE FUNCTION update_matches_updated_at()
    RETURNS TRIGGER AS $t$
    BEGIN NEW.updated_at = CURRENT_TIMESTAMP; RETURN NEW; END;
    $t$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS trg_matches_updated_at ON matches;
    CREATE TRIGGER trg_matches_updated_at
      BEFORE UPDATE ON matches
      FOR EACH ROW EXECUTE FUNCTION update_matches_updated_at();
  END IF;
END $$;
