#!/usr/bin/env bash
# =============================================================================
# Tennis Ranking System — Unified Setup & Migration Script
# =============================================================================
# Usage:
#   ./setup.sh setup              Interactive database setup
#   ./setup.sh setup --non-interactive  Non-interactive (uses env vars)
#   ./setup.sh migrate            Run all pending migrations in order
#   ./setup.sh migrate <name>     Run a specific migration by name
#   ./setup.sh all                Setup + run all migrations
#   ./setup.sh status             Show migration status
#   ./setup.sh help               Show this help
#
# Environment variables (optional overrides):
#   DB_NAME          PostgreSQL database name   (default: tennis_ranking)
#   DB_USER          PostgreSQL username         (default: tennis_user)
#   DB_PASSWORD      PostgreSQL password          (auto-generated if unset)
#   COMPOSE_PROJECT  docker-compose project name  (default: tennis)
# =============================================================================

set -euo pipefail

# ── Colors & formatting ──────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }
step()    { echo -e "${CYAN}Step $*${NC}"; }

# ── Configuration (overridable via env) ───────────────────────────────────────
DB_NAME="${DB_NAME:-tennis_ranking}"
DB_USER="${DB_USER:-tennis_user}"
DB_PASSWORD="${DB_PASSWORD:-$(openssl rand -base64 24)}"
DB_HOST="localhost"
DB_PORT=5432
REDIS_PORT=6380
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-tennis}"
DB_CONTAINER="${DB_CONTAINER:-${COMPOSE_PROJECT_NAME}-postgres-1}"

# ── Banner ────────────────────────────────────────────────────────────────────
print_banner() {
    cat <<'EOF'
 ╔══════════════════════════════════════════════════════════╗
 ║          🎾 Tennis Ranking System — Setup & Migrate     ║
 ╚══════════════════════════════════════════════════════════╝
EOF
}

print_usage() {
    echo ""
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Commands:"
    echo "  setup              Interactive database setup"
    echo "  setup --non-interactive  Non-interactive (uses env vars)"
    echo "  migrate            Run all pending migrations"
    echo "  migrate <name>     Run a specific migration"
    echo "  all                Setup + run all migrations"
    echo "  status             Show migration status"
    echo "  help               Show this help"
    echo ""
    echo "Environment variables (optional):"
    echo "  DB_NAME          PostgreSQL database name   (default: tennis_ranking)"
    echo "  DB_USER          PostgreSQL username         (default: tennis_user)"
    echo "  DB_PASSWORD      PostgreSQL password          (auto-generated if unset)"
    echo "  COMPOSE_PROJECT  docker-compose project name  (default: tennis)"
    echo ""
}

# ── Argument parsing ─────────────────────────────────────────────────────────
COMMAND="${1:-help}"
shift || true
NON_INTERACTIVE=false

for arg in "$@"; do
    case "$arg" in
        --non-interactive) NON_INTERACTIVE=true ;;
        *)                 error "Unknown option: $arg"; exit 1 ;;
    esac
done

# ── Prerequisites check ──────────────────────────────────────────────────────
check_prerequisites() {
    if ! command -v docker &>/dev/null; then
        error "docker is not installed. Please install Docker first."
        exit 1
    fi
    if ! docker info &>/dev/null; then
        error "Docker daemon is not running. Start Docker and try again."
        exit 1
    fi
}

# ── Wait helpers ──────────────────────────────────────────────────────────────
wait_for_postgres() {
    local max_retries=${1:-60}
    local retry_count=0
    while [ $retry_count -lt $max_retries ]; do
        if docker exec "$DB_CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" &>/dev/null 2>&1; then
            return 0
        fi
        retry_count=$((retry_count + 1))
        if [ $((retry_count % 10)) -eq 0 ]; then
            info "  Still waiting... ($retry_count/$max_retries)"
        fi
        sleep 2
    done
    error "PostgreSQL did not become healthy within timeout."
    docker compose -p "$COMPOSE_PROJECT_NAME" logs postgres 2>/dev/null || true
    return 1
}

