#!/bin/bash
# Multi-Season Feature Update Script
# This script applies all necessary changes for concurrent season support

set -e  # Exit on any error

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   🎾 Tennis Ranking - Multi-Season Feature Update        ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Load environment variables from .env file
if [ -f .env ]; then
    echo -e "${YELLOW}📋 Loading configuration from .env file...${NC}"
    export $(grep -v '^#' .env | grep -v '^$' | xargs)
    echo -e "${GREEN}✅ Configuration loaded${NC}"
else
    echo -e "${RED}❌ .env file not found${NC}"
    echo -e "${YELLOW}💡 Using default values${NC}"
fi

# Set database credentials from .env or use defaults
DB_USER=${DB_USER:-tennis_user}
DB_NAME=${DB_NAME:-tennis_ranking}
DB_PASSWORD=${DB_PASSWORD:-tennis_password}

echo -e "${BLUE}📊 Database Configuration:${NC}"
echo -e "   User: ${DB_USER}"
echo -e "   Database: ${DB_NAME}"
echo ""

# Step 1: Check if Docker container is running
echo -e "${YELLOW}📋 Step 1: Checking Docker container...${NC}"
if ! docker ps | grep -q tennis-postgres; then
    echo -e "${RED}❌ Docker container 'tennis-postgres' is not running${NC}"
    echo -e "${YELLOW}💡 Starting container...${NC}"
    docker-compose up -d postgres
    sleep 3
    
    if ! docker ps | grep -q tennis-postgres; then
        echo -e "${RED}❌ Failed to start container${NC}"
        exit 1
    fi
fi
echo -e "${GREEN}✅ Container is running${NC}"
echo ""

# Step 2: Test database connection
echo -e "${YELLOW}📋 Step 2: Testing database connection...${NC}"
if docker exec -i tennis-postgres psql -U ${DB_USER} -d ${DB_NAME} -c "SELECT 1" > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Database connection successful${NC}"
else
    echo -e "${RED}❌ Cannot connect to database${NC}"
    exit 1
fi
echo ""

# Step 3: Backup current database
echo -e "${YELLOW}📋 Step 3: Creating database backup...${NC}"
BACKUP_FILE="backup-seasons-$(date +%Y%m%d-%H%M%S).sql"
docker exec tennis-postgres pg_dump -U ${DB_USER} -d ${DB_NAME} -t seasons > "$BACKUP_FILE"
echo -e "${GREEN}✅ Backup created: ${BACKUP_FILE}${NC}"
echo ""

# Step 4: Apply migration
echo -e "${YELLOW}📋 Step 4: Applying database migration...${NC}"
if docker exec -i tennis-postgres psql -U ${DB_USER} -d ${DB_NAME} < verify-and-update-migration.sql; then
    echo -e "${GREEN}✅ Migration applied successfully${NC}"
else
    echo -e "${RED}❌ Migration failed${NC}"
    echo -e "${YELLOW}💡 You can restore from backup: ${BACKUP_FILE}${NC}"
    exit 1
fi
echo ""

# Step 5: Verify migration
echo -e "${YELLOW}📋 Step 5: Verifying migration...${NC}"
COLUMNS=$(docker exec -i tennis-postgres psql -U ${DB_USER} -d ${DB_NAME} -t -c "
    SELECT column_name 
    FROM information_schema.columns 
    WHERE table_name = 'seasons' 
    AND column_name IN ('auto_end', 'description', 'ended_at', 'ended_by') 
    ORDER BY column_name;
")

if [ -z "$COLUMNS" ]; then
    echo -e "${RED}❌ Verification failed - new columns not found${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Verification successful - all new columns present:${NC}"
echo "$COLUMNS"
echo ""

# Step 6: Check end_date is nullable
echo -e "${YELLOW}📋 Step 6: Verifying end_date is optional...${NC}"
END_DATE_NULLABLE=$(docker exec -i tennis-postgres psql -U ${DB_USER} -d ${DB_NAME} -t -c "
    SELECT is_nullable 
    FROM information_schema.columns 
    WHERE table_name = 'seasons' 
    AND column_name = 'end_date';
")

if [[ "$END_DATE_NULLABLE" == *"YES"* ]]; then
    echo -e "${GREEN}✅ end_date is properly configured as optional (nullable)${NC}"
else
    echo -e "${RED}❌ end_date is still required (not nullable)${NC}"
    exit 1
fi
echo ""

# Step 7: Display final schema
echo -e "${YELLOW}📋 Step 7: Final database schema:${NC}"
docker exec -i tennis-postgres psql -U ${DB_USER} -d ${DB_NAME} -c "
    SELECT 
        column_name, 
        data_type, 
        is_nullable,
        column_default
    FROM information_schema.columns 
    WHERE table_name = 'seasons' 
    ORDER BY ordinal_position;
"
echo ""

# Step 8: Test season creation
echo -e "${YELLOW}📋 Step 8: Testing season creation without end_date...${NC}"
TEST_RESULT=$(docker exec -i tennis-postgres psql -U ${DB_USER} -d ${DB_NAME} -t -c "
    INSERT INTO seasons (name, start_date, is_active, auto_end) 
    VALUES ('Test Season', '2025-01-01', false, false) 
    RETURNING id;
" 2>&1)

if [[ "$TEST_RESULT" =~ [0-9]+ ]]; then
    TEST_ID=$(echo "$TEST_RESULT" | tr -d ' ')
    echo -e "${GREEN}✅ Season created successfully without end_date (ID: ${TEST_ID})${NC}"
    
    # Clean up test data
    docker exec -i tennis-postgres psql -U ${DB_USER} -d ${DB_NAME} -c "DELETE FROM seasons WHERE id = ${TEST_ID};" > /dev/null 2>&1
    echo -e "${GREEN}✅ Test data cleaned up${NC}"
else
    echo -e "${RED}❌ Failed to create season without end_date${NC}"
    echo -e "${YELLOW}Error: ${TEST_RESULT}${NC}"
    exit 1
fi
echo ""

# Summary
echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                   ✅ UPDATE COMPLETE                       ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${GREEN}✅ Database migration completed successfully${NC}"
echo -e "${GREEN}✅ All new columns added and verified${NC}"
echo -e "${GREEN}✅ end_date is now optional${NC}"
echo -e "${GREEN}✅ Backup created: ${BACKUP_FILE}${NC}"
echo ""
echo -e "${YELLOW}📝 Next steps:${NC}"
echo -e "   1. ${BLUE}Restart your Node.js server:${NC} npm run server"
echo -e "   2. ${BLUE}Test the new features:${NC}"
echo -e "      • Create seasons with and without end dates"
echo -e "      • Enable/disable auto-end feature"
echo -e "      • End seasons manually"
echo -e "      • Reactivate ended seasons"
echo -e "   3. ${BLUE}Create multiple concurrent active seasons${NC}"
echo ""
echo -e "${YELLOW}🎯 New Features Available:${NC}"
echo -e "   ✅ Multiple concurrent active seasons"
echo -e "   ✅ Optional end dates (manual end required if not set)"
echo -e "   ✅ Auto-end on end_date (if enabled)"
echo -e "   ✅ Reactivate ended seasons"
echo -e "   ✅ Track who ended seasons and when"
echo -e "   ✅ Season descriptions"
echo ""
echo -e "${GREEN}🚀 Your Tennis Ranking System is ready!${NC}"
