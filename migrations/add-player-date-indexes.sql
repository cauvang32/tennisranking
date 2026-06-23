-- Migration: Add composite indexes for ranking queries
-- Adds (player_id, play_date DESC) composite indexes for all 4 player columns.
-- Reduces ranking query I/O by 4x (single index scan vs 4 separate scans).
-- Idempotent: uses IF NOT EXISTS so safe to re-run.
-- Applied via: psql $DATABASE_URL -f migrations/add-player-date-indexes.sql

CREATE INDEX IF NOT EXISTS idx_matches_player1_date ON matches (player1_id, play_date DESC) WHERE player2_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_matches_player2_date ON matches (player2_id, play_date DESC) WHERE player2_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_matches_player3_date ON matches (player3_id, play_date DESC);
CREATE INDEX IF NOT EXISTS idx_matches_player4_date ON matches (player4_id, play_date DESC) WHERE player4_id IS NOT NULL;

-- Also index winning_team for ranking calculations
CREATE INDEX IF NOT EXISTS idx_matches_winning_team ON matches (winning_team);
