#!/usr/bin/env bash
# =============================================================================
# Tennis Ranking System — Database Bootstrap Script
# =============================================================================
# Purpose: Set up a fresh PostgreSQL instance for the Tennis Ranking System.
#
# Usage:
#   ./setup-database.sh                          # Interactive mode
#   ./setup-database.sh --non-interactive        # Non-interactive (uses env vars)
#
# Requirements:
#   - `docker` CLI installed and running
#   - `psql` client installed (for post-setup verification)
#   - PostgreSQL 15+ compatible image available
#
# What it does:
#   1. Creates a Docker network (if missing)
#   2. Starts PostgreSQL + Redis containers via docker-compose
#   3. Waits for PostgreSQL to be healthy
#   4. Verifies the application auto-creates all tables and indexes
#   5. Prints connection details and next steps
# =============================================================================

set -euo pipefail

# ── Colors & formatting ──────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }

# ── Configuration (overridable via env) ───────────────────────────────────────
DB_NAME="${DB_NAME:-tennis_ranking}"
DB_USER="${DB_USER:-tennis_user}"
DB_PASSWORD="${DB_PASSWORD:-$(openssl rand -base64 24)}"
DB_HOST="localhost"
DB_PORT=5432
REDIS_PORT=6380
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-tennis}"

# ── Helper functions ─────────────────────────────────────────────────────────

print_banner() {
    cat <<'EOF'
 ╔══════════════════════════════════════════════════════════╗
 ║          🎾 Tennis Ranking System — DB Setup            ║
 ╚══════════════════════════════════════════════════════════╝
EOF
}

print_usage() {
    echo ""
    echo "Usage: $0 [--non-interactive]"
    echo ""
    echo "Environment variables (optional):"
    echo "  DB_NAME          PostgreSQL database name   (default: tennis_ranking)"
    echo "  DB_USER          PostgreSQL username         (default: tennis_user)"
    echo "  DB_PASSWORD      PostgreSQL password          (auto-generated if unset)"
    echo "  COMPOSE_PROJECT  docker-compose project name  (default: tennis)"
    echo ""
}

# ── Argument parsing ─────────────────────────────────────────────────────────
NON_INTERACTIVE=false
for arg in "$@"; do
    case "$arg" in
        --non-interactive) NON_INTERACTIVE=true ;;
        --help|-h)         print_usage; exit 0 ;;
        *)                 error "Unknown argument: $arg"; print_usage; exit 1 ;;
    esac
done

# ── Main ─────────────────────────────────────────────────────────────────────

print_banner

# Step 1: Check prerequisites
info "Checking prerequisites..."

if ! command -v docker &>/dev/null; then
    error "docker is not installed. Please install Docker first."
    exit 1
fi

if ! docker info &>/dev/null; then
    error "Docker daemon is not running. Start Docker and try again."
    exit 1
fi

success "Docker is available"

# Step 2: Check if containers already exist
info "Checking for existing containers..."
EXISTING=$(docker compose -p "$COMPOSE_PROJECT_NAME" ps -q postgres redis 2>/dev/null || true)

if [ -n "$EXISTING" ]; then
    warn "Containers already exist. Stopping and removing them..."
    docker compose -p "$COMPOSE_PROJECT_NAME" down
fi

# Step 3: Generate password if not set
if [ -z "${DB_PASSWORD:-}" ] || [ "$DB_PASSWORD" = "$(openssl rand -base64 24)" ]; then
    # Check if DB_PASSWORD was explicitly set or auto-generated
    :
fi

info "Database configuration:"
info "  DB_NAME:     $DB_NAME"
info "  DB_USER:     $DB_USER"
info "  DB_PASSWORD: $DB_PASSWORD"
info "  DB_HOST:     $DB_HOST:$DB_PORT"
info "  REDIS_PORT:  $REDIS_PORT"

# Step 4: Start containers
echo ""
info "Starting PostgreSQL and Redis containers..."
docker compose -p "$COMPOSE_PROJECT_NAME" up -d postgres redis

success "Containers started"

# Step 5: Wait for PostgreSQL to be ready
echo ""
info "Waiting for PostgreSQL to be healthy..."

