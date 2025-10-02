#!/bin/bash
# Apply multi-season migration to tennis-postgres container

echo "🎾 Tennis Ranking - Multi-Season Migration Script"
echo "=================================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
CONTAINER_NAME="tennis-postgres"
DB_USER="tennis_user"
DB_NAME="tennis_ranking"

# Check if container is running
echo "🔍 Checking if PostgreSQL container is running..."
if ! docker ps | grep -q "$CONTAINER_NAME"; then
    echo -e "${RED}❌ Container '$CONTAINER_NAME' is not running${NC}"
    echo "Start it with: docker-compose up -d postgres"
    exit 1
fi
echo -e "${GREEN}✅ Container is running${NC}"
echo ""

# Display current schema
echo "📋 Current seasons table schema:"
echo "================================"
docker exec -i $CONTAINER_NAME psql -U $DB_USER -d $DB_NAME -c "\d seasons"
echo ""

# Ask for confirmation
read -p "Do you want to apply the multi-season migration? (y/n): " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Migration cancelled."
    exit 0
fi

echo ""
echo "🚀 Applying migration..."
echo "========================"

# Apply the verification/migration script
docker exec -i $CONTAINER_NAME psql -U $DB_USER -d $DB_NAME < verify-season-schema.sql

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✅ Migration completed successfully!${NC}"
    echo ""
    
    # Display updated schema
    echo "📊 Updated seasons table schema:"
    echo "================================"
    docker exec -i $CONTAINER_NAME psql -U $DB_USER -d $DB_NAME -c "
    SELECT 
      column_name,
      data_type,
      CASE WHEN is_nullable = 'YES' THEN '✓' ELSE '✗' END as nullable,
      column_default
    FROM information_schema.columns 
    WHERE table_name = 'seasons'
    ORDER BY ordinal_position;
    "
    echo ""
    
    # Show current seasons
    echo "📈 Current seasons in database:"
    echo "==============================="
    docker exec -i $CONTAINER_NAME psql -U $DB_USER -d $DB_NAME -c "
    SELECT 
      id,
      name,
      start_date,
      end_date,
      is_active,
      auto_end,
      CASE WHEN description IS NOT NULL THEN '✓' ELSE '✗' END as has_desc
    FROM seasons
    ORDER BY start_date DESC;
    "
    echo ""
    
    echo -e "${YELLOW}📝 Next steps:${NC}"
    echo "1. Restart your Node.js server: npm run server"
    echo "2. Login to the web interface"
    echo "3. Test the new multi-season features:"
    echo "   - Create multiple concurrent seasons"
    echo "   - Set optional end dates"
    echo "   - Enable auto-end for specific seasons"
    echo "   - End and reactivate seasons"
    echo ""
    echo -e "${GREEN}🎉 Multi-season support is now active!${NC}"
    
else
    echo ""
    echo -e "${RED}❌ Migration failed${NC}"
    echo "Please check the error messages above"
    exit 1
fi
