-- Migration: Add performance indexes for faster queries
-- Run this against your PostgreSQL database running in Docker
-- Usage: docker exec -i <container_name> psql -U <user> -d <database> < migrations/add-performance-indexes.sql
--
-- Note: idx_matches_player[1-4]_id, idx_matches_season_date, and
-- idx_season_players_composite are already created by createTables() at startup.
-- This migration only adds the NEW covering index (form_lookup) and a partial
-- index for FCM device-dispatch performance.

-- ── NEW: Covering index for form lookup ────────────────────────────────────────
-- Includes all columns needed for form queries to avoid table lookups.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_matches_form_lookup
ON matches(play_date DESC, created_at DESC)
INCLUDE (player1_id, player2_id, player3_id, player4_id, winning_team);

-- ── NEW: Partial index for FCM device-dispatch ────────────────────────────────
-- Speeds up the getDeviceTokensBatch query when filtering WHERE user_id IS NULL.
-- Without this partial index, the planner must scan ALL device rows (guest + user)
-- on every notification send. At scale (thousands of devices) this degrades FCM
-- dispatch latency significantly.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_devices_guest_dispatch
ON devices(id) WHERE user_id IS NULL;

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
WHERE tablename IN ('matches', 'players', 'seasons', 'season_players', 'devices')
ORDER BY tablename, indexname;