wait_for_redis() {
    local max_retries=30
    local retry_count=0
    local redis_container="${COMPOSE_PROJECT_NAME}-redis-1"
    while [ $retry_count -lt $max_retries ]; do
        if docker exec "$redis_container" redis-cli ping &>/dev/null 2>&1; then
            return 0
        fi
        retry_count=$((retry_count + 1))
        sleep 2
    done
    error "Redis did not become healthy within timeout."
    return 1
}

# ── Command: setup ────────────────────────────────────────────────────────────
cmd_setup() {
    print_banner
    check_prerequisites

    info "Checking for existing containers..."
    EXISTING=$(docker compose -p "$COMPOSE_PROJECT_NAME" ps -q postgres redis 2>/dev/null || true)

    if [ -n "$EXISTING" ]; then
        warn "Containers already exist. Stopping and removing them..."
        docker compose -p "$COMPOSE_PROJECT_NAME" down
    fi

    info "Database configuration:"
    info "  DB_NAME:     $DB_NAME"
    info "  DB_USER:     $DB_USER"
    info "  DB_PASSWORD: [generated; written only to the protected credentials file]"
    info "  DB_HOST:     $DB_HOST:$DB_PORT"
    info "  REDIS_PORT:  $REDIS_PORT"

    echo ""
    info "Starting PostgreSQL and Redis containers..."
    docker compose -p "$COMPOSE_PROJECT_NAME" up -d postgres redis
    success "Containers started"

    echo ""
    info "Waiting for PostgreSQL to be healthy..."
    if ! wait_for_postgres 60; then
        exit 1
    fi
    success "PostgreSQL is ready!"

    echo ""
    info "Verifying database '$DB_NAME'..."
    docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1;" &>/dev/null 2>&1 || {
        info "Database does not exist. Creating..."
        docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -c "CREATE DATABASE \"$DB_NAME\";" 2>/dev/null || true
    }
    success "Database verified"

    echo ""
    info "Verifying Redis..."
    if ! wait_for_redis 30; then
        warn "Redis not available — continuing without it."
    else
        success "Redis is ready!"
    fi

    echo ""
    info "Tables will be auto-created when the application starts."
    info "To verify, start the app and check the logs:"
    echo ""
    echo "  docker compose -p $COMPOSE_PROJECT_NAME up app"

    # Print connection details
    echo ""
    cat <<EOF
╔══════════════════════════════════════════════════════════╗
║         🎾 Setup Complete — Connection Details          ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  PostgreSQL:                                            ║
║    Host:     $DB_HOST:$DB_PORT                        ║
║    Database: $DB_NAME                                   ║
║    User:     $DB_USER                                   ║
║    Password: stored in .db-credentials (mode 600)       ║
║                                                          ║
║  Redis:                                                 ║
║    Host:     localhost:$REDIS_PORT                      ║
║    (mapped from container :6379)                        ║
║                                                          ║
║  Next Steps:                                            ║
║    1. Copy .env.example to .env                         ║
║       cp .env.example .env                              ║
║    2. Update .env with the credentials above            ║
║    3. Generate secrets:                                 ║
║       node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # JWT_SECRET
║       node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # CSRF_SECRET
║    4. Start the application:                            ║
║       npm run dev-full                                  ║
║                                                          ║
║  Useful Commands:                                       ║
║    docker compose -p $COMPOSE_PROJECT_NAME logs -f      ║
║    docker compose -p $COMPOSE_PROJECT_NAME down         ║
║    docker exec -it $DB_CONTAINER psql \\dt               ║
║                                                          ║
║  Then run migrations:                                   ║
║    ./setup.sh migrate                                   ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
EOF

    # Save credentials
    local credentials_file=".db-credentials"
    umask 077
    cat > "$credentials_file" <<CREDS
# Tennis Ranking System — Database Credentials
# Generated on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# Regenerate with: $0 setup

DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
DB_HOST=localhost
DB_PORT=$DB_PORT
REDIS_URL=redis://localhost:$REDIS_PORT
CREDS
    chmod 600 "$credentials_file"

    echo ""
    success "Credentials saved to $credentials_file"
    info "Add these values to your .env file (along with ADMIN_USERNAME, ADMIN_PASSWORD, EDITOR_USERNAME, EDITOR_PASSWORD, JWT_SECRET, CSRF_SECRET)"
}

