#!/bin/bash
# Migration Script: 11 — Add Cup Results Columns
# Version: 11.0.0
# Purpose: Add final_results text and conclusion_image columns to cups table
#
# This migration:
#   1. Adds final_results TEXT column to cups
#   2. Adds conclusion_image_path, conclusion_image_filename,
#      conclusion_image_content_type, conclusion_image_size columns
#
# Run: ./migrations/11-add-cup-results.sh

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}  Cup Results Columns Migration${NC}"
echo -e "${BLUE}  Version 11.0.0${NC}"
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

# Check if columns already exist
COLS_EXIST=$(docker exec "${DB_CONTAINER:-tennis-postgres}" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name = 'cups' AND column_name IN ('final_results', 'conclusion_image_path');" 2>/dev/null || echo "0")

if [ "$COLS_EXIST" = "2" ]; then
    echo -e "${YELLOW}⏭  Cup results columns already exist — skipping${NC}"
    exit 0
fi

echo -e "${CYAN}Adding cup results columns...${NC}"
docker exec -i "${DB_CONTAINER:-tennis-postgres}" psql -U "$DB_USER" -d "$DB_NAME" <<'SQL'

ALTER TABLE cups ADD COLUMN IF NOT EXISTS final_results TEXT;
ALTER TABLE cups ADD COLUMN IF NOT EXISTS conclusion_image_path VARCHAR(512);
ALTER TABLE cups ADD COLUMN IF NOT EXISTS conclusion_image_filename VARCHAR(255);
ALTER TABLE cups ADD COLUMN IF NOT EXISTS conclusion_image_content_type VARCHAR(64);
ALTER TABLE cups ADD COLUMN IF NOT EXISTS conclusion_image_size INTEGER;

SQL

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Cup results columns added successfully${NC}"
else
    echo -e "${RED}❌ Migration failed!${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}✅ Migration 11 complete!${NC}"
