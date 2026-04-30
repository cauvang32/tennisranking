#!/bin/bash
# Migration Script: Add token_version column to users table for JWT revocation
# This enables server-side token invalidation on logout / password change / disable

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}  JWT Token Revocation Migration${NC}"
echo -e "${BLUE}  Adds token_version to users table${NC}"
echo -e "${BLUE}================================================${NC}"
echo ""

# Load environment variables from .env file
if [ -f .env ]; then
    export $(grep -v '^#' .env | grep -v '^$' | xargs)
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
if ! sudo docker ps --format '{{.Names}}' | grep -q "^${DB_CONTAINER}$"; then
    echo -e "${RED}❌ Error: Docker container '${DB_CONTAINER}' is not running${NC}"
    echo "Please start the container first with: sudo docker compose up -d"
    exit 1
fi

echo -e "${CYAN}Adding token_version column to users table...${NC}"

sudo docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} << 'EOSQL'
-- Add token_version column for JWT revocation support
-- When a user logs out or changes password, token_version is incremented.
-- Tokens signed with an older version are rejected by middleware.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'users' AND column_name = 'token_version') THEN
        ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0 NOT NULL;
        RAISE NOTICE 'Added token_version column to users table';
    ELSE
        RAISE NOTICE 'token_version column already exists';
    END IF;
END $$;

SELECT 'token_version migration complete' as status;
EOSQL

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}================================================${NC}"
    echo -e "${GREEN}  ✅ JWT revocation migration completed!${NC}"
    echo -e "${GREEN}================================================${NC}"
    echo ""
    echo -e "${BLUE}Please restart the server to apply changes.${NC}"
else
    echo ""
    echo -e "${RED}❌ Migration failed!${NC}"
    exit 1
fi
