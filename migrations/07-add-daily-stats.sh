#!/bin/bash
# Migration Script: Add player_daily_stats Summary Table
# Version: 7.0.0
# Purpose: Optimize daily ranking queries by pre-computing stats per date
#
# This migration:
#   1. Creates player_daily_stats table with score_difference column
#   2. Creates rebuild_player_daily_stats function
#   3. Creates trigger to auto-rebuild on match changes
#   4. Backfills existing data
#   5. Verifies accuracy

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}  Daily Stats Summary Table Migration${NC}"
echo -e "${BLUE}  Version 7.0.0${NC}"
echo -e "${BLUE}================================================${NC}"
echo ""

# Load environment variables from .env file
if [ -f .env ]; then
    while IFS='=' read -r key value; do
        [[ "$key" =~ ^#.*$ ]] && continue
        [[ -z "$key" ]] && continue
        value="${value%\"}"
        value="${value#\"}"
        value="${value%\'}"
        value="${value#\'}"
        value="${value%% #*}"
        export "$key=$value" 2>/dev/null
    done < .env
    echo -e "${GREEN}✅ Loaded environment variables from .env${NC}"
fi

DB_USER=${DB_USER:-tennis_user}
DB_NAME=${DB_NAME:-tennis_ranking}
DB_PASSWORD=${DB_PASSWORD:-tennis_password}
DB_CONTAINER=${DB_CONTAINER:-tennis-postgres}

echo -e "${YELLOW}Database Configuration:${NC}"
echo "  Container: ${DB_CONTAINER}"
echo "  Database:  ${DB_NAME}"
echo "  User:      ${DB_USER}"
echo ""

# Check if container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${DB_CONTAINER}$"; then
    echo -e "${RED}❌ Error: Docker container '${DB_CONTAINER}' is not running${NC}"
    echo "Please start the container first with: docker compose up -d"
    exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 1: Create player_daily_stats table + indexes
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${CYAN}Step 1/4: Creating player_daily_stats table...${NC}"

docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} << 'EOSQL'

-- player_daily_stats: pre-computed per-date stats for each player
-- Each row stores stats for matches ON that specific date (not cumulative).
-- The frontend's daily ranking view queries this table directly instead of
-- running expensive CTE-based aggregation on every request.
--
-- No recent_form column — the frontend computes form separately via
-- getPlayerFormsByDateBatch().

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

-- Index for date-filtered queries (used by daily ranking endpoint)
CREATE INDEX IF NOT EXISTS idx_pds_date ON player_daily_stats(play_date);

-- Composite index for the tie-breaker ORDER BY: points DESC, score_difference DESC
CREATE INDEX IF NOT EXISTS idx_pds_date_points_diff ON player_daily_stats(play_date, points DESC, score_difference DESC);

SELECT 'Table created' as status;
EOSQL

echo -e "${GREEN}✅ Table created${NC}"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Create rebuild function + trigger
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${CYAN}Step 2/4: Creating rebuild function and trigger...${NC}"

docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} << 'EOSQL'

-- =====================================================================
-- Helper: get_match_result_for_player (must exist for rebuild functions)
-- Created by migration 04/06; this is idempotent (safe to re-run)
-- =====================================================================
CREATE OR REPLACE FUNCTION get_match_result_for_player(
    p_player_id INTEGER,
    p_player1_id INTEGER, p_player2_id INTEGER,
    p_player3_id INTEGER, p_player4_id INTEGER,
    p_winning_team INTEGER
) RETURNS TEXT AS $$
BEGIN
    -- Team 1: player1 + player2
    IF p_player_id = p_player1_id OR p_player_id = p_player2_id THEN
        RETURN CASE WHEN p_winning_team = 1 THEN 'win' ELSE 'loss' END;
    END IF;
    -- Team 2: player3 + player4
    IF p_player_id = p_player3_id OR p_player_id = p_player4_id THEN
        RETURN CASE WHEN p_winning_team = 2 THEN 'win' ELSE 'loss' END;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- =====================================================================
-- Rebuild daily stats for one player on one specific date
-- Aggregates from matches WHERE play_date = p_play_date (exact date match)
-- =====================================================================
CREATE OR REPLACE FUNCTION rebuild_player_daily_stats(p_player_id INTEGER, p_play_date DATE)
RETURNS VOID AS $$
DECLARE
    v_wins       INTEGER := 0;
    v_losses     INTEGER := 0;
    v_total      INTEGER := 0;
    v_money      BIGINT  := 0;
    v_score_diff BIGINT := 0;
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
-- Trigger function: rebuild daily stats for all players on affected dates
-- Fires on INSERT/UPDATE/DELETE of matches
-- =====================================================================
CREATE OR REPLACE FUNCTION trg_matches_daily_stats()
RETURNS TRIGGER AS $$
DECLARE
    v_play_date DATE;
    r RECORD;
