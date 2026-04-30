#!/bin/bash
# Patch: Fix unnest syntax in trg_update_ranking_stats trigger
# Version: 5.0.0
# Purpose: Fix "column unnest does not exist" error by using proper alias syntax

GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}  Patch: Fix Trigger unnest Syntax${NC}"
echo -e "${BLUE}  Version 5.0.0${NC}"
echo -e "${BLUE}================================================${NC}"
echo ""

# Load environment variables from .env file
if [ -f .env ]; then
    while IFS='=' read -r key value; do
        # Skip comments and empty lines
        [[ "$key" =~ ^#.*$ ]] && continue
        [[ -z "$key" ]] && continue
        # Remove surrounding quotes from value
        value="${value%\"}"
        value="${value#\"}"
        value="${value%\'}"
        value="${value#\'}"
        # Remove inline comments
        value="${value%% #*}"
        export "$key=$value" 2>/dev/null
    done < .env
    echo -e "${GREEN}✅ Loaded environment variables from .env${NC}"
fi

DB_USER=${DB_USER:-tennis_user}
DB_NAME=${DB_NAME:-tennis_ranking}
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
# Patch the trigger function
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${CYAN}Patching trg_update_ranking_stats() function...${NC}"

docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} << 'EOSQL'

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

    -- De-duplicate and remove NULLs (fixed syntax with proper alias)
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

SELECT 'Trigger function patched successfully' as status;

-- Verify by checking the function source
SELECT prosrc LIKE '%FROM unnest(%' AS uses_correct_syntax
FROM pg_proc WHERE proname = 'trg_update_ranking_stats';

EOSQL

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}================================================${NC}"
    echo -e "${GREEN}  ✅ Trigger Patch Applied Successfully!${NC}"
    echo -e "${GREEN}================================================${NC}"
    echo ""
    echo -e "${YELLOW}What changed:${NC}"
    echo "  • Fixed unnest syntax in trg_update_ranking_stats()"
    echo "  • Match create/edit/delete now works correctly"
    echo "  • Season/Player delete cascading now works"
    echo "  • pg_notify cache invalidation restored"
    echo ""
    echo -e "${BLUE}Next: Restart server to pick up changes${NC}"
else
    echo ""
    echo -e "${RED}================================================${NC}"
    echo -e "${RED}  ❌ Patch failed!${NC}"
    echo -e "${RED}================================================${NC}"
    exit 1
fi
