#!/bin/bash

# 🎾 Tennis Ranking System - Deployment Script for NPM
# This script helps deploy the application with proper environment configuration

set -e  # Exit on any error

echo "🎾 Tennis Ranking System - NPM Deployment"
echo "========================================="

# Function to generate a random secret
generate_secret() {
    openssl rand -base64 32 | tr -d '\n'
}

# Check if .env exists, if not create from template
if [ ! -f .env ]; then
    echo "📁 Creating .env from production template..."
    cp .env.production .env
    
    echo "🔐 Generating secure secrets..."
    # Generate new secrets
    JWT_SECRET=$(generate_secret)
    CSRF_SECRET=$(generate_secret)
    
    # Update secrets in .env file
    sed -i "s/CHANGE_THIS_JWT_SECRET_32_CHARACTERS_MINIMUM/$JWT_SECRET/" .env
    sed -i "s/CHANGE_THIS_CSRF_SECRET_32_CHARACTERS_MIN/$CSRF_SECRET/" .env
    
    echo "⚠️  IMPORTANT: Please edit .env file with your domain and other settings before continuing!"
    echo "   - Set PUBLIC_DOMAIN to your domain"
    echo "   - Set BASE_PATH to your desired path (e.g., /tennis or /)"
    echo "   - Set ALLOWED_ORIGINS to your domain"
    echo "   - Change ADMIN_PASSWORD and database passwords"
    echo ""
    read -p "Press Enter after you've configured .env file..."
fi

# Load environment variables
echo "📋 Loading environment configuration..."
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
    echo "   Domain: ${PUBLIC_DOMAIN:-localhost}"
    echo "   Base Path: ${BASE_PATH:-/}"
    echo "   Environment: ${NODE_ENV:-development}"
else
    echo "❌ .env file not found!"
    exit 1
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Build application
echo "🔨 Building application for production..."
if [ "$BASE_PATH" = "/" ]; then
    npm run build:subdomain
else
    npm run build:subpath
fi

# Check if PostgreSQL is configured
if [ -n "$DB_HOST" ] && [ -n "$DB_NAME" ]; then
    echo "🗄️  Database configuration found:"
    echo "   Host: $DB_HOST"
    echo "   Database: $DB_NAME"
    echo "   User: $DB_USER"
else
    echo "⚠️  Warning: Database configuration not found in .env"
fi

# Test build
echo "🧪 Testing build..."
if [ -d "dist" ] && [ -f "dist/index.html" ]; then
    echo "✅ Build successful!"
else
    echo "❌ Build failed - dist directory or index.html not found"
    exit 1
fi

# Start application
echo "🚀 Starting application..."
echo "   Server will run on port: ${PORT:-3001}"
echo "   Access URL: https://${PUBLIC_DOMAIN}${BASE_PATH}"
echo ""

# Check if PM2 is available for process management
if command -v pm2 >/dev/null 2>&1; then
    echo "🔄 Using PM2 for process management..."
    pm2 restart tennis-ranking 2>/dev/null || pm2 start npm --name "tennis-ranking" -- run server
    echo "✅ Application started with PM2"
    echo "📊 Use 'pm2 logs tennis-ranking' to view logs"
    echo "📊 Use 'pm2 monit' to monitor the application"
else
    echo "📝 PM2 not found. Starting with npm..."
    echo "💡 Tip: Install PM2 for better process management: npm install -g pm2"
    npm run server
fi

echo ""
echo "🎯 Deployment Summary:"
echo "====================="
echo "✅ Application built and started successfully"
echo "🌐 Configure your Nginx Proxy Manager to point to:"
echo "   - Backend: http://$(hostname -I | awk '{print $1}'):${PORT:-3001}"
echo "   - Domain: ${PUBLIC_DOMAIN}"
echo "   - Path: ${BASE_PATH}"
echo ""
echo "📚 For NPM configuration help, see: NPM_SETUP_GUIDE.md"
echo "🔍 Health check: curl http://localhost:${PORT:-3001}/health"
