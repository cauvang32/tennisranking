#!/bin/bash
# Migration Script: Add score_difference to Ranking Summary Tables
# Version: 6.0.0
# Purpose: Track score differential (rounds won - rounds lost) for tie-breaking
#
# This migration:
#   1. Adds score_difference column to player_lifetime_stats and player_season_stats
#   2. Updates rebuild functions to compute score_difference
#   3. Backfills existing data
#   4. Verifies accuracy

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}  Score Difference Migration${NC}"
echo -e "${BLUE}  Version 6.0.0${NC}"
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
# Step 1: Add score_difference column to summary tables
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${CYAN}Step 1/4: Adding score_difference columns...${NC}"

docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} << 'EOSQL'

-- Add score_difference column to lifetime stats (BIGINT to avoid overflow across many matches)
ALTER TABLE player_lifetime_stats ADD COLUMN IF NOT EXISTS score_difference BIGINT DEFAULT 0;

-- Add score_difference column to season stats (BIGINT to avoid overflow across many matches)
ALTER TABLE player_season_stats ADD COLUMN IF NOT EXISTS score_difference BIGINT DEFAULT 0;

-- Composite index for the tie-breaker ORDER BY: points DESC, score_difference DESC
DROP INDEX IF EXISTS idx_pls_score_diff;
DROP INDEX IF EXISTS idx_pss_score_diff;
CREATE INDEX IF NOT EXISTS idx_pls_points_diff ON player_lifetime_stats(points DESC, score_difference DESC);
CREATE INDEX IF NOT EXISTS idx_pss_points_diff ON player_season_stats(points DESC, score_difference DESC);

SELECT 'Columns added' as status;
EOSQL

echo -e "${GREEN}✅ Columns added${NC}"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Update rebuild functions to compute score_difference
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${CYAN}Step 2/4: Updating rebuild functions...${NC}"

docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} << 'EOSQL'

-- =====================================================================
-- Helper: get_match_result_for_player (must exist for rebuild functions)
-- Created by migration 04; this is idempotent (safe to re-run)
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
-- Updated Rebuild lifetime stats: now computes score_difference
-- score_difference = SUM(won_score - lost_score) across all matches
-- =====================================================================
CREATE OR REPLACE FUNCTION rebuild_player_lifetime_stats(p_player_id INTEGER)
RETURNS VOID AS $$
DECLARE
    v_wins       INTEGER := 0;
    v_losses     INTEGER := 0;
    v_total      INTEGER := 0;
    v_money      BIGINT  := 0;
    v_score_diff BIGINT := 0;
    v_form       JSONB;
BEGIN
    -- Aggregate from all matches
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
        -- NEW: score_difference (BIGINT to avoid overflow across many matches)
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
    WHERE m.player1_id = p_player_id OR m.player2_id = p_player_id
       OR m.player3_id = p_player_id OR m.player4_id = p_player_id;

    -- Recent form (last 5 matches)
    SELECT COALESCE(jsonb_agg(sub.obj ORDER BY sub.rn), '[]'::jsonb)
    INTO v_form
    FROM (
        SELECT
            jsonb_build_object(
                'result', get_match_result_for_player(
                    p_player_id, m.player1_id, m.player2_id, m.player3_id, m.player4_id, m.winning_team
                ),
                'play_date', TO_CHAR(m.play_date, 'YYYY-MM-DD')
            ) AS obj,
            ROW_NUMBER() OVER (ORDER BY m.play_date DESC, m.created_at DESC) AS rn
        FROM matches m
        WHERE m.player1_id = p_player_id OR m.player2_id = p_player_id
           OR m.player3_id = p_player_id OR m.player4_id = p_player_id
    ) sub
    WHERE sub.rn <= 5;

    -- Upsert
    INSERT INTO player_lifetime_stats (player_id, wins, losses, total_matches, money_lost, points, score_difference, recent_form, updated_at)
    VALUES (p_player_id, v_wins, v_losses, v_total, v_money, v_wins * 4 + v_losses, v_score_diff, v_form, NOW())
    ON CONFLICT (player_id) DO UPDATE SET
        wins = EXCLUDED.wins,
        losses = EXCLUDED.losses,
        total_matches = EXCLUDED.total_matches,
        money_lost = EXCLUDED.money_lost,
        points = EXCLUDED.points,
        score_difference = EXCLUDED.score_difference,
        recent_form = EXCLUDED.recent_form,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- Updated Rebuild season stats: now computes score_difference
