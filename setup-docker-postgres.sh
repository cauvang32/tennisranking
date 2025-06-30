#!/bin/bash

# Tennis Ranking System - Docker PostgreSQL Quick Setup
# This script sets up PostgreSQL using Docker only

echo "🎾 Tennis Ranking System - Docker PostgreSQL Setup"
echo "================================================="
echo ""

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    echo "Visit: https://docs.docker.com/get-docker/"
    exit 1
fi

# Check if docker-compose is available
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo "❌ Docker Compose is not available. Please install Docker Compose."
    exit 1
fi

# Default values from .env or fallback
DB_NAME="${DB_NAME:-tennis_ranking}"
DB_USER="${DB_USER:-tennis_user}"
DB_PASSWORD="${DB_PASSWORD:-tennis_password}"
DB_PORT="${DB_PORT:-5432}"

echo "🐳 Setting up PostgreSQL with Docker..."
echo "Database Configuration:"
echo "  Database: $DB_NAME"
echo "  Username: $DB_USER"
echo "  Password: $DB_PASSWORD"
echo "  Port: $DB_PORT"
echo "  Data Directory: ./data/postgres-data/"
echo ""

# Create PostgreSQL data directory
echo "📁 Creating PostgreSQL data directory..."
mkdir -p ./data/postgres-data

# Set proper permissions for PostgreSQL data directory
echo "🔧 Setting permissions for PostgreSQL data directory..."
sudo chown -R 999:999 ./data/postgres-data 2>/dev/null || {
    echo "⚠️  Note: Could not set PostgreSQL directory permissions. This might cause issues."
    echo "   If PostgreSQL fails to start, run: sudo chown -R 999:999 ./data/postgres-data"
}

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    echo "📝 Creating .env file..."
    cat > .env << EOF
# Tennis Ranking System Configuration
DB_TYPE=postgresql
DB_HOST=localhost
DB_PORT=$DB_PORT
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD

# Admin credentials
ADMIN_USERNAME=admin
ADMIN_PASSWORD=tennis2024!
ADMIN_EMAIL=admin@tennis.local

# JWT secrets (change in production!)
JWT_SECRET=your-super-secret-jwt-key-change-in-production
SESSION_SECRET=your-super-secret-session-key-change-in-production

# Server configuration
PORT=3001
NODE_ENV=development
EOF
    echo "✅ .env file created"
fi

# Stop and remove any existing containers
echo "🔄 Stopping any existing containers..."
docker compose down 2>/dev/null || true

# Start only PostgreSQL service
echo "🚀 Starting PostgreSQL container..."
docker compose up -d postgres

if [ $? -eq 0 ]; then
    echo "✅ PostgreSQL container started successfully"
else
    echo "❌ Failed to start PostgreSQL container"
    exit 1
fi

# Wait for PostgreSQL to be ready
echo "⏳ Waiting for PostgreSQL to be ready..."
timeout=60
counter=0
while [ $counter -lt $timeout ]; do
    if docker exec tennis-postgres pg_isready -U $DB_USER -d $DB_NAME &>/dev/null; then
        echo "✅ PostgreSQL is ready!"
        break
    fi
    sleep 2
    counter=$((counter + 2))
    echo "   Waiting... ($counter/$timeout seconds)"
done

if [ $counter -ge $timeout ]; then
    echo "❌ PostgreSQL did not become ready within $timeout seconds"
    echo "   Check container logs with: docker logs tennis-postgres"
    exit 1
fi

# Test connection
echo "🔍 Testing database connection..."
docker exec tennis-postgres psql -U $DB_USER -d $DB_NAME -c "SELECT version();" > /dev/null 2>&1

if [ $? -eq 0 ]; then
    echo "✅ Database connection test successful"
else
    echo "❌ Database connection test failed"
    echo "Check container logs with: docker logs tennis-postgres"
    exit 1
fi

echo ""
echo "🎉 Docker PostgreSQL setup completed successfully!"
echo ""
echo "📋 Your database connection details:"
echo "  Host: localhost"
echo "  Port: $DB_PORT"
echo "  Database: $DB_NAME"
echo "  Username: $DB_USER"
echo "  Password: $DB_PASSWORD"
echo ""
echo "🐳 Docker Commands:"
echo "  View logs: docker logs tennis-postgres"
echo "  Connect to database: docker exec -it tennis-postgres psql -U $DB_USER -d $DB_NAME"
echo "  Stop PostgreSQL: docker-compose stop postgres"
echo "  Start PostgreSQL: docker-compose start postgres"
echo "  Remove container: docker-compose down"
echo ""
echo "📁 Data Storage:"
echo "  PostgreSQL data: ./data/postgres-data/"
echo "  SQLite database: ./data/tennis.db"
echo "  Backup PostgreSQL: docker exec tennis-postgres pg_dump -U $DB_USER $DB_NAME > ./data/postgres_backup.sql"
echo "  Access data files: ls -la ./data/"
echo ""
echo "🔧 Next steps:"
echo "1. Install Node.js dependencies:"
echo "   npm install"
echo ""
echo "2. Run the migration script to transfer data from SQLite:"
echo "   node migrate-database.js"
echo ""
echo "3. Start your application (locally):"
echo "   npm start"
echo ""
echo "   OR start everything with Docker:"
echo "   docker-compose up -d"
echo ""
echo "⚠️  Notes:"
echo "   - PostgreSQL data stored in ./data/postgres-data/ directory"
echo "   - You can directly access and backup database files"
echo "   - SQLite database remains in ./data/tennis.db for migration"
echo "   - Container restarts automatically unless stopped manually"
echo "   - Make sure port $DB_PORT is not used by other applications"
echo ""
