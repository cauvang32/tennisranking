#!/bin/bash
# Migration Script: Add Composite Indexes for Ranking Queries
# Version: 6.0.0
# Purpose: Add (player_id, play_date DESC) composite indexes for all 4 player columns.
#          Reduces ranking query I/O by 4x (single index scan vs 4 separate scans).
#
# This migration creates:
#   1. idx_matches_player1_date — (player1_id, play_date DESC) WHERE player2_id IS NOT NULL
#   2. idx_matches_player2_date — (player2_id, play_date DESC) WHERE player2_id IS NOT NULL
#   3. idx_matches_player3_date — (player3_id, play_date DESC)
#   4. idx_matches_player4_date — (player4_id, play_date DESC) WHERE player4_id IS NOT NULL
#   5. idx_matches_winning_team — (winning_team)

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}  Composite Index Migration (Ranking Optimization)${NC}"
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

echo -e "${CYAN}Creating composite indexes (idempotent)...${NC}"

docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} << 'EOSQL'

-- Composite indexes: (player_id, play_date DESC) for all 4 player columns.
-- These allow PostgreSQL to use a single index scan per player column
-- instead of scanning all matches and filtering in memory.

-- player1 and player3 are always present (required for both solo and duo)
CREATE INDEX IF NOT EXISTS idx_matches_player3_date ON matches (player3_id, play_date DESC);
CREATE INDEX IF NOT EXISTS idx_matches_player1_date ON matches (player1_id, play_date DESC) WHERE player2_id IS NOT NULL;

-- player2 and player4 are optional (only for duo matches)
CREATE INDEX IF NOT EXISTS idx_matches_player2_date ON matches (player2_id, play_date DESC) WHERE player2_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_matches_player4_date ON matches (player4_id, play_date DESC) WHERE player4_id IS NOT NULL;

-- Index on winning_team for ranking calculations
CREATE INDEX IF NOT EXISTS idx_matches_winning_team ON matches (winning_team);

-- Verify indexes were created
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE tablename = 'matches'
  AND indexname LIKE 'idx_matches_%date%'
  OR indexname = 'idx_matches_winning_team'
ORDER BY indexname;

EOSQL

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}================================================${NC}"
    echo -e "${GREEN}  ✅ Composite Index Migration Complete!${NC}"
    echo -e "${GREEN}================================================${NC}"
    echo ""
    echo -e "${YELLOW}Indexes created:${NC}"
    echo "  • idx_matches_player1_date  — (player1_id, play_date DESC) WHERE player2_id IS NOT NULL"
    echo "  • idx_matches_player2_date  — (player2_id, play_date DESC) WHERE player2_id IS NOT NULL"
    echo "  • idx_matches_player3_date  — (player3_id, play_date DESC)"
    echo "  • idx_matches_player4_date  — (player4_id, play_date DESC) WHERE player4_id IS NOT NULL"
    echo "  • idx_matches_winning_team  — (winning_team)"
    echo ""
    echo -e "${BLUE}Next: Restart server to benefit from optimized queries${NC}"
else
    echo ""
    echo -e "${RED}================================================${NC}"
    echo -e "${RED}  ❌ Migration failed!${NC}"
    echo -e "${RED}================================================${NC}"
    exit 1
fi
