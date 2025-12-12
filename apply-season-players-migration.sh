#!/bin/bash
# Migration Script: Season Players, Lose Money Configuration, and Match Type Support
# Version: 2.0.0
# Run this script to apply the database migration for:
#   1. Season player selection (who can participate in each season)
#   2. Configurable lose money per loss for each season
#   3. Solo (đánh đơn) vs Duo (đánh đôi) match types

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}======================================${NC}"
echo -e "${BLUE}  Season Players & Match Type Migration${NC}"
echo -e "${BLUE}======================================${NC}"
echo ""

# Load environment variables from .env file
if [ -f .env ]; then
    export $(grep -v '^#' .env | grep -v '^$' | xargs)
    echo -e "${GREEN}✅ Loaded environment variables from .env${NC}"
fi

# Set database credentials from .env or use defaults
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
    echo "Please start the container first with: docker-compose up -d"
    exit 1
fi

echo -e "${YELLOW}Applying migration...${NC}"
echo ""

# Run the migration SQL
docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} << 'EOSQL'
-- Migration: Season Players, Lose Money Configuration, and Match Type Support
-- Version: 2.0.0

BEGIN;

-- Step 1: Add lose_money_per_loss column to seasons table
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'seasons' AND column_name = 'lose_money_per_loss') THEN
        ALTER TABLE seasons ADD COLUMN lose_money_per_loss INTEGER DEFAULT 20000;
        RAISE NOTICE 'Added lose_money_per_loss column to seasons table';
    ELSE
        RAISE NOTICE 'lose_money_per_loss column already exists';
    END IF;
END $$;

-- Update existing seasons that have NULL lose_money_per_loss to 20000
UPDATE seasons SET lose_money_per_loss = 20000 WHERE lose_money_per_loss IS NULL;

-- Step 2: Create season_players junction table
CREATE TABLE IF NOT EXISTS season_players (
    id SERIAL PRIMARY KEY,
    season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    added_by VARCHAR(255),
    UNIQUE(season_id, player_id)
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_season_players_season_id ON season_players(season_id);
CREATE INDEX IF NOT EXISTS idx_season_players_player_id ON season_players(player_id);

-- Step 3: Add match_type column to matches table
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'matches' AND column_name = 'match_type') THEN
        ALTER TABLE matches ADD COLUMN match_type VARCHAR(10) DEFAULT 'duo';
        RAISE NOTICE 'Added match_type column to matches table';
    ELSE
        RAISE NOTICE 'match_type column already exists';
    END IF;
END $$;

-- Update existing matches to have 'duo' type (backward compatibility)
UPDATE matches SET match_type = 'duo' WHERE match_type IS NULL;

-- Create index for match_type filtering
CREATE INDEX IF NOT EXISTS idx_matches_match_type ON matches(match_type);

-- Step 4: For existing seasons, auto-populate season_players with all current players
-- This ensures backward compatibility - existing seasons will have all players eligible
DO $$
DECLARE
    season_rec RECORD;
    player_rec RECORD;
    inserted_count INTEGER := 0;
BEGIN
    -- Only populate for seasons that have no players assigned yet
    FOR season_rec IN SELECT id FROM seasons WHERE id NOT IN (SELECT DISTINCT season_id FROM season_players)
    LOOP
        FOR player_rec IN SELECT id FROM players
        LOOP
            INSERT INTO season_players (season_id, player_id, added_by)
            VALUES (season_rec.id, player_rec.id, 'migration')
            ON CONFLICT (season_id, player_id) DO NOTHING;
            inserted_count := inserted_count + 1;
        END LOOP;
    END LOOP;
    IF inserted_count > 0 THEN
        RAISE NOTICE 'Auto-populated % season_player entries for existing seasons', inserted_count;
    END IF;
END $$;

-- Step 5: Add check constraint for match_type (if not exists)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.constraint_column_usage 
                   WHERE constraint_name = 'check_match_type') THEN
        ALTER TABLE matches ADD CONSTRAINT check_match_type CHECK (match_type IN ('solo', 'duo'));
        RAISE NOTICE 'Added check_match_type constraint';
    ELSE
        RAISE NOTICE 'check_match_type constraint already exists';
    END IF;
EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE 'check_match_type constraint already exists';
END $$;

COMMIT;

-- Verification
SELECT 'Migration completed successfully!' as status;
SELECT 'Seasons table columns:' as info;
SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_name = 'seasons' AND column_name IN ('lose_money_per_loss');
SELECT 'Matches table columns:' as info;
SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_name = 'matches' AND column_name IN ('match_type');
SELECT 'Season players count:' as info;
SELECT COUNT(*) as total_season_player_entries FROM season_players;
EOSQL

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}======================================${NC}"
    echo -e "${GREEN}  ✅ Migration completed successfully!${NC}"
    echo -e "${GREEN}======================================${NC}"
    echo ""
    echo -e "${YELLOW}New features available:${NC}"
    echo "  • Season player selection - control who can play in each season"
    echo "  • Configurable lose money - set custom penalty amount per season"
    echo "  • Solo/Duo match types - support for singles and doubles matches"
    echo ""
    echo -e "${BLUE}Please restart the server to apply changes:${NC}"
    echo "  npm run server"
else
    echo ""
    echo -e "${RED}======================================${NC}"
    echo -e "${RED}  ❌ Migration failed!${NC}"
    echo -e "${RED}======================================${NC}"
    echo "Please check the error messages above and try again."
    exit 1
fi
