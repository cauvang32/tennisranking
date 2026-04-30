#!/bin/bash
# Migration Script: Add Ranking Summary Tables + Triggers
# Version: 4.0.0
# Purpose: Optimize ranking queries by pre-computing player stats
#
# This migration creates:
#   1. player_season_stats — pre-aggregated per-season stats
#   2. player_lifetime_stats — pre-aggregated lifetime stats with recent_form
#   3. Trigger function to auto-update stats on match INSERT/UPDATE/DELETE
#   4. Backfill existing data from matches table

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}  Ranking Summary Tables Migration${NC}"
echo -e "${BLUE}  Version 4.0.0${NC}"
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
# Step 1: Create summary tables
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${CYAN}Step 1/4: Creating summary tables...${NC}"

docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} << 'EOSQL'

-- player_season_stats: pre-computed per-season stats for each player
CREATE TABLE IF NOT EXISTS player_season_stats (
    player_id   INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    season_id   INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    wins        INTEGER NOT NULL DEFAULT 0,
    losses      INTEGER NOT NULL DEFAULT 0,
    total_matches INTEGER NOT NULL DEFAULT 0,
    money_lost  BIGINT  NOT NULL DEFAULT 0,
    points      INTEGER NOT NULL DEFAULT 0,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (player_id, season_id)
);

CREATE INDEX IF NOT EXISTS idx_pss_season ON player_season_stats(season_id);
CREATE INDEX IF NOT EXISTS idx_pss_points ON player_season_stats(points DESC);

-- player_lifetime_stats: pre-computed lifetime aggregate for each player
CREATE TABLE IF NOT EXISTS player_lifetime_stats (
    player_id     INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
    wins          INTEGER NOT NULL DEFAULT 0,
    losses        INTEGER NOT NULL DEFAULT 0,
    total_matches INTEGER NOT NULL DEFAULT 0,
    money_lost    BIGINT  NOT NULL DEFAULT 0,
    points        INTEGER NOT NULL DEFAULT 0,
    recent_form   JSONB   DEFAULT '[]'::jsonb,
    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pls_points ON player_lifetime_stats(points DESC);

SELECT 'Summary tables created' as status;
EOSQL

echo -e "${GREEN}✅ Summary tables created${NC}"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Create helper functions
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${CYAN}Step 2/4: Creating helper + trigger functions...${NC}"

docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} << 'EOSQL'

-- =====================================================================
-- Helper: determine if a player won or lost a specific match
-- Returns 'win', 'loss', or NULL if the player was not in the match
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
-- Rebuild lifetime stats for ONE player from scratch
-- Keeps result 100% accurate — used by trigger and backfill
-- =====================================================================
CREATE OR REPLACE FUNCTION rebuild_player_lifetime_stats(p_player_id INTEGER)
RETURNS VOID AS $$
DECLARE
    v_wins     INTEGER := 0;
    v_losses   INTEGER := 0;
    v_total    INTEGER := 0;
    v_money    BIGINT  := 0;
    v_form     JSONB;
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
        ), 0)
    INTO v_wins, v_losses, v_total, v_money
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
    INSERT INTO player_lifetime_stats (player_id, wins, losses, total_matches, money_lost, points, recent_form, updated_at)
    VALUES (p_player_id, v_wins, v_losses, v_total, v_money, v_wins * 4 + v_losses, v_form, NOW())
    ON CONFLICT (player_id) DO UPDATE SET
        wins = EXCLUDED.wins,
        losses = EXCLUDED.losses,
        total_matches = EXCLUDED.total_matches,
        money_lost = EXCLUDED.money_lost,
        points = EXCLUDED.points,
        recent_form = EXCLUDED.recent_form,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- Rebuild season stats for ONE player in ONE season
-- =====================================================================
CREATE OR REPLACE FUNCTION rebuild_player_season_stats(p_player_id INTEGER, p_season_id INTEGER)
RETURNS VOID AS $$
DECLARE
    v_wins     INTEGER := 0;
    v_losses   INTEGER := 0;
    v_total    INTEGER := 0;
    v_money    BIGINT  := 0;
    v_lm       INTEGER;
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
        COUNT(*)
    INTO v_wins, v_losses, v_total
    FROM matches m
    WHERE m.season_id = p_season_id
      AND (m.player1_id = p_player_id OR m.player2_id = p_player_id
        OR m.player3_id = p_player_id OR m.player4_id = p_player_id);

    v_money := v_losses::bigint * v_lm;

    INSERT INTO player_season_stats (player_id, season_id, wins, losses, total_matches, money_lost, points, updated_at)
    VALUES (p_player_id, p_season_id, v_wins, v_losses, v_total, v_money, v_wins * 4 + v_losses, NOW())
    ON CONFLICT (player_id, season_id) DO UPDATE SET
        wins = EXCLUDED.wins,
        losses = EXCLUDED.losses,
        total_matches = EXCLUDED.total_matches,
        money_lost = EXCLUDED.money_lost,
        points = EXCLUDED.points,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- TRIGGER FUNCTION: called after INSERT / UPDATE / DELETE on matches
-- Re-calculates stats for all players involved in the affected match(es)
-- =====================================================================
CREATE OR REPLACE FUNCTION trg_update_ranking_stats()
RETURNS TRIGGER AS $$
DECLARE
    affected_player_ids INTEGER[];
    affected_season_ids INTEGER[];
    pid INTEGER;
    sid INTEGER;
