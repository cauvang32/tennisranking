#!/bin/bash

# Tennis Ranking System - Production Startup Script
# This script helps you deploy the application to production

set -e

echo "🎾 Tennis Ranking System - Production Deployment"
echo "================================================"

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo "❌ .env file not found!"
    echo "📝 Creating .env from .env.production template..."
    cp .env.production .env
    echo "⚠️  IMPORTANT: Edit .env file with your actual passwords and secrets!"
    echo "   - Change ADMIN_PASSWORD"
    echo "   - Change JWT_SECRET"
    echo "   - Change CSRF_SECRET"
    echo "   - Update ALLOWED_ORIGINS with your domain"
    echo "   - Update database credentials"
    echo ""
    read -p "Press Enter after updating .env file..."
fi

# Check Node.js version
echo "🔍 Checking Node.js version..."
NODE_VERSION=$(node --version)
echo "Node.js version: $NODE_VERSION"

if ! node --version | grep -E "v(18|19|20|21|22)" > /dev/null; then
    echo "⚠️  Warning: Node.js 18+ is recommended"
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Build the application
echo "🔨 Building application for production..."
npm run build

# Check if PostgreSQL is configured
echo "🗄️  Checking database configuration..."
if grep -q "CHANGE_THIS" .env; then
    echo "❌ Please update the database configuration in .env file"
    echo "   Current placeholder values detected. Update:"
    echo "   - DB_PASSWORD"
    echo "   - ADMIN_PASSWORD" 
    echo "   - JWT_SECRET"
    echo "   - CSRF_SECRET"
    exit 1
fi

# Test database connection
echo "🔌 Testing database connection..."
export NODE_ENV=production
if node -e "
const db = require('./database-postgresql.js');
(async () => {
  try {
    const database = new db.default();
    await database.init();
    console.log('✅ Database connection successful');
    process.exit(0);
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    process.exit(1);
  }
})();
" 2>/dev/null; then
    echo "✅ Database connection test passed"
else
    echo "❌ Database connection failed"
    echo "   Please check your database configuration in .env"
    echo "   Make sure PostgreSQL is running and accessible"
    exit 1
fi

echo ""
echo "🚀 Ready to start the production server!"
echo ""
echo "Options:"
echo "1. Start with npm: npm run server"
echo "2. Start with PM2: pm2 start npm --name 'tennis-ranking' -- run server"
echo ""
echo "📋 Next steps:"
echo "1. Configure nginx proxy manager or nginx"
echo "2. Set up SSL certificate"
echo "3. Test the application at https://yourdomain.com/tennis"
echo ""
echo "📚 See SUBPATH_DEPLOYMENT_GUIDE.md for detailed instructions"
echo ""

# Ask if user wants to start the server
read -p "Start the server now? (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "🎾 Starting Tennis Ranking System server..."
    npm run server
fi
