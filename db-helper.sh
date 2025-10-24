#!/bin/bash
# Database Helper Script
# Utility script for common database operations using .env credentials

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Load environment variables from .env file
if [ -f .env ]; then
    export $(grep -v '^#' .env | grep -v '^$' | xargs)
fi

# Set database credentials from .env or use defaults
DB_USER=${DB_USER:-tennis_user}
DB_NAME=${DB_NAME:-tennis_ranking}
DB_PASSWORD=${DB_PASSWORD:-tennis_password}
DB_CONTAINER=${DB_CONTAINER:-tennis-postgres}

# Function to execute SQL
function exec_sql() {
    docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -c "$1"
}

# Function to execute SQL from file
function exec_sql_file() {
    docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} < "$1"
}

# Function to show database info
function show_info() {
    echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║              Database Connection Info                     ║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
    echo -e "${YELLOW}Container:${NC} ${DB_CONTAINER}"
    echo -e "${YELLOW}Database:${NC}  ${DB_NAME}"
    echo -e "${YELLOW}User:${NC}      ${DB_USER}"
    echo ""
}

# Function to show menu
function show_menu() {
    echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║          🎾 Tennis Ranking - Database Helper              ║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo "1) Show database info"
    echo "2) View all seasons"
    echo "3) View all players"
    echo "4) View all matches"
    echo "5) View seasons table schema"
    echo "6) Execute custom SQL"
    echo "7) Execute SQL from file"
    echo "8) Backup database"
    echo "9) Connect to psql (interactive)"
    echo "0) Exit"
    echo ""
}

# Main script
if [ $# -eq 0 ]; then
    # Interactive mode
    while true; do
        show_menu
        read -p "Select option: " choice
        echo ""
        
        case $choice in
            1)
                show_info
                ;;
            2)
                echo -e "${YELLOW}📊 All Seasons:${NC}"
                exec_sql "SELECT id, name, start_date, end_date, is_active, auto_end FROM seasons ORDER BY id;"
                ;;
            3)
                echo -e "${YELLOW}👥 All Players:${NC}"
                exec_sql "SELECT id, name, created_at FROM players ORDER BY id;"
                ;;
            4)
                echo -e "${YELLOW}🎾 Recent Matches (last 10):${NC}"
                exec_sql "SELECT m.id, s.name as season, m.play_date, p1.name || ' & ' || p2.name as team1, p3.name || ' & ' || p4.name as team2, m.team1_score || '-' || m.team2_score as score FROM matches m JOIN players p1 ON m.player1_id = p1.id JOIN players p2 ON m.player2_id = p2.id JOIN players p3 ON m.player3_id = p3.id JOIN players p4 ON m.player4_id = p4.id JOIN seasons s ON m.season_id = s.id ORDER BY m.play_date DESC, m.id DESC LIMIT 10;"
                ;;
            5)
                echo -e "${YELLOW}🗂️ Seasons Table Schema:${NC}"
                exec_sql "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'seasons' ORDER BY ordinal_position;"
                ;;
            6)
                read -p "Enter SQL query: " sql
                echo ""
                exec_sql "$sql"
                ;;
            7)
                read -p "Enter SQL file path: " filepath
                echo ""
                if [ -f "$filepath" ]; then
                    exec_sql_file "$filepath"
                else
                    echo -e "${RED}❌ File not found: ${filepath}${NC}"
                fi
                ;;
            8)
                BACKUP_FILE="backup-$(date +%Y%m%d-%H%M%S).sql"
                echo -e "${YELLOW}💾 Creating backup...${NC}"
                docker exec ${DB_CONTAINER} pg_dump -U ${DB_USER} -d ${DB_NAME} > "$BACKUP_FILE"
                echo -e "${GREEN}✅ Backup created: ${BACKUP_FILE}${NC}"
                ;;
            9)
                echo -e "${YELLOW}🔌 Connecting to psql (type \\q to exit)...${NC}"
                docker exec -it ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME}
                ;;
            0)
                echo -e "${GREEN}👋 Goodbye!${NC}"
                exit 0
                ;;
            *)
                echo -e "${RED}❌ Invalid option${NC}"
                ;;
        esac
        
        echo ""
        read -p "Press Enter to continue..."
        clear
    done
else
    # Command line mode
    case $1 in
        info)
            show_info
            ;;
        seasons)
            exec_sql "SELECT id, name, start_date, end_date, is_active, auto_end FROM seasons ORDER BY id;"
            ;;
        players)
            exec_sql "SELECT id, name, created_at FROM players ORDER BY id;"
            ;;
        matches)
            exec_sql "SELECT m.id, s.name as season, m.play_date, p1.name || ' & ' || p2.name as team1, p3.name || ' & ' || p4.name as team2, m.team1_score || '-' || m.team2_score as score FROM matches m JOIN players p1 ON m.player1_id = p1.id JOIN players p2 ON m.player2_id = p2.id JOIN players p3 ON m.player3_id = p3.id JOIN players p4 ON m.player4_id = p4.id JOIN seasons s ON m.season_id = s.id ORDER BY m.play_date DESC, m.id DESC LIMIT 20;"
            ;;
        schema)
            exec_sql "\\d seasons"
            ;;
        backup)
            BACKUP_FILE="backup-$(date +%Y%m%d-%H%M%S).sql"
            docker exec ${DB_CONTAINER} pg_dump -U ${DB_USER} -d ${DB_NAME} > "$BACKUP_FILE"
            echo "Backup created: ${BACKUP_FILE}"
            ;;
        psql)
            docker exec -it ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME}
            ;;
        sql)
            if [ -z "$2" ]; then
                echo "Usage: $0 sql \"SELECT * FROM seasons;\""
                exit 1
            fi
            exec_sql "$2"
            ;;
        file)
            if [ -z "$2" ]; then
                echo "Usage: $0 file migration.sql"
                exit 1
            fi
            exec_sql_file "$2"
            ;;
        *)
            echo "Usage: $0 [command]"
            echo ""
            echo "Commands:"
            echo "  info          - Show database connection info"
            echo "  seasons       - View all seasons"
            echo "  players       - View all players"
            echo "  matches       - View recent matches"
            echo "  schema        - View seasons table schema"
            echo "  backup        - Create database backup"
            echo "  psql          - Connect to psql (interactive)"
            echo "  sql \"query\"   - Execute custom SQL"
            echo "  file <path>   - Execute SQL from file"
            echo ""
            echo "Run without arguments for interactive menu"
            ;;
    esac
fi