BEGIN
    -- Determine the play_date from the affected match
    IF TG_OP = 'DELETE' THEN
        v_play_date := OLD.play_date;
    ELSE
        v_play_date := NEW.play_date;
    END IF;

    -- Skip NULL dates (no stats to rebuild)
    IF v_play_date IS NULL THEN
        RETURN NULL;
    END IF;

    -- Rebuild daily stats for all players who currently have matches on this date
    FOR r IN SELECT DISTINCT player_id FROM (
        SELECT player1_id AS player_id FROM matches WHERE play_date = v_play_date AND player1_id IS NOT NULL
        UNION SELECT player2_id FROM matches WHERE play_date = v_play_date AND player2_id IS NOT NULL
        UNION SELECT player3_id FROM matches WHERE play_date = v_play_date AND player3_id IS NOT NULL
        UNION SELECT player4_id FROM matches WHERE play_date = v_play_date AND player4_id IS NOT NULL
    ) sub
    LOOP
        PERFORM rebuild_player_daily_stats(r.player_id, v_play_date);
    END LOOP;

    -- Send cache notification so Redis invalidates rankings:date:* for this date
    PERFORM pg_notify('cache_invalidation', json_build_object(
        'action', 'match_change',
        'date', v_play_date::text
    )::text);

    IF TG_OP = 'DELETE' THEN RETURN OLD;
    ELSE RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Attach trigger to matches table (alphabetically after existing triggers)
DROP TRIGGER IF EXISTS trg_matches_daily_stats ON matches;
CREATE TRIGGER trg_matches_daily_stats
    AFTER INSERT OR UPDATE OR DELETE ON matches
    FOR EACH ROW EXECUTE FUNCTION trg_matches_daily_stats();

SELECT 'Rebuild function and trigger created' as status;
EOSQL

echo -e "${GREEN}✅ Rebuild function and trigger created${NC}"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Step 3: Backfill existing data
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${CYAN}Step 3/4: Backfilling player_daily_stats from existing matches...${NC}"
echo "  (This may take a moment for large databases)"

docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} << 'EOSQL'

-- Backfill: for each unique play_date, rebuild daily stats for all players on that date
DO $$
DECLARE
    v_play_date DATE;
    r RECORD;
    cnt INTEGER := 0;
    date_cnt INTEGER := 0;
BEGIN
    -- First, count unique dates for progress reporting
    SELECT COUNT(DISTINCT m.play_date) INTO date_cnt FROM matches m WHERE m.play_date IS NOT NULL;
    RAISE NOTICE 'Found % unique dates with matches', date_cnt;

    -- Loop through each unique play_date
    FOR v_play_date IN SELECT DISTINCT m.play_date FROM matches m WHERE m.play_date IS NOT NULL LOOP
        -- Rebuild daily stats for all players who played on this date
        FOR r IN (SELECT DISTINCT sub.player_id FROM (
            SELECT m.player1_id AS player_id FROM matches m WHERE m.play_date = v_play_date AND m.player1_id IS NOT NULL
            UNION SELECT m.player2_id FROM matches m WHERE m.play_date = v_play_date AND m.player2_id IS NOT NULL
            UNION SELECT m.player3_id FROM matches m WHERE m.play_date = v_play_date AND m.player3_id IS NOT NULL
            UNION SELECT m.player4_id FROM matches m WHERE m.play_date = v_play_date AND m.player4_id IS NOT NULL
        ) sub)
        LOOP
            PERFORM rebuild_player_daily_stats(r.player_id, v_play_date);
            cnt := cnt + 1;
        END LOOP;
    END LOOP;
    RAISE NOTICE 'Rebuilt daily stats for % player-date combos across % dates', cnt, date_cnt;
END $$;

SELECT 'Backfill complete' as status;
SELECT COUNT(*) as daily_stats_rows FROM player_daily_stats;
EOSQL

echo -e "${GREEN}✅ Backfill complete${NC}"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Step 4: Verification
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${CYAN}Step 4/4: Verifying migration...${NC}"

docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} << 'EOSQL'
SELECT '=== Verification ===' as info;

-- Check table exists
SELECT 'player_daily_stats columns:' as check_type;
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'player_daily_stats'
ORDER BY ordinal_position;

-- Check indexes
SELECT 'Indexes:' as check_type;
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'player_daily_stats';

-- Check trigger
SELECT 'Triggers on matches:' as check_type;
SELECT trigger_name, event_manipulation, action_statement
FROM information_schema.triggers
WHERE event_object_table = 'matches' AND trigger_name = 'trg_matches_daily_stats';