# ── Migration registry ────────────────────────────────────────────────────────
# Each entry: name|description|sql_file
# Order matters — migrations run top-to-bottom.
declare -a MIGRATIONS=(
    "users-bootstrap|Create the base users table required by later migrations|11-bootstrap-users.sql"
    "performance-indexes|Add performance indexes|add-performance-indexes.sql"
    "cache-notify-triggers|Add PostgreSQL NOTIFY triggers for Redis cache invalidation|add-cache-notify-triggers.sql"
    "match-details-view|Add match_details view + updated_at triggers|add-match-details-view.sql"
    "devices-table|Add FCM devices table|add-devices-table.sh"
    "token-version|Add token_version for JWT revocation|add-token-version.sh"
    "refresh-sessions|Add one-time refresh token sessions|12-add-refresh-sessions.sql"
    "cache-event-identifiers|Add transaction-scoped cache event IDs|13-cache-event-identifiers.sql"
    "ranking-summary|Add pre-computed ranking stats + triggers|04-add-ranking-summary.sh"
    "fix-trigger-unnest|Fix unnest syntax in ranking trigger|05-fix-trigger-unnest.sh"
    "score-difference|Add score_difference generated column|06-add-score-difference.sh"
    "daily-stats|Add player_daily_stats table|07-add-daily-stats.sh"
    "site-images|Add site_images table for image editor|08-add-site-images.sh"
    "season-results|Add final_results & conclusion image columns to seasons|09-add-season-results.sh"
    "cup-tournaments|Add cup tournament tables (cups, participants, matches, advancements)|10-add-cup-tournaments.sh"
    "cup-results|Add cup results and conclusion image columns|11-add-cup-results.sh"
)

# Track which migrations have been applied
get_applied_migrations() {
    # Check if the migration's SQL/table exists in the database
    local applied=()
    local has_table
    has_table=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'users');" 2>/dev/null || echo "false")
    if [ "$has_table" = "t" ]; then
        applied+=("users-bootstrap")
    fi

    has_table=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'player_lifetime_stats');" 2>/dev/null || echo "false")

    if [ "$has_table" = "t" ]; then
        # ranking-summary and fix-trigger-unnest have been applied
        applied+=("ranking-summary" "fix-trigger-unnest")
    fi

    has_table=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'devices');" 2>/dev/null || echo "false")
    if [ "$has_table" = "t" ]; then
        applied+=("devices-table")
    fi

    local has_tv
    has_tv=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
        "SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'token_version';" 2>/dev/null || echo "0")
    if [ "$has_tv" != "0" ]; then
        applied+=("token-version")
    fi

    has_table=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'refresh_sessions');" 2>/dev/null || echo "false")
    if [ "$has_table" = "t" ]; then
        applied+=("refresh-sessions")
    fi

    # Check cache triggers
    local has_trig
    has_trig=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
        "SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'matches_cache_invalidation';" 2>/dev/null || echo "0")
    if [ "$has_trig" != "0" ]; then
        applied+=("cache-notify-triggers")
    fi

    has_trig=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
        "SELECT COUNT(*) FROM pg_proc WHERE proname = 'notify_cache_invalidation' AND pg_get_functiondef(oid) LIKE '%eventId%';" 2>/dev/null || echo "0")
    if [ "$has_trig" != "0" ]; then
        applied+=("cache-event-identifiers")
    fi

    # Check score-difference (migration 06)
    has_trig=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
        "SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'matches' AND column_name = 'score_difference';" 2>/dev/null || echo "0")
    if [ "$has_trig" != "0" ]; then
        applied+=("score-difference")
    fi

    # Check daily-stats (migration 07)
    has_table=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'player_daily_stats');" 2>/dev/null || echo "false")
    if [ "$has_table" = "t" ]; then
        applied+=("daily-stats")
    fi

    # Check site-images (migration 08)
    has_table=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'site_images');" 2>/dev/null || echo "false")
    if [ "$has_table" = "t" ]; then
        applied+=("site-images")
    fi

    # Check season-results (migration 09)
    local has_sr
    has_sr=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
        "SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'seasons' AND column_name IN ('final_results', 'conclusion_image_path');" 2>/dev/null || echo "0")
    if [ "$has_sr" = "2" ]; then
        applied+=("season-results")
    fi

    # Check cup-tournaments (migration 10)
    local has_cups
    has_cups=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN ('cups', 'cup_participants', 'cup_matches', 'cup_advancements');" 2>/dev/null || echo "0")
    if [ "$has_cups" = "4" ]; then
        applied+=("cup-tournaments")
    fi

    local has_cup_results
    has_cup_results=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
        "SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'cups' AND column_name IN ('final_results', 'conclusion_image_path');" 2>/dev/null || echo "0")
    if [ "$has_cup_results" = "2" ]; then
        applied+=("cup-results")
    fi

    echo "${applied[@]}"
}

