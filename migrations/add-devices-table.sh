#!/bin/bash
# Migration Script: Add devices table for FCM push notification registration
# Stores FCM tokens so the backend can target push notifications. See backend.md §2.

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}  FCM Devices Table Migration${NC}"
echo -e "${BLUE}  Creates devices table for push tokens${NC}"
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

echo -e "${CYAN}Creating devices table...${NC}"

sudo docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} << 'EOSQL'
-- FCM device registry. Stores push tokens so the backend can target
-- notifications. user_id is NULL for guests; token is the upsert key.
CREATE TABLE IF NOT EXISTS devices (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  platform    VARCHAR(8) NOT NULL CHECK (platform IN ('android', 'ios')),
  app_version VARCHAR(32) NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_updated_at ON devices(updated_at);

SELECT 'devices table migration complete' as status;
EOSQL

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}================================================${NC}"
    echo -e "${GREEN}  ✅ FCM devices table migration completed!${NC}"
    echo -e "${GREEN}================================================${NC}"
    echo ""
    echo -e "${BLUE}Please restart the server to apply changes.${NC}"
else
    echo ""
    echo -e "${RED}❌ Migration failed!${NC}"
    exit 1
fi