-- =====================================================================
CREATE OR REPLACE FUNCTION rebuild_player_season_stats(p_player_id INTEGER, p_season_id INTEGER)
RETURNS VOID AS $$
DECLARE
    v_wins       INTEGER := 0;
    v_losses     INTEGER := 0;
    v_total      INTEGER := 0;
    v_money      BIGINT  := 0;
    v_score_diff BIGINT := 0;
    v_lm         INTEGER;
BEGIN
    -- Get season lose_money config
    SELECT COALESCE(lose_money_per_loss, 20000) INTO v_lm FROM seasons WHERE id = p_season_id;
    IF v_lm IS NULL THEN v_lm := 20000; END IF;

    SELECT
        COUNT(*) FILTER (WHERE get_match_result_for_player(
            p_player_id, m.player1_id, m.player2_id, m.player3_id, m.player4_id, m.winning_team
        ) = 'win'),
        COUNT(*) FILTER (WHERE get_match_result_for_player(
            p_player_id, m.player1_id, m.player2_id, m.player3_id, m.player4_id, m.winning_team
        ) = 'loss'),
        COUNT(*),
        -- NEW: score_difference (BIGINT to avoid overflow across many matches)
        COALESCE(SUM(
            CASE
                WHEN p_player_id = m.player1_id OR p_player_id = m.player2_id
                    THEN m.team1_score - m.team2_score
                WHEN p_player_id = m.player3_id OR p_player_id = m.player4_id
                    THEN m.team2_score - m.team1_score
            END
        ), 0)
    INTO v_wins, v_losses, v_total, v_score_diff
    FROM matches m
    WHERE m.season_id = p_season_id
      AND (m.player1_id = p_player_id OR m.player2_id = p_player_id
        OR m.player3_id = p_player_id OR m.player4_id = p_player_id);

    v_money := v_losses::bigint * v_lm;

    INSERT INTO player_season_stats (player_id, season_id, wins, losses, total_matches, money_lost, points, score_difference, updated_at)
    VALUES (p_player_id, p_season_id, v_wins, v_losses, v_total, v_money, v_wins * 4 + v_losses, v_score_diff, NOW())
    ON CONFLICT (player_id, season_id) DO UPDATE SET
        wins = EXCLUDED.wins,
        losses = EXCLUDED.losses,
        total_matches = EXCLUDED.total_matches,
        money_lost = EXCLUDED.money_lost,
        points = EXCLUDED.points,
        score_difference = EXCLUDED.score_difference,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

SELECT 'Rebuild functions updated' as status;
EOSQL

echo -e "${GREEN}✅ Rebuild functions updated${NC}"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Step 3: Backfill existing data
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${CYAN}Step 3/4: Backfilling score_difference from existing matches...${NC}"
echo "  (This may take a moment for large databases)"

docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} << 'EOSQL'

-- Rebuild lifetime stats for every player (now includes score_difference)
DO $$
DECLARE
    r RECORD;
    cnt INTEGER := 0;
BEGIN
    FOR r IN SELECT id FROM players LOOP
        PERFORM rebuild_player_lifetime_stats(r.id);
        cnt := cnt + 1;
    END LOOP;
    RAISE NOTICE 'Rebuilt lifetime stats for % players', cnt;
END $$;

-- Rebuild season stats for every (player, season) (now includes score_difference)
DO $$
DECLARE
    r RECORD;
    cnt INTEGER := 0;
