#!/bin/bash
# Migration Script: Account System, Solo Match Fix & Extended Features
# Version: 3.0.0
# Run this script to apply:
#   1. Fix solo matches - make player2_id nullable
#   2. Add users table for account management
#   3. All previous season/match type migrations

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}  Account System & Solo Match Fix Migration${NC}"
echo -e "${BLUE}  Version 3.0.0${NC}"
echo -e "${BLUE}================================================${NC}"
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
    echo "Please start the container first with: docker compose up -d"
    exit 1
fi

echo -e "${CYAN}Step 1/4: Applying season players migration (if not done)...${NC}"

docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} << 'EOSQL'
-- Ensure season_players and match_type exist (idempotent)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'seasons' AND column_name = 'lose_money_per_loss') THEN
        ALTER TABLE seasons ADD COLUMN lose_money_per_loss INTEGER DEFAULT 20000;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS season_players (
    id SERIAL PRIMARY KEY,
    season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    added_by VARCHAR(255),
    UNIQUE(season_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_season_players_season_id ON season_players(season_id);
CREATE INDEX IF NOT EXISTS idx_season_players_player_id ON season_players(player_id);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'matches' AND column_name = 'match_type') THEN
        ALTER TABLE matches ADD COLUMN match_type VARCHAR(10) DEFAULT 'duo';
    END IF;
END $$;
EOSQL

echo -e "${GREEN}✅ Season players migration complete${NC}"
echo ""

echo -e "${CYAN}Step 2/4: Fixing solo match constraint (player2_id nullable)...${NC}"

docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} << 'EOSQL'
-- Fix: Make player2_id nullable for solo matches
DO $$
BEGIN
    -- Check if player2_id is NOT NULL
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'matches' 
        AND column_name = 'player2_id' 
        AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE matches ALTER COLUMN player2_id DROP NOT NULL;
        RAISE NOTICE 'Made player2_id nullable for solo matches';
    ELSE
        RAISE NOTICE 'player2_id is already nullable';
    END IF;
    
    -- Also ensure player4_id is nullable (should already be, but just in case)
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'matches' 
        AND column_name = 'player4_id' 
        AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE matches ALTER COLUMN player4_id DROP NOT NULL;
        RAISE NOTICE 'Made player4_id nullable';
    END IF;
END $$;

-- Add/Update match_type constraint
ALTER TABLE matches DROP CONSTRAINT IF EXISTS check_match_type;
ALTER TABLE matches ADD CONSTRAINT check_match_type CHECK (match_type IN ('solo', 'duo'));

SELECT 'Solo match fix complete' as status;
EOSQL

echo -e "${GREEN}✅ Solo match constraint fixed${NC}"
echo ""

echo -e "${CYAN}Step 3/4: Creating users table for account management...${NC}"

docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} << 'EOSQL'
-- Create users table for account management
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor', 'viewer')),
    display_name VARCHAR(100),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP,
    created_by VARCHAR(50),
    notes TEXT
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_is_active ON users(is_active);

-- Create function to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger for auto-updating updated_at
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

SELECT 'Users table created successfully' as status;
SELECT COUNT(*) as existing_users FROM users;
EOSQL

echo -e "${GREEN}✅ Users table created${NC}"
echo ""

echo -e "${CYAN}Step 4/4: Verifying migration...${NC}"

docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} << 'EOSQL'
-- Verification queries
SELECT '=== Migration Verification ===' as info;

SELECT 'Users table columns:' as table_info;
SELECT column_name, data_type, is_nullable, column_default 
FROM information_schema.columns 
WHERE table_name = 'users' 
ORDER BY ordinal_position;

SELECT 'Matches table nullable check:' as table_info;
SELECT column_name, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'matches' 
AND column_name IN ('player2_id', 'player4_id');

SELECT 'Total users:' as count_info;
SELECT COUNT(*) as user_count FROM users;

SELECT '=== Migration Complete ===' as info;
EOSQL

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}================================================${NC}"
    echo -e "${GREEN}  ✅ All migrations completed successfully!${NC}"
    echo -e "${GREEN}================================================${NC}"
    echo ""
    echo -e "${YELLOW}New features available:${NC}"
    echo "  • Account management - Create admin/editor accounts in database"
    echo "  • Solo matches (1v1) - Now fully supported"
    echo "  • Season player selection - Control who can play in each season"
    echo "  • Configurable lose money - Set custom penalty per season"
    echo ""
    echo -e "${BLUE}Please restart the server to apply changes:${NC}"
    echo "  npm run server"
else
    echo ""
    echo -e "${RED}================================================${NC}"
    echo -e "${RED}  ❌ Migration failed!${NC}"
    echo -e "${RED}================================================${NC}"
    echo "Please check the error messages above and try again."
    exit 1
fi
