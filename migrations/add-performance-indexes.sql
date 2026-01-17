-- Migration: Add performance indexes for faster queries
-- Run this against your PostgreSQL database running in Docker
-- Usage: docker exec -i <container_name> psql -U <user> -d <database> < migrations/add-performance-indexes.sql

-- Index for player lookups in matches (form queries)
CREATE INDEX IF NOT EXISTS idx_matches_player1_id ON matches(player1_id);
CREATE INDEX IF NOT EXISTS idx_matches_player2_id ON matches(player2_id);
CREATE INDEX IF NOT EXISTS idx_matches_player3_id ON matches(player3_id);
CREATE INDEX IF NOT EXISTS idx_matches_player4_id ON matches(player4_id);

-- Composite index for season+date queries
CREATE INDEX IF NOT EXISTS idx_matches_season_date ON matches(season_id, play_date DESC);

-- Covering index for form lookup (most important for performance)
-- This includes all columns needed for form queries to avoid table lookup
CREATE INDEX IF NOT EXISTS idx_matches_form_lookup 
ON matches(play_date DESC, created_at DESC) 
INCLUDE (player1_id, player2_id, player3_id, player4_id, winning_team);

-- Composite index for season_players (used in player eligibility checks)
CREATE INDEX IF NOT EXISTS idx_season_players_composite ON season_players(season_id, player_id);

-- Analyze tables to update statistics after adding indexes
ANALYZE matches;
ANALYZE season_players;
ANALYZE players;
ANALYZE seasons;

-- Show created indexes
SELECT 
    schemaname,
    tablename,
    indexname,
    indexdef
FROM pg_indexes
WHERE tablename IN ('matches', 'players', 'seasons', 'season_players')
ORDER BY tablename, indexname;