BEGIN
    FOR r IN SELECT DISTINCT player_id, season_id FROM season_players LOOP
        PERFORM rebuild_player_season_stats(r.player_id, r.season_id);
        cnt := cnt + 1;
    END LOOP;
    -- Also rebuild for players who played in a season but aren't in season_players
    FOR r IN
        SELECT DISTINCT sub.player_id, m.season_id
        FROM matches m
        CROSS JOIN LATERAL (
            SELECT m.player1_id AS player_id UNION SELECT m.player2_id WHERE m.player2_id IS NOT NULL
            UNION SELECT m.player3_id UNION SELECT m.player4_id WHERE m.player4_id IS NOT NULL
        ) sub
        WHERE NOT EXISTS (
            SELECT 1 FROM player_season_stats pss
            WHERE pss.player_id = sub.player_id AND pss.season_id = m.season_id
        )
    LOOP
        PERFORM rebuild_player_season_stats(r.player_id, r.season_id);
        cnt := cnt + 1;
    END LOOP;
    RAISE NOTICE 'Rebuilt season stats for % player-season combos', cnt;
END $$;

SELECT 'Backfill complete' as status;
SELECT COUNT(*) as lifetime_rows FROM player_lifetime_stats;
SELECT COUNT(*) as season_rows FROM player_season_stats;
EOSQL

echo -e "${GREEN}✅ Backfill complete${NC}"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Step 4: Verification
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${CYAN}Step 4/4: Verifying migration...${NC}"

docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} << 'EOSQL'
SELECT '=== Verification ===' as info;

-- Check columns exist
SELECT 'player_lifetime_stats columns:' as check_type;
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'player_lifetime_stats' AND column_name = 'score_difference';

SELECT 'player_season_stats columns:' as check_type;
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'player_season_stats' AND column_name = 'score_difference';

-- Spot-check: compare one player's score_difference between summary and live calculation
SELECT '=== Spot Check (first player with score_difference != 0) ===' as info;
WITH live AS (
    SELECT
        p.id, p.name,
        COALESCE(SUM(
            CASE
                WHEN p.id = m.player1_id OR p.id = m.player2_id
                    THEN m.team1_score - m.team2_score
                WHEN p.id = m.player3_id OR p.id = m.player4_id
                    THEN m.team2_score - m.team1_score
            END
        ), 0) as live_score_diff
    FROM players p
    LEFT JOIN matches m ON m.player1_id = p.id OR m.player2_id = p.id
                     OR m.player3_id = p.id OR m.player4_id = p.id
    GROUP BY p.id, p.name
    HAVING COALESCE(SUM(
        CASE
            WHEN p.id = m.player1_id OR p.id = m.player2_id
                THEN m.team1_score - m.team2_score
            WHEN p.id = m.player3_id OR p.id = m.player4_id
                THEN m.team2_score - m.team1_score
        END
    ), 0) != 0
    ORDER BY p.id LIMIT 3
)
SELECT
    live.id, live.name,
    live.live_score_diff, pls.score_difference as summary_score_diff,
    CASE WHEN live.live_score_diff = pls.score_difference
         THEN '✅ MATCH' ELSE '❌ MISMATCH' END as verification
FROM live
LEFT JOIN player_lifetime_stats pls ON pls.player_id = live.id;

SELECT '=== Migration Complete ===' as info;
EOSQL

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}================================================${NC}"
    echo -e "${GREEN}  ✅ Score Difference Migration Complete!${NC}"
    echo -e "${GREEN}================================================${NC}"
    echo ""
    echo -e "${YELLOW}What changed:${NC}"
    echo "  • player_lifetime_stats — added score_difference column"
    echo "  • player_season_stats — added score_difference column"
    echo "  • Rebuild functions — now compute score_difference"
    echo "  • Tie-breaker: points DESC → score_difference DESC → win_percentage DESC → name ASC"
    echo ""
    echo -e "${BLUE}Next: Restart server to use new tie-breaker${NC}"
else
    echo ""
    echo -e "${RED}================================================${NC}"
    echo -e "${RED}  ❌ Migration failed!${NC}"
    echo -e "${RED}================================================${NC}"
    exit 1
fi
