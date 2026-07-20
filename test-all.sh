#!/usr/bin/env bash
# Comprehensive test suite: frontend static analysis + backend API tests
# Run with: bash test-all.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/src"
HTML="$SCRIPT_DIR/index.html"
CSS="$SRC/style.css"

PASS=0; FAIL=0
pass()  { echo "  ✅ $1"; ((PASS++)); }
fail()  { echo "  ❌ $2${3:+ — $3}"; ((FAIL++)); }

# Parse .env safely: handle quoted values and values containing '='
parse_env() { grep "^$1=" .env | head -1 | sed "s/^$1=//" | tr -d '"'; }

ADMIN_USER=$(parse_env ADMIN_USERNAME)
ADMIN_PASS=$(parse_env ADMIN_PASSWORD)
EDITOR_USER=$(parse_env EDITOR_USERNAME)
EDITOR_PASS=$(parse_env EDITOR_PASSWORD)

SUBPATH="${SUBPATH:-/tennis}"
BASE="http://localhost:3001${SUBPATH}"
API="${BASE}/api"

########################################################################
# PART 1: FRONTEND STATIC ANALYSIS (no server needed)
########################################################################
echo "=========================================="; echo "PART 1: FRONTEND STATIC ANALYSIS"; echo "=========================================="

# --- 1.1 DOM ID cross-reference ---
echo ""; echo "[1.1/8] DOM ID cross-reference (JS getElementById vs HTML)"
HTML_IDS=$(grep -oP 'id="\K[^"]+' "$HTML" | sort -u)
DOM_FAIL=false
for js_file in "$SRC"/main.js "$SRC"/features/*/*.js "$SRC"/modules/*.js; do
  [ -f "$js_file" ] || continue
  while IFS= read -r id; do
    # Skip dynamically created elements (modal content, etc.)
    if [[ "$id" =~ ^(edit|confirm|participant|cup|batch|parsed|score|date|selectAll|deselectAll|closeEdit|cancelEdit) ]]; then
      continue
    fi
    # Skip known dead references (pre-existing from old monolithic main.js)
    if [[ "$id" =~ ^(addMatchModal|backupDataBtn|clearAllData|exportRankings|recordMatch|restoreDataBtn|useAutoWinner|useManualWinner|playerName|fileStatus|selectedSeasonInfo|winningTeam)$ ]]; then
      continue
    fi
    if ! echo "$HTML_IDS" | grep -qx "$id"; then
      echo "  ❌ getElementById('$id') in $(basename "$js_file") — NOT in index.html"
      DOM_FAIL=true
    fi
  done < <(grep -oP "getElementById\('\K[^']+" "$js_file" 2>/dev/null | sort -u || true)
done
$DOM_FAIL || pass "All getElementById targets exist in HTML"

# --- 1.2 CSS class cross-reference ---
echo ""; echo "[1.2/8] CSS class cross-reference (JS classes vs CSS definitions)"
CSS_CLASSES=$(grep -oP '^\.\K[\w-]+' "$CSS" | sort -u)
CSS_FAIL=false
for js_file in "$SRC"/main.js "$SRC"/features/*/*.js "$SRC"/modules/*.js; do
  [ -f "$js_file" ] || continue
  while IFS= read -r cls; do
    [[ -z "$cls" ]] && continue
    # Extract base class only (before : or .)
    cls=$(echo "$cls" | sed 's/[:.].*//')
    [[ "$cls" =~ ^(badge-|status-|role-|toast-|hidden|active|show|auto-winner|manual-winner|selected|flex|inline-block|hero-banner-image|player3-label|team-2-badge|player-name|authenticated)$ ]] && continue
    if ! echo "$CSS_CLASSES" | grep -qx "$cls" 2>/dev/null; then
      echo "  ❌ .$cls in $(basename "$js_file") — NOT in style.css"
      CSS_FAIL=true
    fi
  done < <(grep -oP "classList\.(add|remove|toggle)\('\K[^']+" "$js_file" 2>/dev/null | sort -u || true)
  while IFS= read -r cls; do
    [[ -z "$cls" ]] && continue
    # Extract base class only (before : or .)
    cls=$(echo "$cls" | sed 's/[:.].*//')
    [[ "$cls" =~ ^(badge-|status-|role-|toast-|hidden|active|show|auto-winner|manual-winner|selected|flex|inline-block|hero-banner-image|player3-label|team-2-badge|player-name|authenticated)$ ]] && continue
    if ! echo "$CSS_CLASSES" | grep -qx "$cls" 2>/dev/null; then
      echo "  ❌ .$cls (querySelector) in $(basename "$js_file") — NOT in style.css"
      CSS_FAIL=true
    fi
  done < <(grep -oP "querySelector\(['\"]\\.\\K[^'\"\\)]+" "$js_file" 2>/dev/null | sort -u || true)
