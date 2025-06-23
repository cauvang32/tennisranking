#!/bin/bash

# 🎾 Tennis Ranking System - Docker Setup Script
# This script will set up your tennis ranking system using Docker

echo "🎾 Welcome to Tennis Ranking System Docker Setup!"
echo "================================================"
echo ""

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed."
    echo "Please install Docker from https://docker.com/get-started"
    echo ""
    echo "After installing Docker, run this script again."
    exit 1
fi

echo "✅ Docker found:"
docker --version

# Check if Docker Compose is available
if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose is not available."
    echo "Please install Docker Compose or use Docker Desktop which includes it."
    exit 1
fi

echo "✅ Docker Compose found:"
docker-compose --version
echo ""

# Create data directory if it doesn't exist
if [ ! -d "./data" ]; then
    mkdir -p data
    echo "📁 Created data directory"
fi

# Build and start the container
echo "🐳 Building Docker container..."
echo "This may take a few minutes on first run..."
docker-compose up --build -d

if [ $? -eq 0 ]; then
    echo ""
    echo "🎉 Setup Complete!"
    echo "=================="
    echo ""
    echo "🌟 Your tennis ranking system is now running in Docker!"
    echo "📊 All users will see the same matches and rankings"
    echo "📁 Data is automatically saved to the ./data folder"
    echo ""
    echo "🌐 Access your system:"
    echo "• Local: http://localhost:3001"
    echo "• Network: http://YOUR-IP:3001"
    echo ""
    echo "📋 Docker Commands:"
    echo "• Stop system: docker-compose down"
    echo "• Restart system: docker-compose up -d"
    echo "• View logs: docker-compose logs -f"
    echo "• Update system: docker-compose up --build -d"
    echo ""
    echo "🆘 Need help? Check DOCKER_GUIDE.md for detailed instructions."
    echo ""
    
    # Show container status
    echo "📊 Container Status:"
    docker-compose ps
    echo ""
    
    echo "🚀 System is ready! Open http://localhost:3001 in your browser."
else
    echo "❌ Failed to start the container."
    echo "Check the error messages above and try again."
    exit 1
fi
