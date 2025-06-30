#!/bin/bash

# Prepare data directory for PostgreSQL
echo "📁 Preparing data directory for PostgreSQL..."

# Create PostgreSQL data directory
mkdir -p ./data/postgres-data

# Set proper permissions (PostgreSQL container runs as user 999)
echo "🔧 Setting up permissions for PostgreSQL..."
sudo chown -R 999:999 ./data/postgres-data

if [ $? -eq 0 ]; then
    echo "✅ PostgreSQL data directory prepared successfully"
    echo "📁 Directory: $(pwd)/data/postgres-data"
    echo "👤 Owner: postgres (999:999)"
else
    echo "❌ Failed to set permissions. You may need to run this manually:"
    echo "   sudo chown -R 999:999 ./data/postgres-data"
fi

# Show current data directory structure
echo ""
echo "📋 Current data directory contents:"
ls -la ./data/

echo ""
echo "✅ Ready for PostgreSQL setup!"
echo "   Run: ./setup-docker-postgres.sh"