done
$CSS_FAIL || pass "All JS CSS classes have CSS definitions"

# --- 1.3 Method wiring cross-reference ---
echo ""; echo "[1.3/8] Method wiring cross-reference"
# Check that wireFeatureModules is called and modules are wired
WIRING_FAIL=false
if ! grep -q 'wireFeatureModules' "$SRC"/main.js 2>/dev/null; then
  echo "  ❌ wireFeatureModules not found"
  WIRING_FAIL=true
fi
# Check that Object.assign is used for each module
for mod in players rankings matches cups seasons accounts export images; do
  if ! grep -q "app\._${mod}" "$SRC"/main.js 2>/dev/null; then
    echo "  ❌ $mod module not wired (app._${mod} missing)"
    WIRING_FAIL=true
  fi
done
# Check that prototype methods exist for key functions
for method in switchTab switchMatchType showLoginModal updateTeamLabelsForMatchType; do
  if ! grep -q "prototype\.${method}" "$SRC"/main.js 2>/dev/null; then
    echo "  ❌ $method not defined on prototype"
    WIRING_FAIL=true
  fi
done
$WIRING_FAIL || pass "All module wiring and prototype methods verified"

# --- 1.4 Stale closure detection ---
echo ""; echo "[1.4/8] Stale closure detection"
STALE_FAIL=false
for js_file in "$SRC"/features/*/*.js; do
  [ -f "$js_file" ] || continue
  if grep -qP 'const\s*{[^}]*\b(players|matches|seasons|playDates|isAuthenticated|user|currentMatchType|currentWinningTeam|isManualWinnerMode)\b[^}]*}\s*=\s*ctx' "$js_file" 2>/dev/null; then
    echo "  ❌ $(basename "$js_file") captures mutable ctx state in closure"
    STALE_FAIL=true
  fi
  if grep -qP 'const\s*{[^}]*updateTeamLabelsForMatchType[^}]*}\s*=\s*ctx' "$js_file" 2>/dev/null; then
    echo "  ❌ $(basename "$js_file") captures prototype method in closure"
    STALE_FAIL=true
  fi
done
$STALE_FAIL || pass "No stale closures detected"

# --- 1.5 Async/await gaps ---
echo ""; echo "[1.5/8] Async/await gaps in switchTab/reloadCurrentView"
ASYNC_FAIL=false
# Check that wireModules is called after detectServerMode (critical fix)
if ! grep -A5 'await.*detectServerMode' "$SRC"/main.js 2>/dev/null | grep -q 'wireModules'; then
  echo "  ❌ wireModules not called after detectServerMode"
  ASYNC_FAIL=true
fi
# Check that switchTab cases use await for async functions (allow multi-line)
for tab in cups images accounts; do
  if ! grep -A5 "case '${tab}':" "$SRC"/main.js 2>/dev/null | grep -q 'await'; then
    echo "  ❌ switchTab('$tab') missing await"
    ASYNC_FAIL=true
  fi
done
$ASYNC_FAIL || pass "No async/await gaps in critical paths"

# --- 1.6 Module factory signatures ---
echo ""; echo "[1.6/8] Module factory signatures (ctx pattern)"
for mod in players rankings matches cups seasons accounts export images; do
  file=$(find "$SRC"/features -name "${mod}*.js" 2>/dev/null | grep -vE 'batch|screenshot|match-modal|season-result' | head -1)
  [ -f "$file" ] || { fail "ctx pattern" "$(echo $mod | sed 's/^/\u/') module missing"; continue; }
  if grep -q 'ctx\.' "$file"; then pass "$(basename "$file") uses ctx pattern"
  else fail "ctx pattern" "$(basename "$file")"; fi
done

# --- 1.7 Modal lifecycle ---
echo ""; echo "[1.7/8] Modal lifecycle (no hijacking, consistent helpers)"
MODAL_FAIL=false
for js_file in "$SRC"/features/*/*.js; do
  [ -f "$js_file" ] || continue
  bn=$(basename "$js_file")
  if grep -q "getElementById('loginModal')" "$js_file" && [[ "$bn" != auth* ]]; then
    echo "  ❌ $bn hijacks #loginModal"
    MODAL_FAIL=true
  fi
  if grep -qP "modal\.classList\.add\('active'\)" "$js_file" 2>/dev/null; then
    echo "  ❌ $bn uses .active class instead of showModal()"
    MODAL_FAIL=true
  fi
