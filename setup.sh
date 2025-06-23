#!/bin/bash

# 🎾 Tennis Ranking System - Automated Setup Script
# This script will set up your tennis ranking system automatically

echo "🎾 Welcome to Tennis Ranking System Setup!"
echo "=========================================="
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed."
    echo "Please install Node.js from https://nodejs.org"
    echo "Choose the LTS version and restart your computer after installation."
    echo ""
    echo "After installing Node.js, run this script again."
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node --version)
echo "✅ Node.js found: $NODE_VERSION"

# Check if npm is available
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not available."
    echo "Please reinstall Node.js from https://nodejs.org"
    exit 1
fi

NPM_VERSION=$(npm --version)
echo "✅ npm found: $NPM_VERSION"
echo ""

# Install dependencies
echo "📦 Installing project dependencies..."
echo "This may take a few minutes..."
if npm install; then
    echo "✅ Dependencies installed successfully!"
else
    echo "❌ Failed to install dependencies."
    echo "Please check your internet connection and try again."
    exit 1
fi

echo ""
echo "🎉 Setup Complete!"
echo "=================="
echo ""
echo "Your tennis ranking system now supports SHARED DATA!"
echo "🌟 All users will see the same matches and rankings"
echo "📁 Data is automatically saved to the /data folder"
echo ""
echo "To start your tennis ranking system:"
echo "1. Run this command: npm start"
echo "2. Open your web browser"
echo "3. Go to: http://localhost:3001"
echo ""
echo "🌐 SHARING WITH YOUR GROUP:"
echo "Find your computer's IP address and share:"
echo "http://YOUR-IP-ADDRESS:3001"
echo "Everyone can access the same data!"
echo ""
echo "📋 Next Steps:"
echo "- Add your tennis players in the 'Quản lý người chơi' tab"
echo "- Start recording matches!"
echo "- Data is automatically saved and shared with everyone"
echo ""
echo "🆘 Need help? Check CUSTOMER_SETUP_GUIDE.md for detailed instructions."
echo ""

# Ask if user wants to start the system now
read -p "Would you like to start the system now? (y/n): " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "🚀 Starting tennis ranking system with shared data..."
    echo "Press Ctrl+C to stop the system when you're done."
    echo ""
    echo "🌐 Your system will be available at: http://localhost:3001"
    echo "📁 Data files will be saved in the /data folder"
    echo ""
    npm start
fi
