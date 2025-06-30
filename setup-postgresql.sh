#!/bin/bash

# Tennis Ranking System - PostgreSQL Setup Script
# This script sets up PostgreSQL database and user for the tennis ranking system

echo "🎾 Tennis Ranking System - PostgreSQL Setup"
echo "==========================================="
echo ""

# Ask user about setup type
echo "Choose your PostgreSQL setup:"
echo "1) Local PostgreSQL installation"
echo "2) Docker PostgreSQL container"
echo ""
read -p "Enter your choice (1 or 2): " SETUP_TYPE

if [ "$SETUP_TYPE" = "2" ]; then
    echo "🐳 Setting up PostgreSQL with Docker..."
    
    # Check if Docker is installed
    if ! command -v docker &> /dev/null; then
        echo "❌ Docker is not installed. Please install Docker first."
        echo ""
        echo "Visit: https://docs.docker.com/get-docker/"
        exit 1
    fi
    
    # Check if docker-compose is available
    if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
        echo "❌ Docker Compose is not available. Please install Docker Compose."
        exit 1
    fi
    
else
    # Check if PostgreSQL is installed for local setup
    if ! command -v psql &> /dev/null; then
        echo "❌ PostgreSQL is not installed. Please install PostgreSQL first."
        echo ""
        echo "On Ubuntu/Debian:"
        echo "  sudo apt update"
        echo "  sudo apt install postgresql postgresql-contrib"
        echo ""
        echo "On macOS (with Homebrew):"
        echo "  brew install postgresql"
        echo "  brew services start postgresql"
        echo ""
        echo "On CentOS/RHEL:"
        echo "  sudo yum install postgresql postgresql-server"
        echo "  sudo postgresql-setup initdb"
        echo "  sudo systemctl start postgresql"
        echo ""
        exit 1
    fi
fi

# Default values
DB_NAME="tennis_ranking"
DB_USER="tennis_user"
DB_PASSWORD="tennis_password"
DB_HOST="localhost"
DB_PORT="5432"

# Get database configuration from .env if it exists
if [ -f .env ]; then
    source .env
fi

echo "Database Configuration:"
echo "  Host: $DB_HOST"
echo "  Port: $DB_PORT"
echo "  Database Name: $DB_NAME"
echo "  Username: $DB_USER"
echo "  Password: $DB_PASSWORD"
echo ""

if [ "$SETUP_TYPE" = "2" ]; then
    # Docker setup
    echo "🐳 Setting up PostgreSQL with Docker..."
    
    # Create data directory for PostgreSQL if it doesn't exist
    echo "📁 Creating PostgreSQL data directory..."
    mkdir -p ./data/postgres-data
    
    # Set proper permissions for PostgreSQL data directory
    # PostgreSQL container runs as user 999 (postgres)
    sudo chown -R 999:999 ./data/postgres-data 2>/dev/null || {
        echo "⚠️  Note: Could not set PostgreSQL directory permissions. This might cause issues."
        echo "   If PostgreSQL fails to start, run: sudo chown -R 999:999 ./data/postgres-data"
    }
    
    # Create docker-compose.yml for PostgreSQL
    cat > docker-compose.postgres.yml << EOF
version: '3.8'

services:
  postgres:
    image: postgres:15-alpine
    container_name: tennis-postgres
    environment:
      POSTGRES_DB: $DB_NAME
      POSTGRES_USER: $DB_USER
      POSTGRES_PASSWORD: $DB_PASSWORD
    ports:
      - "$DB_PORT:5432"
    volumes:
      - ./data/postgres-data:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $DB_USER -d $DB_NAME"]
      interval: 10s
      timeout: 5s
      retries: 5
EOF

    # Create initialization SQL script
    cat > init.sql << EOF
-- Tennis Ranking System Database Initialization
-- This script runs when the PostgreSQL container starts for the first time

-- Ensure the database and user exist (should already be created by environment variables)
-- Additional setup can be added here if needed

-- Create extensions if needed
-- CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Log successful initialization
SELECT 'Tennis Ranking System database initialized successfully' as message;
EOF

    echo "📄 Created docker-compose.postgres.yml and init.sql"
    echo "📁 PostgreSQL data will be stored in: ./data/postgres-data/"
    
    # Stop any existing container
    echo "🔄 Stopping any existing PostgreSQL container..."
    docker-compose -f docker-compose.postgres.yml down 2>/dev/null || true
    
    # Start PostgreSQL container
    echo "🚀 Starting PostgreSQL container..."
    docker-compose -f docker-compose.postgres.yml up -d
    
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

