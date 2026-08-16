#!/bin/bash
# Migration Script: 08 — Add site_images Table (Self-Service Image Editor)
# Version: 8.0.0
# Purpose: Create site_images table for admin image management
#
# This migration:
#   1. Creates site_images table
#   2. Creates index on (key, is_active)
#   3. Seeds default image keys (hero_banner, logo, favicon, background)
#
# Run: ./migrations/08-add-site-images.sh

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}  Site Images Table Migration${NC}"
echo -e "${BLUE}  Version 8.0.0${NC}"
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
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"

echo -e "${CYAN}Database: $DB_NAME @ $DB_HOST:$DB_PORT${NC}"
echo ""

# Check if table already exists
TABLE_EXISTS=$(docker exec "${DB_CONTAINER:-tennis-postgres}" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'site_images');" 2>/dev/null || echo "false")

if [ "$TABLE_EXISTS" = "t" ]; then
    echo -e "${YELLOW}⏭  site_images table already exists — skipping${NC}"
    exit 0
fi

echo -e "${CYAN}Creating site_images table...${NC}"
docker exec -i "${DB_CONTAINER:-tennis-postgres}" psql -U "$DB_USER" -d "$DB_NAME" <<'SQL'
CREATE TABLE IF NOT EXISTS site_images (
  id            SERIAL PRIMARY KEY,
  key           VARCHAR(64) UNIQUE NOT NULL,
  filename      VARCHAR(255) NOT NULL,
  storage_path  VARCHAR(512) NOT NULL,
  content_type  VARCHAR(64) NOT NULL,
  file_size     INTEGER NOT NULL,
  alt_text      VARCHAR(255) DEFAULT '',
  is_active     BOOLEAN DEFAULT true,
  uploaded_by   VARCHAR(255),
  uploaded_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_site_images_key_active ON site_images(key, is_active);

-- Seed default image keys with placeholder values
INSERT INTO site_images (key, filename, storage_path, content_type, file_size, alt_text, is_active)
VALUES
  ('hero_banner', 'placeholder', '/placeholder', 'image/png', 0, 'Banner trang chủ', false),
  ('logo', 'placeholder', '/placeholder', 'image/png', 0, 'Logo trang web', false),
  ('favicon', 'placeholder', '/placeholder', 'image/png', 0, 'Favicon', false),
  ('background', 'placeholder', '/placeholder', 'image/png', 0, 'Hình nền', false)
ON CONFLICT (key) DO NOTHING;
SQL

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ site_images table created successfully${NC}"
    echo -e "${GREEN}✅ Index idx_site_images_key_active created${NC}"
    echo -e "${GREEN}✅ 4 default image keys seeded${NC}"
else
    echo -e "${RED}❌ Migration failed!${NC}"
    exit 1
fi

echo ""
echo -e "${CYAN}Verifying...${NC}"
ROW_COUNT=$(docker exec "${DB_CONTAINER:-tennis-postgres}" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT COUNT(*) FROM site_images;" 2>/dev/null || echo "0")
echo -e "${GREEN}✅ site_images has $ROW_COUNT rows${NC}"
echo ""
echo -e "${GREEN}✅ Migration 08 complete!${NC}"