# ── Command: migrate ──────────────────────────────────────────────────────────
cmd_migrate() {
    local target="${1:-all}"

    print_banner
    info "Loading environment variables from .env..."

    # Load .env
    if [ -f .env ]; then
        while IFS='=' read -r key value; do
            [[ "$key" =~ ^#.*$ ]] && continue
            [[ -z "$key" ]] && continue
            value="${value%\"}"
            value="${value#\"}"
            value="${value%\'}"
            value="${value#\'}"
            value="${value%% #*}"
            export "$key=$value" 2>/dev/null
        done < .env
        success "Loaded environment variables from .env"
    fi

    # Check container is running
    if ! docker ps --format '{{.Names}}' | grep -q "^${DB_CONTAINER}$"; then
        error "Docker container '${DB_CONTAINER}' is not running."
        echo "Please start it first with: docker compose -p $COMPOSE_PROJECT_NAME up -d postgres redis"
        exit 1
    fi

    local applied
    IFS=' ' read -r -a applied <<< "$(get_applied_migrations)"

    if [ "$target" = "all" ]; then
        info "Running all pending migrations..."
        echo ""
        for entry in "${MIGRATIONS[@]}"; do
            IFS='|' read -r name desc sql_file <<< "$entry"

            # Check if already applied
            local skip=false
            for a in "${applied[@]}"; do
                if [ "$a" = "$name" ]; then
                    skip=true
                    break
                fi
            done

            if [ "$skip" = true ]; then
                info "  ⏭  Skipping $name (already applied)"
                continue
            fi

            info "  ▶  Running $name..."
            echo ""

            # Determine if it's a shell script or SQL file
            if [[ "$sql_file" == *.sh ]]; then
                # Run as shell script (with env vars injected)
                local migration_script="migrations/$sql_file"
                if [ ! -f "$migration_script" ]; then
                    error "  Migration script not found: $migration_script"
                    continue
                fi
                DB_CONTAINER="$DB_CONTAINER" DB_USER="$DB_USER" DB_NAME="$DB_NAME" \
                    bash "$migration_script" || {
                    error "  Migration $name failed!"
                    exit 1
                }
            elif [[ "$sql_file" == *.sql ]]; then
                local migration_sql="migrations/$sql_file"
                if [ ! -f "$migration_sql" ]; then
                    error "  Migration SQL not found: $migration_sql"
                    continue
                fi
                docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" < "$migration_sql" || {
                    error "  Migration $name failed!"
                    exit 1
                }
            else
                error "  Unknown migration file type: $sql_file"
                continue
            fi

            success "  ✓ $name completed"
            echo ""
        done
        echo ""
        success "All migrations complete!"
    else
        # Run a specific migration
        local found=false
        for entry in "${MIGRATIONS[@]}"; do
            IFS='|' read -r name desc sql_file <<< "$entry"
            if [ "$name" = "$target" ]; then
                found=true
                step "$desc"

                # Check if already applied
                local skip=false
                for a in "${applied[@]}"; do
                    if [ "$a" = "$name" ]; then
                        skip=true
                        break
                    fi
                done

                if [ "$skip" = true ]; then
                    info "Already applied — skipping."
                    continue
                fi

                if [[ "$sql_file" == *.sh ]]; then
                    local migration_script="migrations/$sql_file"
                    if [ ! -f "$migration_script" ]; then
                        error "Migration script not found: $migration_script"
                        continue
                    fi
                    DB_CONTAINER="$DB_CONTAINER" DB_USER="$DB_USER" DB_NAME="$DB_NAME" \
                        bash "$migration_script" || { error "Migration $name failed!"; exit 1; }
                elif [[ "$sql_file" == *.sql ]]; then
                    local migration_sql="migrations/$sql_file"
                    if [ ! -f "$migration_sql" ]; then
                        error "Migration SQL not found: $migration_sql"
                        continue
                    fi
                    docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" < "$migration_sql" || {
                        error "Migration $name failed!"
                        exit 1
                    }
                fi
                success "$name completed"
                break
            fi
        done

        if [ "$found" = false ]; then
            error "Unknown migration: $target"
            info "Available migrations:"
            for entry in "${MIGRATIONS[@]}"; do
                IFS='|' read -r name desc _ <<< "$entry"
                echo "  $name — $desc"
            done
            exit 1
        fi
    fi
}