-- Spot-check: compare one date's rankings between summary table and live CTE query
SELECT '=== Spot Check (first date with matches) ===' as info;
WITH live AS (
    SELECT
        p.id, p.name,
        COUNT(CASE WHEN get_match_result_for_player(p.id, m.player1_id, m.player2_id, m.player3_id, m.player4_id, m.winning_team) = 'win' THEN 1 END) as wins,
        COUNT(CASE WHEN get_match_result_for_player(p.id, m.player1_id, m.player2_id, m.player3_id, m.player4_id, m.winning_team) = 'loss' THEN 1 END) as losses,
        COUNT(*) as total_matches,
        COALESCE(SUM(
            CASE WHEN get_match_result_for_player(p.id, m.player1_id, m.player2_id, m.player3_id, m.player4_id, m.winning_team) = 'loss'
            THEN COALESCE(s.lose_money_per_loss, 20000) ELSE 0 END
        ), 0) as money_lost,
        COALESCE(SUM(
            CASE WHEN p.id = m.player1_id OR p.id = m.player2_id
                THEN m.team1_score - m.team2_score
                WHEN p.id = m.player3_id OR p.id = m.player4_id
                    THEN m.team2_score - m.team1_score
            END
        ), 0) as score_diff
    FROM matches m
    JOIN seasons s ON m.season_id = s.id
    JOIN players p ON p.id = m.player1_id OR p.id = m.player2_id OR p.id = m.player3_id OR p.id = m.player4_id
    GROUP BY p.id, p.name, m.play_date
    ORDER BY m.play_date LIMIT 1
)
SELECT
    l.play_date, l.id, l.name,
    l.wins, l.losses, l.total_matches, l.money_lost, l.score_diff,
    ds.wins as ds_wins, ds.losses as ds_losses, ds.total_matches as ds_total, ds.money_lost as ds_money, ds.score_difference as ds_score_diff,
    CASE WHEN l.wins = ds.wins AND l.losses = ds.losses AND l.score_diff = ds.score_difference
         THEN '✅ MATCH' ELSE '❌ MISMATCH' END as verification
FROM (
    SELECT
        m.play_date,
        p.id, p.name,
        COUNT(*) as total_matches,
        COUNT(CASE WHEN get_match_result_for_player(p.id, m.player1_id, m.player2_id, m.player3_id, m.player4_id, m.winning_team) = 'win' THEN 1 END) as wins,
        COUNT(CASE WHEN get_match_result_for_player(p.id, m.player1_id, m.player2_id, m.player3_id, m.player4_id, m.winning_team) = 'loss' THEN 1 END) as losses,
        COALESCE(SUM(
            CASE WHEN get_match_result_for_player(p.id, m.player1_id, m.player2_id, m.player3_id, m.player4_id, m.winning_team) = 'loss'
            THEN COALESCE(s.lose_money_per_loss, 20000) ELSE 0 END
        ), 0) as money_lost,
        COALESCE(SUM(
            CASE WHEN p.id = m.player1_id OR p.id = m.player2_id
                THEN m.team1_score - m.team2_score
                WHEN p.id = m.player3_id OR p.id = m.player4_id
                    THEN m.team2_score - m.team1_score
            END
        ), 0) as score_diff
    FROM matches m
    JOIN seasons s ON m.season_id = s.id
    JOIN players p ON p.id = m.player1_id OR p.id = m.player2_id OR p.id = m.player3_id OR p.id = m.player4_id
    GROUP BY p.id, p.name, m.play_date
    ORDER BY m.play_date LIMIT 1
) l
LEFT JOIN player_daily_stats ds ON ds.player_id = l.id AND ds.play_date = l.play_date;

SELECT '=== Migration Complete ===' as info;
EOSQL

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}================================================${NC}"
    echo -e "${GREEN}  ✅ Daily Stats Migration Complete!${NC}"
    echo -e "${GREEN}================================================${NC}"
    echo ""
    echo -e "${YELLOW}What changed:${NC}"
    echo "  • player_daily_stats — new summary table (per player, per date)"
    echo "  • rebuild_player_daily_stats() — PL/pgSQL function"
    echo "  • trg_matches_daily_stats() — auto-rebuilds on match changes"
    echo "  • Composite index: (play_date, points DESC, score_difference DESC)"
    echo ""
    echo -e "${BLUE}Next: Restart server to use optimized daily queries${NC}"
else
    echo ""
    echo -e "${RED}================================================${NC}"
    echo -e "${RED}  ❌ Migration failed!${NC}"
    echo -e "${RED}================================================${NC}"
    exit 1
fi