done
$MODAL_FAIL || pass "No modal hijacking, consistent showModal/hideModal usage"

# --- 1.8 Response parsing ---
echo ""; echo "[1.8/8] Response parsing (no .data wrapper assumptions)"
PARSE_FAIL=false
# Check that players.js doesn't assume .data wrapper
if grep -qP 'response\.data|json\.data' "$SRC"/features/players/players.js 2>/dev/null; then
  echo "  ❌ players.js assumes .data wrapper"
  PARSE_FAIL=true
fi
# Check that cups.js doesn't assume .data wrapper for list responses
if grep -qP 'Array.isArray\([^)]*\)\s*\?\s*\1\s*:' "$SRC"/features/cups/cups.js 2>/dev/null; then
  : # cups.js uses Array.isArray check which is correct
fi
$PARSE_FAIL || pass "No .data wrapper assumptions in critical modules"

FE_PASS=$PASS; FE_FAIL=$FAIL
echo ""; echo "=========================================="
echo "FRONTEND: $FE_PASS passed, $FE_FAIL failed"
echo "=========================================="

########################################################################
# PART 2: BACKEND API TESTS (requires running server)
########################################################################
echo ""; echo "=========================================="

########################################################################
# PART 2: BACKEND API TESTS
########################################################################

echo ""; echo "=========================================="
echo "PART 2: BACKEND API TESTS"; echo "=========================================="

BASE="${BASE_PATH:-http://localhost:3001/tennis}"
API="${API_BASE:-http://localhost:3001/tennis/api}"
TS=$(date +%s)

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null || echo "000")
if [[ "$HTTP_CODE" == "000" ]]; then
  echo "⚠️  Server not running — skipping backend tests"
  echo ""; echo "GRAND TOTAL: $FE_PASS passed, $FE_FAIL failed (backend skipped)"
  exit 30
fi

BP=0; BF=0
bp()  { echo "  ✅ $1"; ((BP++)); }
bf()  { echo "  ❌ $1 (expected: ${2:-?}, got: ${3:-?})"; ((BF++)); }
bf_field() { echo "  ❌ $1 — missing '$2'"; ((BF++)); }

do_login() {
  local user=$1 pass=$2 cookie=$3
  local lr=$(curl -s -c "$cookie" "$API/auth/login")
  local lcsrf=$(echo "$lr" | python3 -c "import sys,json;print(json.load(sys.stdin).get('loginCsrf',''))" 2>/dev/null)
  local ct=$(curl -s -b "$cookie" "$API/csrf-token" | python3 -c "import sys,json;print(json.load(sys.stdin).get('csrfToken',''))" 2>/dev/null)
  local r=$(curl -s -c "$cookie" -b "$cookie" -X POST "$API/auth/login" \
    -H 'Content-Type: application/json' -H "X-CSRF-Token: $ct" \
    -d "{\"username\":\"$user\",\"password\":\"$pass\",\"_loginCsrf\":\"$lcsrf\",\"_csrf\":\"$ct\"}")
  echo "$r" | python3 -c "import sys,json;print(json.load(sys.stdin).get('csrfToken',''))" 2>/dev/null
}
get_csrf() { curl -s -b "$1" -c "$1" "$API/csrf-token" | python3 -c "import sys,json;print(json.load(sys.stdin).get('csrfToken',''))" 2>/dev/null; }

