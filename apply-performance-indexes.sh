#!/bin/bash
# Apply performance indexes migration to PostgreSQL in Docker
# Usage: ./apply-performance-indexes.sh

set -e

# Load environment variables from .env if it exists
if [ -f .env ]; then
    # Only export valid KEY=VALUE pairs, ignoring comments and empty lines
    while IFS='=' read -r key value; do
        # Skip comments (lines starting with #) and empty lines
        [[ "$key" =~ ^[[:space:]]*# ]] && continue
        [[ -z "$key" ]] && continue
        # Remove leading/trailing whitespace from key
        key=$(echo "$key" | xargs)
        # Skip if key is empty or contains invalid characters
        [[ -z "$key" ]] && continue
        [[ ! "$key" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] && continue
        # Export the variable
        export "$key=$value"
    done < .env
fi

# Configuration
CONTAINER_NAME="${DB_CONTAINER_NAME:-tennis-postgres}"
DB_NAME="${DB_NAME:-tennis_ranking}"
DB_USER="${DB_USER:-tennis_user}"

echo "🔍 Applying performance indexes migration..."
echo "   Container: $CONTAINER_NAME"
echo "   Database: $DB_NAME"
echo "   User: $DB_USER"
echo ""

# Check if container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "❌ Error: Container '$CONTAINER_NAME' is not running"
    echo "   Try: docker-compose up -d"
    exit 1
fi

# Apply migration
echo "📦 Applying indexes..."
docker exec -i "$CONTAINER_NAME" psql -U "$DB_USER" -d "$DB_NAME" < migrations/add-performance-indexes.sql

echo ""
echo "✅ Migration completed successfully!"
echo ""
echo "📊 To verify indexes, run:"
echo "   docker exec -it $CONTAINER_NAME psql -U $DB_USER -d $DB_NAME -c \"\\di\""
