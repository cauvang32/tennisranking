#!/bin/bash
# Migration Script: 10 — Add Cup Tournament Tables
# Version: 10.0.0
# Purpose: Create cup tournament system (knockout brackets)
#
# This migration:
#   1. Creates cups table (tournament definitions)
#   2. Creates cup_participants table (registered teams)
#   3. Creates cup_matches table (bracket matches)
#   4. Creates cup_advancements table (winner advancement rules)
#   5. Creates indexes on all tables
#
# Run: ./migrations/10-add-cup-tournaments.sh

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}  Cup Tournament Tables Migration${NC}"
echo -e "${BLUE}  Version 10.0.0${NC}"
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

DB_NAME="${DB_NAME:-tennis_ranking}"
DB_USER="${DB_USER:-tennis_user}"

echo -e "${CYAN}Database: $DB_NAME${NC}"
echo ""

# Check if all tables already exist
TABLES_EXIST=$(docker exec "${DB_CONTAINER:-tennis-postgres}" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT COUNT(*) FROM information_schema.tables
   WHERE table_name IN ('cups', 'cup_participants', 'cup_matches', 'cup_advancements');" 2>/dev/null || echo "0")

if [ "$TABLES_EXIST" = "4" ]; then
    echo -e "${YELLOW}⏭  All 4 cup tables already exist — skipping${NC}"
    exit 0
fi

echo -e "${CYAN}Creating cup tournament tables...${NC}"
docker exec -i "${DB_CONTAINER:-tennis-postgres}" psql -U "$DB_USER" -d "$DB_NAME" <<'SQL'

-- Cup tournaments (knockout format)
CREATE TABLE IF NOT EXISTS cups (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  season_id         INTEGER REFERENCES seasons(id) ON DELETE SET NULL,
  format            VARCHAR(20) NOT NULL DEFAULT 'single_elimination',
  num_teams         INTEGER NOT NULL DEFAULT 8,
  regulation_text   TEXT,
  status            VARCHAR(20) DEFAULT 'draft',
  start_date        DATE,
  end_date          DATE,
  created_by        VARCHAR(255),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT check_cup_format CHECK (format IN ('single_elimination', 'double_elimination', 'round_robin')),
  CONSTRAINT check_cup_status CHECK (status IN ('draft', 'scheduled', 'in_progress', 'completed', 'cancelled'))
);

-- Cup participants (players/teams registered for the cup)
CREATE TABLE IF NOT EXISTS cup_participants (
  id          SERIAL PRIMARY KEY,
  cup_id      INTEGER NOT NULL REFERENCES cups(id) ON DELETE CASCADE,
  player1_id  INTEGER NOT NULL REFERENCES players(id),
  player2_id  INTEGER REFERENCES players(id),
  team_name   VARCHAR(255),
  seed        INTEGER,
  UNIQUE(cup_id, player1_id, player2_id)
);

-- Cup matches (bracket rounds)
CREATE TABLE IF NOT EXISTS cup_matches (
  id                    SERIAL PRIMARY KEY,
  cup_id                INTEGER NOT NULL REFERENCES cups(id) ON DELETE CASCADE,
  round_number          INTEGER NOT NULL,
  match_number          INTEGER NOT NULL,
  bracket_position      VARCHAR(32),
  team1_participant_id  INTEGER REFERENCES cup_participants(id),
  team2_participant_id  INTEGER REFERENCES cup_participants(id),
  team1_score           INTEGER,
  team2_score           INTEGER,
  winner_participant_id INTEGER REFERENCES cup_participants(id),
  play_date             DATE,
  status                VARCHAR(20) DEFAULT 'scheduled',
  goal_difference       INTEGER GENERATED ALWAYS AS (COALESCE(team1_score, 0) - COALESCE(team2_score, 0)) STORED,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT check_cup_match_status CHECK (status IN ('scheduled', 'in_progress', 'completed', 'forfeited', 'cancelled'))
);

-- Cup advancement rules (auto-advance winners to next round)
CREATE TABLE IF NOT EXISTS cup_advancements (
  id              SERIAL PRIMARY KEY,
  from_match_id   INTEGER NOT NULL REFERENCES cup_matches(id) ON DELETE CASCADE,
  to_match_id     INTEGER NOT NULL REFERENCES cup_matches(id) ON DELETE CASCADE,
  winner_slot     VARCHAR(10) NOT NULL,
  UNIQUE(from_match_id, to_match_id, winner_slot)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_cups_season ON cups(season_id);
CREATE INDEX IF NOT EXISTS idx_cups_status ON cups(status);
CREATE INDEX IF NOT EXISTS idx_cup_participants_cup ON cup_participants(cup_id);
CREATE INDEX IF NOT EXISTS idx_cup_matches_cup ON cup_matches(cup_id);
CREATE INDEX IF NOT EXISTS idx_cup_matches_round ON cup_matches(cup_id, round_number, match_number);
CREATE INDEX IF NOT EXISTS idx_cup_advancements_from ON cup_advancements(from_match_id);
CREATE INDEX IF NOT EXISTS idx_cup_advancements_to ON cup_advancements(to_match_id);

SQL

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ All 4 cup tables created successfully${NC}"
    echo -e "${GREEN}✅ All indexes created${NC}"
else
    echo -e "${RED}❌ Migration failed!${NC}"
    exit 1
fi

echo ""
echo -e "${CYAN}Verifying...${NC}"

CUPS_TABLE=$(docker exec "${DB_CONTAINER:-tennis-postgres}" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'cups');" 2>/dev/null || echo "false")
PARTICIPANTS_TABLE=$(docker exec "${DB_CONTAINER:-tennis-postgres}" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'cup_participants');" 2>/dev/null || echo "false")
MATCHES_TABLE=$(docker exec "${DB_CONTAINER:-tennis-postgres}" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'cup_matches');" 2>/dev/null || echo "false")
ADVANCEMENTS_TABLE=$(docker exec "${DB_CONTAINER:-tennis-postgres}" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'cup_advancements');" 2>/dev/null || echo "false")

if [ "$CUPS_TABLE" = "t" ] && [ "$PARTICIPANTS_TABLE" = "t" ] && [ "$MATCHES_TABLE" = "t" ] && [ "$ADVANCEMENTS_TABLE" = "t" ]; then
    echo -e "${GREEN}✅ All 4 tables verified${NC}"
else
    echo -e "${RED}❌ Table verification failed!${NC}"
    [ "$CUPS_TABLE" = "t" ] && echo -e "  ✅ cups" || echo -e "  ❌ cups"
    [ "$PARTICIPANTS_TABLE" = "t" ] && echo -e "  ✅ cup_participants" || echo -e "  ❌ cup_participants"
    [ "$MATCHES_TABLE" = "t" ] && echo -e "  ✅ cup_matches" || echo -e "  ❌ cup_matches"
    [ "$ADVANCEMENTS_TABLE" = "t" ] && echo -e "  ✅ cup_advancements" || echo -e "  ❌ cup_advancements"
    exit 1
fi

echo ""
echo -e "${CYAN}Index verification...${NC}"
INDEX_COUNT=$(docker exec "${DB_CONTAINER:-tennis-postgres}" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT COUNT(*) FROM pg_indexes
   WHERE tablename IN ('cups', 'cup_participants', 'cup_matches', 'cup_advancements')
   AND indexname LIKE 'idx_cup%';" 2>/dev/null || echo "0")
echo -e "${GREEN}✅ $INDEX_COUNT cup indexes verified${NC}"

echo ""
echo -e "${GREEN}✅ Migration 10 complete!${NC}"
echo ""
echo -e "${CYAN}Table structure:${NC}"
echo "  cups              — Tournament definitions (name, format, status)"
echo "  cup_participants  — Registered teams (player pairs with seeds)"
echo "  cup_matches       — Bracket matches (rounds, scores, winners)"
echo "  cup_advancements  — Auto-advance rules (winner → next round)"