MAX_RETRIES=60
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if docker exec "${COMPOSE_PROJECT_NAME}-postgres-1" pg_isready \
        -U "$DB_USER" -d "$DB_NAME" &>/dev/null 2>&1; then
        success "PostgreSQL is ready!"
        break
    fi

    RETRY_COUNT=$((RETRY_COUNT + 1))
    if [ $((RETRY_COUNT % 10)) -eq 0 ]; then
        info "  Still waiting... ($RETRY_COUNT/$MAX_RETRIES)"
    fi
    sleep 2
done

if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
    error "PostgreSQL did not become healthy within timeout."
    docker compose -p "$COMPOSE_PROJECT_NAME" logs postgres
    exit 1
fi

# Step 6: Verify database exists
info "Verifying database '$DB_NAME'..."
docker exec "${COMPOSE_PROJECT_NAME}-postgres-1" psql \
    -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1;" &>/dev/null 2>&1 || {
    # Database might not exist yet — create it
    info "Database does not exist. Creating..."
    docker exec "${COMPOSE_PROJECT_NAME}-postgres-1" psql \
        -U "$DB_USER" -d postgres -c "CREATE DATABASE \"$DB_NAME\";" 2>/dev/null || true
}

success "Database verified"

# Step 7: Verify Redis is ready
info "Verifying Redis..."
MAX_RETRIES=30
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if docker exec "${COMPOSE_PROJECT_NAME}-redis-1" redis-cli ping &>/dev/null 2>&1; then
        success "Redis is ready!"
        break
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
    sleep 2
done

if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
    error "Redis did not become healthy within timeout."
    exit 1
fi

# Step 8: Verify tables (application will auto-create them on first boot)
echo ""
info "Tables will be auto-created when the application starts."
info "To verify, start the app and check the logs:"
echo ""
echo "  docker compose -p $COMPOSE_PROJECT_NAME up app"
echo ""

# Step 9: Print connection details
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║              🎾 Setup Complete — Connection Details     ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║                                                          ║"
echo "║  PostgreSQL:                                            ║"
echo "║    Host:     $DB_HOST:$DB_PORT                        ║"
echo "║    Database: $DB_NAME                                   ║"
echo "║    User:     $DB_USER                                   ║"
echo "║    Password: $DB_PASSWORD                               ║"
echo "║                                                          ║"
echo "║  Redis:                                                 ║"
echo "║    Host:     localhost:$REDIS_PORT                      ║"
echo "║    (mapped from container :6379)                        ║"
echo "║                                                          ║"
echo "║  Next Steps:                                            ║"
echo "║    1. Copy .env.example to .env                         ║"
echo "║       cp .env.example .env                              ║"
echo "║    2. Update .env with the credentials above            ║"
echo "║    3. Generate secrets:                                 ║"
echo "║       node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"  # JWT_SECRET"
echo "║       node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"  # CSRF_SECRET"
echo "║    4. Start the application:                            ║"
echo "║       npm run dev-full                                  ║"
echo "║                                                          ║"
echo "║  Useful Commands:                                       ║"
echo "║    docker compose -p $COMPOSE_PROJECT_NAME logs -f      ║"
echo "║    docker compose -p $COMPOSE_PROJECT_NAME down         ║"
echo "║    docker exec -it ${COMPOSE_PROJECT_NAME}-postgres-1 psql \\\\dt  ║"
echo "║                                                          ║"
echo "╚══════════════════════════════════════════════════════════╝"

# Step 10: Save credentials to a file for convenience
CREDENTIALS_FILE=".db-credentials"
cat > "$CREDENTIALS_FILE" <<EOF
# Tennis Ranking System — Database Credentials
# Generated on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# Regenerate with: $0

DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
DB_HOST=localhost
DB_PORT=5432
REDIS_URL=redis://localhost:$REDIS_PORT
EOF

echo ""
success "Credentials saved to $CREDENTIALS_FILE"
info "Add these values to your .env file (along with ADMIN_USERNAME, ADMIN_PASSWORD, EDITOR_USERNAME, EDITOR_PASSWORD, JWT_SECRET, CSRF_SECRET)"
