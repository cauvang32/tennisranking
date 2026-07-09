#!/bin/bash
# Migration Script: 09 — Add Season Results Columns
# Version: 9.0.0
# Purpose: Add final_results and conclusion image columns to seasons table
#
# This migration:
#   1. Adds final_results TEXT column to seasons
#   2. Adds conclusion_image_path VARCHAR(512) column
#   3. Adds conclusion_image_filename VARCHAR(255) column
#   4. Adds conclusion_image_content_type VARCHAR(64) column
#   5. Adds conclusion_image_size INTEGER column
#
# Run: ./migrations/09-add-season-results.sh

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}  Season Results Columns Migration${NC}"
echo -e "${BLUE}  Version 9.0.0${NC}"
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
COLUMNS_EXIST=$(docker exec "${DB_CONTAINER:-tennis-postgres}" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name = 'seasons'
   AND column_name IN ('final_results', 'conclusion_image_path', 'conclusion_image_filename', 'conclusion_image_content_type', 'conclusion_image_size');" 2>/dev/null || echo "0")

if [ "$COLUMNS_EXIST" = "5" ]; then
    echo -e "${YELLOW}⏭  All 5 season result columns already exist — skipping${NC}"
    exit 0
fi

echo -e "${CYAN}Adding season result columns...${NC}"
docker exec -i "${DB_CONTAINER:-tennis-postgres}" psql -U "$DB_USER" -d "$DB_NAME" <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'seasons' AND column_name = 'final_results') THEN
    ALTER TABLE seasons ADD COLUMN final_results TEXT;
    RAISE NOTICE 'Added final_results column';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'seasons' AND column_name = 'conclusion_image_path') THEN
    ALTER TABLE seasons ADD COLUMN conclusion_image_path VARCHAR(512);
    RAISE NOTICE 'Added conclusion_image_path column';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'seasons' AND column_name = 'conclusion_image_filename') THEN
    ALTER TABLE seasons ADD COLUMN conclusion_image_filename VARCHAR(255);
    RAISE NOTICE 'Added conclusion_image_filename column';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'seasons' AND column_name = 'conclusion_image_content_type') THEN
    ALTER TABLE seasons ADD COLUMN conclusion_image_content_type VARCHAR(64);
    RAISE NOTICE 'Added conclusion_image_content_type column';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'seasons' AND column_name = 'conclusion_image_size') THEN
    ALTER TABLE seasons ADD COLUMN conclusion_image_size INTEGER;
    RAISE NOTICE 'Added conclusion_image_size column';
  END IF;
END $$;
SQL

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Season result columns added successfully${NC}"
else
    echo -e "${RED}❌ Migration failed!${NC}"
    exit 1
fi

echo ""
echo -e "${CYAN}Verifying...${NC}"
FINAL_RESULTS=$(docker exec "${DB_CONTAINER:-tennis-postgres}" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'seasons' AND column_name = 'final_results';" 2>/dev/null || echo "0")
CONCLUSION_PATH=$(docker exec "${DB_CONTAINER:-tennis-postgres}" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'seasons' AND column_name = 'conclusion_image_path';" 2>/dev/null || echo "0")

if [ "$FINAL_RESULTS" = "1" ] && [ "$CONCLUSION_PATH" = "1" ]; then
    echo -e "${GREEN}✅ All columns verified${NC}"
else
    echo -e "${RED}❌ Column verification failed!${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}✅ Migration 09 complete!${NC}"