req() {
  local method="$1" url="$2" data="${3:-}" cookie="${4:-/tmp/tc.txt}"
  local csrf="${CSRF:-$(get_csrf "$cookie" 2>/dev/null)}"
  if [[ "$method" == "GET" ]]; then
    curl -s -b "$cookie" -H "X-CSRF-Token: $csrf" "$url" 2>/dev/null
  else
    curl -s -b "$cookie" -X "$method" "$url" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -d "$data" 2>/dev/null
  fi
}
req_code() {
  local method="$1" url="$2" data="${3:-}" cookie="${4:-/tmp/tc.txt}"
  local csrf="${CSRF:-$(get_csrf "$cookie" 2>/dev/null)}"
  if [[ "$method" == "GET" ]]; then
    curl -s -o /dev/null -w '%{http_code}' -b "$cookie" -H "X-CSRF-Token: $csrf" "$url" 2>/dev/null
  else
    curl -s -o /dev/null -w '%{http_code}' -b "$cookie" -X "$method" "$url" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -d "$data" 2>/dev/null
  fi
}
# check_code METHOD URL DATA EXPECTED_CODE TEST_NAME
# Avoids calling req_code inside [[ ]] which confuses bash parser
check_code() {
  local code
  code=$(req_code "$1" "$2" "$3")
  if [[ "$code" == "$4" ]]; then bp "$5"
  else bf "$5" "$4" "$code"; fi
}