# ── Command: status ───────────────────────────────────────────────────────────
cmd_status() {
    print_banner

    if ! docker ps --format '{{.Names}}' | grep -q "^${DB_CONTAINER}$"; then
        error "Docker container '${DB_CONTAINER}' is not running."
        exit 1
    fi

    echo ""
    info "Migration Status:"
    echo "──────────────────────────────────────────────────────────"

    for entry in "${MIGRATIONS[@]}"; do
        IFS='|' read -r name desc sql_file <<< "$entry"
        echo ""
        info "  $name"
        echo "    $desc"
        echo -n "    File: $sql_file"

        # Check if applied
        local applied=false
        case "$name" in
            ranking-summary|fix-trigger-unnest)
                local has
                has=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
                    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'player_lifetime_stats');" 2>/dev/null || echo "false")
                [ "$has" = "t" ] && applied=true
                ;;
            devices-table)
                local has
                has=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
                    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'devices');" 2>/dev/null || echo "false")
                [ "$has" = "t" ] && applied=true
                ;;
            token-version)
                local has
                has=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
                    "SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'token_version';" 2>/dev/null || echo "0")
                [ "$has" != "0" ] && applied=true
                ;;
            cache-notify-triggers)
                local has
                has=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
                    "SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'matches_cache_invalidation';" 2>/dev/null || echo "0")
                [ "$has" != "0" ] && applied=true
                ;;
            score-difference)
                local has
                has=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
                    "SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'matches' AND column_name = 'score_difference';" 2>/dev/null || echo "0")
                [ "$has" != "0" ] && applied=true
                ;;
            daily-stats)
                local has
                has=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
                    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'player_daily_stats');" 2>/dev/null || echo "false")
                [ "$has" = "t" ] && applied=true
                ;;
            site-images)
                local has
                has=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
                    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'site_images');" 2>/dev/null || echo "false")
                [ "$has" = "t" ] && applied=true
                ;;
            season-results)
                local has
                has=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
                    "SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'seasons' AND column_name IN ('final_results', 'conclusion_image_path');" 2>/dev/null || echo "0")
                [ "$has" = "2" ] && applied=true
                ;;
            cup-tournaments)
                local has
                has=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
                    "SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN ('cups', 'cup_participants', 'cup_matches', 'cup_advancements');" 2>/dev/null || echo "0")
                [ "$has" = "4" ] && applied=true
                ;;
            *)
                # Assume performance-indexes and match-details-view are applied if DB exists
                applied=true
                ;;
        esac

        if [ "$applied" = true ]; then
            success "  ✓ Applied"
        else
            echo -e "  ${RED}✗ Not applied${NC}"
        fi
    done
    echo ""
}

# ── Command: all ──────────────────────────────────────────────────────────────
cmd_all() {
    print_banner
    info "Step 1/2: Setting up database..."
    echo ""
    cmd_setup
    echo ""
    info "Step 2/2: Running all migrations..."
    echo ""
    cmd_migrate "all"
}

# ── Main dispatch ─────────────────────────────────────────────────────────────
case "$COMMAND" in
    setup)        cmd_setup ;;
    migrate)      cmd_migrate "${1:-all}" ;;
    all)          cmd_all ;;
    status)       cmd_status ;;
    help|--help|-h) print_usage ;;
    *)            error "Unknown command: $COMMAND"; print_usage; exit 1 ;;
esac
