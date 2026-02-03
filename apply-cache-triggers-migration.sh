#!/bin/bash

# Apply cache notify triggers migration for Redis cache invalidation
# This script adds PostgreSQL LISTEN/NOTIFY triggers to automatically
# invalidate Redis cache when data changes in the database

set -e

echo "🔄 Applying cache notify triggers migration..."

# Load environment variables if .env exists
if [ -f .env ]; then
    set -a
    source <(grep -v '^#' .env | grep -v '^$' | grep '=' || true)
    set +a
fi

# Set defaults
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-tennis_ranking}"
DB_USER="${DB_USER:-tennis_user}"

# Check if PGPASSWORD is set or DB_PASSWORD
if [ -z "$PGPASSWORD" ] && [ -n "$DB_PASSWORD" ]; then
    export PGPASSWORD="$DB_PASSWORD"
fi

if [ -z "$PGPASSWORD" ]; then
    echo "❌ Error: DB_PASSWORD or PGPASSWORD environment variable is required"
    exit 1
fi

echo "📡 Connecting to PostgreSQL at $DB_HOST:$DB_PORT/$DB_NAME as $DB_USER"

# Check if psql is available locally
if command -v psql &> /dev/null; then
    echo "Using local psql client..."
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f migrations/add-cache-notify-triggers.sql
elif command -v docker &> /dev/null; then
    echo "Using Docker to run psql..."
    docker exec -i tennis-postgres psql -U "$DB_USER" -d "$DB_NAME" < migrations/add-cache-notify-triggers.sql
else
    echo "❌ Error: Neither psql nor docker is available"
    echo "Please install PostgreSQL client tools or Docker"
    exit 1
fi

echo "✅ Cache notify triggers migration applied successfully!"
echo ""
echo "The following triggers are now active:"
echo "  - matches_cache_invalidation"
echo "  - players_cache_invalidation"
echo "  - seasons_cache_invalidation"
echo ""
echo "These triggers will send notifications to the 'cache_invalidation' channel"
echo "which Redis cache will subscribe to for automatic cache invalidation."