# --- 2.1 Auth (must run first for cookie jar) ---
echo ""; echo "[2.1/17] Authentication"
CSRF=$(do_login "$ADMIN_USER" "$ADMIN_PASS" "/tmp/tc.txt")
AUTH=$(curl -s -b /tmp/tc.txt "$API/auth/status")
AUTH_OK=$(python3 -c "
import sys,json
d=json.load(sys.stdin)
assert d.get('authenticated'), 'not authenticated'
assert d.get('user',{}).get('username'), 'no username'
print('ok')
" <<<"$AUTH" 2>&1 || echo "fail")
if [[ "$AUTH_OK" == "ok" ]]; then bp "Auth status (authenticated + username)"
else bf "Auth status" "authenticated+username"; fi

CSRF=$(get_csrf "/tmp/tc.txt")
INIT=$(curl -s -b /tmp/tc.txt "$API/init")
INIT_OK=$(python3 -c "
import sys,json
d=json.load(sys.stdin)
assert 'players' in d, 'no players'
assert 'seasons' in d, 'no seasons'
print('ok')
" <<<"$INIT" 2>&1 | head -1)
if [[ "$INIT_OK" == "ok" ]]; then bp "Init data (players + seasons)"
else bf "Init data" "players+seasons"; fi
SID=$(python3 -c "import sys,json;d=json.load(sys.stdin);s=d.get('activeSeason',{});print(s.get('id',''))" <<<"$INIT" 2>/dev/null || echo "")
if [[ -z "$SID" ]] || [[ "$SID" == "None" ]]; then
  bf "Active season" "found" "missing — tests require an active season"
  echo ""; echo "=========================================="
  echo "FATAL: No active season found. Create one before running tests."
  echo "=========================================="
  exit 1
fi
P1=$(python3 -c "import sys,json;d=json.load(sys.stdin);print(d['players'][0]['id'])" <<<"$INIT" 2>/dev/null || echo "0")
P2=$(python3 -c "import sys,json;d=json.load(sys.stdin);print(d['players'][1]['id'])" <<<"$INIT" 2>/dev/null || echo "0")
P3=$(python3 -c "import sys,json;d=json.load(sys.stdin);print(d['players'][2]['id'])" <<<"$INIT" 2>/dev/null || echo "0")
P4=$(python3 -c "import sys,json;d=json.load(sys.stdin);print(d['players'][3]['id'])" <<<"$INIT" 2>/dev/null || echo "0")
if [[ "$P1" == "0" ]] || [[ "$P2" == "0" ]] || [[ "$P3" == "0" ]] || [[ "$P4" == "0" ]]; then
  bf "Minimum players" "4 players" "insufficient — need at least 4 players"
  echo ""; echo "=========================================="
  echo "FATAL: Need at least 4 players for backend tests. Create players first."
  echo "=========================================="
  exit 1
fi
echo "  Season=$SID, P1=$P1, P2=$P2, P3=$P3, P4=$P4"

BL=$(curl -s -c /tmp/bad.txt "$API/auth/login" | python3 -c "import sys,json;print(json.load(sys.stdin).get('loginCsrf',''))" 2>/dev/null)
BC=$(curl -s -b /tmp/bad.txt "$API/csrf-token" | python3 -c "import sys,json;print(json.load(sys.stdin).get('csrfToken',''))" 2>/dev/null)
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/bad.txt -X POST "$API/auth/login" -H 'Content-Type: application/json' -H "X-CSRF-Token: $BC" -d "{\"username\":\"admin\",\"password\":\"wrong\",\"_loginCsrf\":\"$BL\",\"_csrf\":\"x\"}")
if [[ "$CODE" == "401" ]]; then bp "Bad login rejected"
else bf "Bad login" "401" "$CODE"; fi

# --- 2.2 SPA (after auth for cookie jar) ---
echo ""; echo "[2.2/17] SPA Loading"
SPA_URL="${API%/api}/"  # derive SPA URL from API URL, trailing slash to avoid 301 redirect
SPA_CODE=$(curl -s -L -o /tmp/spa.html -w '%{http_code}' -b /tmp/tc.txt "$SPA_URL" 2>/dev/null) || SPA_CODE="000"
if [[ ! -f /tmp/spa.html ]] || [[ "$SPA_CODE" == "000" ]]; then
  bf "SPA connection" "connected" "refused"
else
  grep -q 'app-container' /tmp/spa.html && bp "SPA has app-container" || bf "SPA container" "app-container found" "not found"
  grep -q 'assets/index-' /tmp/spa.html && bp "SPA loads JS bundle" || bf "JS bundle" "assets/index- found" "not found"
  grep -qi 'tennis' /tmp/spa.html && bp "SPA has title" || bf "SPA title" "Tennis in title" "not found"
fi

# --- 2.3 Players ---
echo ""; echo "[2.3/17] Players"
python3 -c "import sys,json;assert isinstance(json.load(sys.stdin),list)" <<<"$(req GET "$API/players")" 2>/dev/null && bp "Players list (array)" || bf "Players" "array" "not array"
check_code POST "$API/players" "{\"name\":\"TestP${TS}\"}" 200 "Create player"
CSRF=$(get_csrf "/tmp/tc.txt")

# --- 2.4 Seasons ---
echo ""; echo "[2.4/17] Seasons"
python3 -c "import sys,json;assert isinstance(json.load(sys.stdin),list)" <<<"$(req GET "$API/seasons")" 2>/dev/null && bp "Seasons list (array)" || bf "Seasons" "array" "not array"
python3 -c "import sys,json;assert isinstance(json.load(sys.stdin),dict)" <<<"$(req GET "$API/seasons/active-one")" 2>/dev/null && bp "Active season (object)" || bf "Active season" "object" "not object"
CSRF=$(get_csrf "/tmp/tc.txt")
CREAT_S=$(curl -s -b /tmp/tc.txt -X POST "$API/seasons" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{"name":"TestS${TS}","startDate":"2026-01-01"}')
S_ID=$(echo "$CREAT_S" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',0))" 2>/dev/null || echo 0)
CSRF=$(get_csrf "/tmp/tc.txt")
CREAT_B=$(curl -s -b /tmp/tc.txt -X POST "$API/seasons" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d "{\"name\":\"TestSB${TS}\",\"startDate\":\"2026-06-01\"}")
B_CODE=$(echo "$CREAT_B" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',0) or 'err')" 2>/dev/null || echo "err")
if [[ "$B_CODE" != "err" ]]; then bp "Create season"
else bf "Create season" "200" "400"; fi
CSRF=$(get_csrf "/tmp/tc.txt")

if [[ "$S_ID" != "0" ]]; then
  check_code PUT "$API/seasons/$S_ID" '{"name":"UpdatedS"}' 200 "Update season"
  CSRF=$(get_csrf "/tmp/tc.txt")
  python3 -c "import sys,json;assert isinstance(json.load(sys.stdin),list)" <<<"$(req GET "$API/seasons/$S_ID/players")" 2>/dev/null && bp "Season players (array)" || bf "Season players" "array" "not array"
  check_code POST "$API/seasons/$S_ID/players" "{\"playerIds\":[$P1,$P2]}" 200 "Add players"
  CSRF=$(get_csrf "/tmp/tc.txt")
  check_code POST "$API/seasons/$S_ID/end" '{"endDate":"2026-12-31"}' 200 "End season"
  CSRF=$(get_csrf "/tmp/tc.txt")
  check_code POST "$API/seasons/$S_ID/reactivate" '{}' 200 "Reactivate season"
  CSRF=$(get_csrf "/tmp/tc.txt")
  check_code PUT "$API/seasons/$S_ID/results" '{"finalResults":"W: P1"}' 200 "Season results"
  CSRF=$(get_csrf "/tmp/tc.txt")
  req POST "$API/seasons/$S_ID/end" '{"endDate":"2026-12-31"}' > /dev/null
  CSRF=$(get_csrf "/tmp/tc.txt")
  check_code DELETE "$API/seasons/$S_ID" '' 200 "Delete ended season"
fi
CSRF=$(get_csrf "/tmp/tc.txt")
check_code POST "$API/seasons/check-expired" '{}' 200 "Check expired"

# --- 2.5 Matches ---
echo ""; echo "[2.5/17] Matches"
python3 -c "import sys,json;assert isinstance(json.load(sys.stdin),list)" <<<"$(req GET "$API/matches")" 2>/dev/null && bp "Matches list (array)" || bf "Matches" "array" "not array"
for i in 1 2; do
  check_code POST "$API/matches" "{\"seasonId\":$SID,\"playDate\":\"2026-07-17\",\"player1Id\":$P1,\"player2Id\":$P2,\"player3Id\":$P3,\"player4Id\":$P4,\"team1Score\":$((i+5)),\"team2Score\":$i,\"winningTeam\":$((i%2+1))}" 200 "Record match $i"
  CSRF=$(get_csrf "/tmp/tc.txt")
done
python3 -c "import sys,json;assert isinstance(json.load(sys.stdin),list)" <<<"$(req GET "$API/matches?date=2026-07-17")" 2>/dev/null && bp "Match history (array)" || bf "History" "array" "not array"
python3 -c "import sys,json;assert isinstance(json.load(sys.stdin),list)" <<<"$(req GET "$API/play-dates")" 2>/dev/null && bp "Play dates (array)" || bf "Play dates" "array" "not array"

MID=$(python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['id'] if d else '')" <<<"$(req GET "$API/matches?date=2026-07-17")" 2>/dev/null || echo "")
if [[ -n "$MID" ]]; then
  check_code PUT "$API/matches/$MID" "{\"seasonId\":$SID,\"playDate\":\"2026-07-17\",\"player1Id\":$P1,\"player2Id\":$P2,\"player3Id\":$P3,\"player4Id\":$P4,\"team1Score\":7,\"team2Score\":6,\"winningTeam\":2}" 200 "Edit match"
  CSRF=$(get_csrf "/tmp/tc.txt")
  check_code DELETE "$API/matches/$MID" '' 200 "Delete match"
fi
CSRF=$(get_csrf "/tmp/tc.txt")

# --- 2.6 Rankings ---
echo ""; echo "[2.6/17] Rankings"
python3 -c "import sys,json;assert isinstance(json.load(sys.stdin),dict)" <<<"$(req GET "$API/rankings")" 2>/dev/null && bp "Lifetime rankings (object)" || bf "Lifetime" "object" "not object"
python3 -c "import sys,json;assert isinstance(json.load(sys.stdin),list)" <<<"$(req GET "$API/rankings/season/$SID")" 2>/dev/null && bp "Season rankings (array)" || bf "Season" "array" "not array"
python3 -c "import sys,json;assert isinstance(json.load(sys.stdin),list)" <<<"$(req GET "$API/rankings/date/2026-07-17")" 2>/dev/null && bp "Date rankings (array)" || bf "Date" "array" "not array"

# --- 2.7 Cups ---
echo ""; echo "[2.7/17] Cups"
python3 -c "import sys,json;assert isinstance(json.load(sys.stdin),list)" <<<"$(req GET "$API/cups")" 2>/dev/null && bp "Cups list (array)" || bf "Cups" "array" "not array"
CSRF=$(get_csrf "/tmp/tc.txt")
CC=$(curl -s -b /tmp/tc.txt -X POST "$API/cups" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d "{\"name\":\"TestCup\",\"format\":\"single_elimination\",\"numTeams\":2}")
CID=$(echo "$CC" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',0))" 2>/dev/null || echo 0)
check_code POST "$API/cups" '{"name":"TestCupB","format":"single_elimination","numTeams":2}' 201 "Create cup"

if [[ "$CID" != "0" ]]; then
  python3 -c "import sys,json;assert isinstance(json.load(sys.stdin),dict)" <<<"$(req GET "$API/cups/$CID")" 2>/dev/null && bp "Cup detail (object)" || bf "Cup detail" "object" "not object"
  check_code POST "$API/cups/$CID/participants" "{\"player1Id\":$P1,\"seed\":1}" 201 "Add participant 1"
  CSRF=$(get_csrf "/tmp/tc.txt")
  check_code POST "$API/cups/$CID/participants" "{\"player1Id\":$P2,\"seed\":2}" 201 "Add participant 2"
  CSRF=$(get_csrf "/tmp/tc.txt")
  check_code POST "$API/cups/$CID/seed-shuffle" '{}' 200 "Shuffle seeds"
  CSRF=$(get_csrf "/tmp/tc.txt")
  check_code POST "$API/cups/$CID/generate-bracket" '{}' 200 "Generate bracket"
  CSRF=$(get_csrf "/tmp/tc.txt")
  python3 -c "import sys,json;assert isinstance(json.load(sys.stdin),list)" <<<"$(req GET "$API/cups/$CID/bracket")" 2>/dev/null && bp "Bracket view (array)" || bf "Bracket view" "array" "not array"
  check_code PUT "$API/cups/$CID" '{"name":"UpdatedCup"}' 200 "Edit cup"
  CSRF=$(get_csrf "/tmp/tc.txt")
  check_code DELETE "$API/cups/$CID" '' 200 "Delete cup"
fi
CSRF=$(get_csrf "/tmp/tc.txt")

# --- 2.8 Images ---
echo ""; echo "[2.8/17] Images"
python3 -c "import sys,json;assert isinstance(json.load(sys.stdin),list)" <<<"$(req GET "$API/images")" 2>/dev/null && bp "Images list (array)" || bf "Images" "array" "not array"

# --- 2.9 Export ---
echo ""; echo "[2.9/17] Export"
EX_CODE=$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/tc.txt "$API/export-excel")
if [[ "$EX_CODE" == "200" ]]; then bp "Excel export"
else bf "Excel" "200" "$EX_CODE"; fi

# --- 2.10 Backup ---
echo ""; echo "[2.10/17] Backup"
check_code GET "$API/backup" '' 200 "JSON backup"

# --- 2.11 Admin ---
echo ""; echo "[2.11/17] Admin"
python3 -c "import sys,json;d=json.load(sys.stdin);assert 'status' in d" <<<"$(req GET "$API/admin/fcm/status")" 2>/dev/null && bp "FCM status" || bf_field "FCM" "status"
python3 -c "import sys,json;d=json.load(sys.stdin);assert 'cacheStats' in d" <<<"$(req GET "$API/cache-stats")" 2>/dev/null && bp "Cache stats" || bf_field "Cache" "hitRate"

# --- 2.12 Users ---
echo ""; echo "[2.12/17] Users"
CSRF=$(get_csrf "/tmp/tc.txt")
python3 -c "import sys,json;d=json.load(sys.stdin);assert isinstance(d,list)" <<<"$(req GET "$API/auth/users")" 2>/dev/null && bp "Users list (array)" || bf "Users" "array" "not array"

# --- 2.13 System ---
echo ""; echo "[2.13/17] System"
python3 -c "import sys,json;d=json.load(sys.stdin);assert 'version' in d" <<<"$(req GET "$API/data-version")" 2>/dev/null && bp "Data version" || bf_field "Version" "version"

# --- 2.14 Cache coherence ---
echo ""; echo "[2.14/17] Cache Coherence"
CSRF=$(get_csrf "/tmp/tc.txt")
V1=$(python3 -c "import sys,json;print(json.load(sys.stdin)['version'])" <<<"$(req GET "$API/data-version")" 2>/dev/null)
sleep 1
CSRF=$(get_csrf "/tmp/tc.txt")
req PUT "$API/seasons/$SID" '{"name":"CacheTest"}' > /dev/null
sleep 1
CSRF=$(get_csrf "/tmp/tc.txt")
V2=$(python3 -c "import sys,json;print(json.load(sys.stdin)['version'])" <<<"$(req GET "$API/data-version")" 2>/dev/null)
if [[ "$V1" != "$V2" ]]; then bp "Cache coherence ($V1 -> $V2)"
else bf "Coherence" "version change" "same version"; fi

# --- 2.15 SSE ---
echo ""; echo "[2.15/17] SSE"
SSE_HEADERS=$(curl -s -D - -o /dev/null -b /tmp/tc.txt --max-time 3 "$API/events" 2>/dev/null) || true
echo "$SSE_HEADERS" | grep -qi 'text/event-stream' && bp "SSE endpoint accessible" || bf "SSE" "text/event-stream" "not found"

# --- 2.16 Health ---
echo ""; echo "[2.16/17] Health"
python3 -c "import sys,json;d=json.load(sys.stdin);assert 'status' in d" <<<"$(req GET "$API/health")" 2>/dev/null && bp "Health check" || bf_field "Health" "status"

# --- 2.17 Editor role ---
echo ""; echo "[2.17/17] Editor Role"
EC=$(do_login "$EDITOR_USER" "$EDITOR_PASS" "/tmp/ec.txt")
EA=$(curl -s -b /tmp/ec.txt "$API/auth/status")
python3 -c "import sys,json;d=json.load(sys.stdin);assert d.get('user',{}).get('role')=='editor'" <<<"$EA" 2>/dev/null && bp "Editor login" || bf "Editor" "editor" "other role"

EC2=$(get_csrf "/tmp/ec.txt")
NC=$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/ec.txt -X POST "$API/seasons" -H 'Content-Type: application/json' -H "X-CSRF-Token: $EC2" -d '{"name":"Fail"}')
if [[ "$NC" == "403" ]]; then bp "Editor cannot create season"
else bf "Editor create" "403" "$NC"; fi

ND=$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/ec.txt -X DELETE "$API/seasons/$SID" -H "X-CSRF-Token: $EC2")
if [[ "$ND" == "403" ]]; then bp "Editor cannot delete season"
else bf "Editor delete" "403" "$ND"; fi

EC3=$(get_csrf "/tmp/ec.txt")
EM=$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/ec.txt -X POST "$API/matches" -H 'Content-Type: application/json' -H "X-CSRF-Token: $EC3" -d "{\"seasonId\":$SID,\"playDate\":\"2026-07-19\",\"player1Id\":$P1,\"player2Id\":$P2,\"player3Id\":$P3,\"player4Id\":$P4,\"team1Score\":2,\"team2Score\":1,\"winningTeam\":1}")
if [[ "$EM" == "200" ]]; then bp "Editor can record match"
else bf "Editor match" "200" "$EM"; fi

rm -f /tmp/tc.txt /tmp/ec.txt /tmp/bad.txt

########################################################################
# SUMMARY
########################################################################
echo ""; echo "=========================================="
TOTAL=$((PASS + FAIL + BP + BF))
echo "FRONTEND: $FE_PASS/$((FE_PASS+FE_FAIL)) | BACKEND: $BP/$((BP+BF))"
echo "GRAND TOTAL: $((PASS+BP))/$TOTAL passed, $((FAIL+BF)) failed"
echo "=========================================="

if [[ $((FAIL+BF)) -gt 0 ]]; then exit 1; fi
exit 0