else
    # Local PostgreSQL setup (existing code)
    # Check if PostgreSQL service is running
    if ! sudo systemctl is-active --quiet postgresql; then
        echo "🔄 Starting PostgreSQL service..."
        sudo systemctl start postgresql
        if [ $? -eq 0 ]; then
            echo "✅ PostgreSQL service started"
        else
            echo "❌ Failed to start PostgreSQL service"
            exit 1
        fi
    fi

    echo "🔧 Setting up database and user..."

    # Create database and user
    sudo -u postgres psql << EOF
-- Create database
CREATE DATABASE $DB_NAME;

-- Create user
CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;

-- Grant usage on schema
GRANT USAGE ON SCHEMA public TO $DB_USER;
GRANT CREATE ON SCHEMA public TO $DB_USER;

-- In PostgreSQL 15+, we need to grant additional permissions
ALTER DATABASE $DB_NAME OWNER TO $DB_USER;

-- Show created database and user
\l $DB_NAME
\du $DB_USER

EOF

    if [ $? -eq 0 ]; then
        echo "✅ Database and user created successfully"
    else
        echo "❌ Failed to create database and user"
        exit 1
    fi

    echo ""
    echo "🔍 Testing database connection..."

    # Test connection
    PGPASSWORD=$DB_PASSWORD psql -h localhost -U $DB_USER -d $DB_NAME -c "SELECT version();" > /dev/null 2>&1

    if [ $? -eq 0 ]; then
        echo "✅ Database connection test successful"
    else
        echo "❌ Database connection test failed"
        echo "Please check your PostgreSQL configuration"
        exit 1
    fi
fi

echo ""
echo "🎉 PostgreSQL setup completed successfully!"
echo ""
echo "📋 Your database connection details:"
echo "  Host: $DB_HOST"
echo "  Port: $DB_PORT"
echo "  Database: $DB_NAME"
echo "  Username: $DB_USER"
echo "  Password: $DB_PASSWORD"

if [ "$SETUP_TYPE" = "2" ]; then
    echo ""
    echo "🐳 Docker PostgreSQL Commands:"
    echo "  View logs: docker logs tennis-postgres"
    echo "  Connect to database: docker exec -it tennis-postgres psql -U $DB_USER -d $DB_NAME"
    echo "  Stop container: docker-compose -f docker-compose.postgres.yml down"
    echo "  Start container: docker-compose -f docker-compose.postgres.yml up -d"
    echo "  Remove container: docker-compose -f docker-compose.postgres.yml down"
    echo ""
    echo "📁 Data Storage:"
    echo "  PostgreSQL data: ./data/postgres-data/"
    echo "  SQLite database: ./data/tennis.db"
    echo "  Backup PostgreSQL: docker exec tennis-postgres pg_dump -U $DB_USER $DB_NAME > ./data/postgres_backup.sql"
    echo "  Access data files: ls -la ./data/"
fi

echo ""
echo "🔧 Next steps:"
echo "1. Make sure your .env file has the correct database configuration:"
echo "   DB_TYPE=postgresql"
echo "   DB_HOST=$DB_HOST"
echo "   DB_PORT=$DB_PORT"
echo "   DB_NAME=$DB_NAME"
echo "   DB_USER=$DB_USER"
echo "   DB_PASSWORD=$DB_PASSWORD"
echo ""
echo "2. Install Node.js dependencies:"
echo "   npm install"
echo ""
echo "3. Run the migration script to transfer data from SQLite:"
echo "   node migrate-database.js"
echo ""
echo "4. Start your application:"
echo "   npm start"
echo ""

if [ "$SETUP_TYPE" = "2" ]; then
    echo "⚠️  Docker Notes:"
    echo "   - PostgreSQL data stored in ./data/postgres-data/ directory"
    echo "   - You can directly access and backup database files"
    echo "   - SQLite database remains in ./data/tennis.db for migration"
    echo "   - Container restarts automatically unless stopped manually"
    echo "   - Make sure port $DB_PORT is not used by other applications"
    echo ""
fi