BEGIN
    -- Collect player IDs from both OLD and NEW rows
    IF TG_OP = 'DELETE' THEN
        affected_player_ids := ARRAY[OLD.player1_id, OLD.player2_id, OLD.player3_id, OLD.player4_id];
        affected_season_ids := ARRAY[OLD.season_id];
    ELSIF TG_OP = 'INSERT' THEN
        affected_player_ids := ARRAY[NEW.player1_id, NEW.player2_id, NEW.player3_id, NEW.player4_id];
        affected_season_ids := ARRAY[NEW.season_id];
    ELSE -- UPDATE
        affected_player_ids := ARRAY[
            OLD.player1_id, OLD.player2_id, OLD.player3_id, OLD.player4_id,
            NEW.player1_id, NEW.player2_id, NEW.player3_id, NEW.player4_id
        ];
        affected_season_ids := ARRAY[OLD.season_id, NEW.season_id];
    END IF;

    -- De-duplicate and remove NULLs (use alias to avoid ambiguity)
    affected_player_ids := ARRAY(SELECT DISTINCT val FROM unnest(affected_player_ids) AS val WHERE val IS NOT NULL);
    affected_season_ids := ARRAY(SELECT DISTINCT val FROM unnest(affected_season_ids) AS val WHERE val IS NOT NULL);

    -- Rebuild lifetime stats for each affected player
    FOREACH pid IN ARRAY affected_player_ids LOOP
        PERFORM rebuild_player_lifetime_stats(pid);
    END LOOP;

    -- Rebuild season stats for each (player, season) combo
    FOREACH pid IN ARRAY affected_player_ids LOOP
        FOREACH sid IN ARRAY affected_season_ids LOOP
            PERFORM rebuild_player_season_stats(pid, sid);
        END LOOP;
    END LOOP;

    -- Notify cache invalidation channel (existing PG NOTIFY system)
    PERFORM pg_notify('cache_invalidation', json_build_object(
        'table', 'matches',
        'action', TG_OP,
        'date', COALESCE(
            CASE WHEN TG_OP = 'DELETE' THEN TO_CHAR(OLD.play_date, 'YYYY-MM-DD')
                 ELSE TO_CHAR(NEW.play_date, 'YYYY-MM-DD')
            END, ''
        )
    )::text);

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Attach trigger (drop first for idempotency)
DROP TRIGGER IF EXISTS trg_matches_ranking_stats ON matches;
CREATE TRIGGER trg_matches_ranking_stats
    AFTER INSERT OR UPDATE OR DELETE ON matches
    FOR EACH ROW
    EXECUTE FUNCTION trg_update_ranking_stats();

SELECT 'Trigger functions created and attached' as status;
EOSQL

echo -e "${GREEN}✅ Trigger functions created${NC}"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Step 3: Backfill existing data
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${CYAN}Step 3/4: Backfilling summary data from existing matches...${NC}"
echo "  (This may take a moment for large databases)"

docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} << 'EOSQL'

-- Clear and rebuild all stats from scratch
TRUNCATE player_lifetime_stats;
TRUNCATE player_season_stats;

-- Rebuild lifetime stats for every player
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

-- Rebuild season stats for every (player, season) in season_players
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

-- Check table existence
SELECT 'player_lifetime_stats:' as table_name, COUNT(*) as rows FROM player_lifetime_stats
UNION ALL
SELECT 'player_season_stats:', COUNT(*) FROM player_season_stats;

-- Spot-check: compare one player's stats between summary and live calculation
SELECT '=== Spot Check (first player) ===' as info;
WITH live AS (
    SELECT
        p.id, p.name,
        COUNT(*) FILTER (WHERE
            (m.winning_team = 1 AND (m.player1_id = p.id OR m.player2_id = p.id)) OR
            (m.winning_team = 2 AND (m.player3_id = p.id OR m.player4_id = p.id))
        ) as live_wins,
        COUNT(*) FILTER (WHERE
            (m.winning_team = 2 AND (m.player1_id = p.id OR m.player2_id = p.id)) OR
            (m.winning_team = 1 AND (m.player3_id = p.id OR m.player4_id = p.id))
        ) as live_losses
    FROM players p
    LEFT JOIN matches m ON m.player1_id = p.id OR m.player2_id = p.id OR m.player3_id = p.id OR m.player4_id = p.id
    GROUP BY p.id, p.name
    ORDER BY p.id LIMIT 3
)
SELECT
    live.id, live.name,
    live.live_wins, pls.wins as summary_wins,
    live.live_losses, pls.losses as summary_losses,
    CASE WHEN live.live_wins = pls.wins AND live.live_losses = pls.losses
         THEN '✅ MATCH' ELSE '❌ MISMATCH' END as verification
FROM live
LEFT JOIN player_lifetime_stats pls ON pls.player_id = live.id;

-- Check trigger exists
SELECT '=== Trigger check ===' as info;
SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = 'trg_matches_ranking_stats';

SELECT '=== Migration Complete ===' as info;
EOSQL

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}================================================${NC}"
    echo -e "${GREEN}  ✅ Ranking Summary Migration Complete!${NC}"
    echo -e "${GREEN}================================================${NC}"
    echo ""
    echo -e "${YELLOW}What changed:${NC}"
    echo "  • player_lifetime_stats — pre-computed lifetime rankings"
    echo "  • player_season_stats — pre-computed per-season rankings"
    echo "  • Trigger on matches — auto-updates stats on insert/update/delete"
    echo ""
    echo -e "${BLUE}Next: Restart server to use optimized queries${NC}"
else
    echo ""
    echo -e "${RED}================================================${NC}"
    echo -e "${RED}  ❌ Migration failed!${NC}"
    echo -e "${RED}================================================${NC}"
    exit 1
fi
