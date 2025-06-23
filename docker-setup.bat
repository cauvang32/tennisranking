@echo off
:: 🎾 Tennis Ranking System - Docker Setup Script (Windows)
:: This script will set up your tennis ranking system using Docker

echo 🎾 Welcome to Tennis Ranking System Docker Setup!
echo ================================================
echo.

:: Check if Docker is installed
docker --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Docker is not installed.
    echo Please install Docker Desktop from https://docker.com/get-started
    echo.
    echo After installing Docker Desktop, restart your computer and run this script again.
    pause
    exit /b 1
)

echo ✅ Docker found:
docker --version

:: Check if Docker Compose is available
docker-compose --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Docker Compose is not available.
    echo Please install Docker Desktop which includes Docker Compose.
    pause
    exit /b 1
)

echo ✅ Docker Compose found:
docker-compose --version
echo.

:: Create data directory if it doesn't exist
if not exist "data" (
    mkdir data
    echo 📁 Created data directory
)

:: Build and start the container
echo 🐳 Building Docker container...
echo This may take a few minutes on first run...
docker-compose up --build -d

if %errorlevel% equ 0 (
    echo.
    echo 🎉 Setup Complete!
    echo ==================
    echo.
    echo 🌟 Your tennis ranking system is now running in Docker!
    echo 📊 All users will see the same matches and rankings
    echo 📁 Data is automatically saved to the .\data folder
    echo.
    echo 🌐 Access your system:
    echo • Local: http://localhost:3001
    echo • Network: http://YOUR-IP:3001
    echo.
    echo 📋 Docker Commands:
    echo • Stop system: docker-compose down
    echo • Restart system: docker-compose up -d
    echo • View logs: docker-compose logs -f
    echo • Update system: docker-compose up --build -d
    echo.
    echo 🆘 Need help? Check DOCKER_GUIDE.md for detailed instructions.
    echo.
    
    :: Show container status
    echo 📊 Container Status:
    docker-compose ps
    echo.
    
    echo 🚀 System is ready! Open http://localhost:3001 in your browser.
    pause
) else (
    echo ❌ Failed to start the container.
    echo Check the error messages above and try again.
    pause
    exit /b 1
)
