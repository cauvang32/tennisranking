#!/bin/bash
# Combined verification suite: frontend static checks + backend API tests
# Run with: bash test-all.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/src"

PASS=0
FAIL=0
TOTAL=0

assert() {
  local name="$1" condition="$2" detail="${3:-}"
  TOTAL=$((TOTAL+1))
  if [ "$condition" = "true" ]; then
    PASS=$((PASS+1)); echo "  ✅ $name"
  else
    FAIL=$((FAIL+1)); echo "  ❌ $name${detail:+ — $detail}"
  fi
}

# Helper: read file content
read_file() {
  cat "$SRC_DIR/$1" 2>/dev/null || echo ""
}

# ──────────────────────────────────────────────────────────────────────
# PART 1: FRONTEND STATIC CHECKS (no server required)
# ──────────────────────────────────────────────────────────────────────

echo "=========================================="
echo "PART 1: FRONTEND STATIC CHECKS"
echo "=========================================="

# Read source files
PLAYERS_CODE=$(read_file "features/players/players.js")
RANKINGS_CODE=$(read_file "features/rankings/rankings.js")
MATCHES_CODE=$(read_file "features/matches/matches.js")
CUPS_CODE=$(read_file "features/cups/cups.js")
SEASONS_CODE=$(read_file "features/seasons/seasons.js")
ACCOUNTS_CODE=$(read_file "features/accounts/accounts.js")
EXPORT_CODE=$(read_file "features/export/export.js")
IMAGES_CODE=$(read_file "features/images/images.js")
MAIN_CODE=$(read_file "main.js")
AUTH_CODE=$(read_file "modules/auth-manager.js")
CSRF_CODE=$(read_file "modules/csrf-handler.js")

# --- 1. Module factory signatures ---
echo ""; echo "[1/8] Module factory signatures (must use ctx pattern)"

assert "Players module uses ctx pattern" \
  "$(echo "$PLAYERS_CODE" | grep -q 'createPlayersModule(ctx)' && echo true || echo false)" \
  "Found multi-arg signature instead"

assert "Rankings module uses ctx pattern" \
  "$(echo "$RANKINGS_CODE" | grep -q 'createRankingsModule(ctx)' && echo true || echo false)" \
  "Found multi-arg signature instead"

assert "Matches module uses ctx pattern" \
  "$(echo "$MATCHES_CODE" | grep -q 'createMatchesModule(ctx)' && echo true || echo false)" \
  "Found multi-arg signature instead"

assert "Cups module uses ctx pattern" \
  "$(echo "$CUPS_CODE" | grep -q 'createCupsModule(ctx)' && echo true || echo false)" \
  "Found multi-arg signature instead"

assert "Seasons module uses ctx pattern" \
  "$(echo "$SEASONS_CODE" | grep -q 'createSeasonsModule(ctx)' && echo true || echo false)" \
  "Found multi-arg signature instead"

assert "Accounts module uses ctx pattern" \
  "$(echo "$ACCOUNTS_CODE" | grep -q 'createAccountsModule(ctx)' && echo true || echo false)" \
  "Found multi-arg signature instead"

assert "Export module uses ctx pattern" \
  "$(echo "$EXPORT_CODE" | grep -q 'createExportModule(ctx)' && echo true || echo false)" \
  "Found multi-arg signature instead"

assert "Images module uses ctx pattern" \
  "$(echo "$IMAGES_CODE" | grep -q 'createImagesModule(ctx)' && echo true || echo false)" \
  "Found multi-arg signature instead"

assert "Players module does not use state.get()" \
  "$(echo "$PLAYERS_CODE" | grep -q 'state\.get(' && echo false || echo true)" \
  "Found state.get() calls"

assert "Rankings module does not use state.get()" \
  "$(echo "$RANKINGS_CODE" | grep -q 'state\.get(' && echo false || echo true)" \
  "Found state.get() calls"

assert "Players module does not use api.createPlayer()" \
  "$(echo "$PLAYERS_CODE" | grep -qE 'api\.(createPlayer|deletePlayer)\(' && echo false || echo true)" \
  "Found old API method calls"

assert "Rankings module does not use api.getRankings()" \
  "$(echo "$RANKINGS_CODE" | grep -q 'api\.getRankings(' && echo false || echo true)" \
  "Found old API method calls"

# --- 2. main.js wiring ---
echo ""; echo "[2/8] main.js wiring (must pass single ctx arg)"

assert "Players wired with single ctx arg" \
  "$(echo "$MAIN_CODE" | grep -q 'createPlayersModule(app)' && echo true || echo false)" \
  "Found multi-arg wiring"

assert "Rankings wired with single ctx arg" \
  "$(echo "$MAIN_CODE" | grep -q 'createRankingsModule(app)' && echo true || echo false)" \
  "Found multi-arg wiring"

assert "No broken createPlayersModule(app, app, app) pattern" \
  "$(echo "$MAIN_CODE" | grep -q 'createPlayersModule(app, app, app' && echo false || echo true)" \
  "Found broken 3-arg wiring"

assert "No broken createRankingsModule(app, app, app) pattern" \
  "$(echo "$MAIN_CODE" | grep -q 'createRankingsModule(app, app, app' && echo false || echo true)" \
  "Found broken 3-arg wiring"

# --- 3. API endpoint paths ---
echo ""; echo "[3/8] API endpoint paths"

assert "Match creation uses correct field names" \
  "$(echo "$MATCHES_CODE" | grep -q 'player1Id' && echo "$MATCHES_CODE" | grep -q 'player3Id' && \
   echo "$MATCHES_CODE" | grep -q 'team1Score' && echo "$MATCHES_CODE" | grep -q 'winningTeam' && \
   echo true || echo false)" \
  "Missing required match fields"

assert "Cup creation uses single_elimination format" \
  "$(echo "$CUPS_CODE" | grep -q 'single_elimination' && echo true || echo false)" \
  'Found "duo" format instead of single_elimination'

assert "Cup participants uses player1Id (not playerIds array)" \
  "$(echo "$CUPS_CODE" | grep -q 'player1Id' && ! echo "$CUPS_CODE" | grep -q '"playerIds"' && \
   echo true || echo false)" \
  "Uses playerIds array instead of player1Id"

assert "Cup bracket uses generate-bracket endpoint" \
  "$(echo "$CUPS_CODE" | grep -q 'generate-bracket' && echo true || echo false)" \
  "Found /bracket instead of /generate-bracket"

assert "Cup shuffle uses seed-shuffle endpoint" \
  "$(echo "$CUPS_CODE" | grep -q 'seed-shuffle' && echo true || echo false)" \
  "Found /shuffle-seeds instead of /seed-shuffle"

# --- 4. Auth flow ---
echo ""; echo "[4/8] Auth flow"

assert "Login uses /api/auth/login endpoint" \
  "$(echo "$AUTH_CODE" | grep -q '/auth/login' && echo true || echo false)" \
  "Found /api/login instead"

assert "Login uses loginCsrf double-submit pattern" \
  "$(echo "$AUTH_CODE" | grep -q 'loginCsrf' && echo "$AUTH_CODE" | grep -q '_loginCsrf' && \
   echo true || echo false)" \
  "Missing loginCsrf flow"

assert "Auth status uses /api/auth/status endpoint" \
  "$(echo "$AUTH_CODE" | grep -q '/auth/status' && echo true || echo false)" \
  "Found /api/auth-status instead"

assert "Logout uses /api/auth/logout endpoint" \
  "$(echo "$AUTH_CODE" | grep -q '/auth/logout' && echo true || echo false)" \
  "Found /api/logout instead"

assert "makeAuthenticatedRequest injects X-CSRF-Token header" \
  "$(echo "$CSRF_CODE" | grep -q 'X-CSRF-Token' && echo true || echo false)" \
  "Missing CSRF header injection"

# --- 5. Response parsing ---
echo ""; echo "[5/8] Response parsing (must handle plain arrays/objects)"

assert "Players list parsed as plain array" \
  "$(echo "$PLAYERS_CODE" | grep -qE 'data\.players|response\.data' && echo false || echo true)" \
  "Expects {data: [...]} wrapper"

assert "Cups list uses Array.isArray check" \
  "$(echo "$CUPS_CODE" | grep -q 'Array.isArray' && echo true || echo false)" \
  "No array type check"

assert "Seasons reads from ctx.seasons directly" \
  "$(echo "$SEASONS_CODE" | grep -q 'ctx\.seasons' && echo true || echo false)" \
  "Uses state.get() instead"

# --- 6. Credentials for fetch calls ---
echo ""; echo "[6/8] Fetch credentials (must include cookies)"

assert "Excel export uses credentials: include" \
  "$(echo "$EXPORT_CODE" | grep -q "credentials: 'include'" && echo true || echo false)" \
  "Missing credentials in fetch call"

assert "Rankings fetch uses credentials: include" \
  "$(echo "$RANKINGS_CODE" | grep -q "credentials: 'include'" && echo true || echo false)" \
  "Missing credentials in fetch call"

# --- 7. Cache coherence ---
echo ""; echo "[7/8] Cache invalidation after mutations"

assert "Matches module invalidates cache after recordMatch" \
  "$(echo "$MATCHES_CODE" | grep -q 'invalidateCache' && echo true || echo false)" \
  "Missing cache invalidation"

assert "Seasons module invalidates cache after mutations" \
  "$(echo "$SEASONS_CODE" | grep -q 'invalidateCache' && echo true || echo false)" \
  "Missing cache invalidation"

assert "Cups module invalidates cache after mutations" \
  "$(echo "$CUPS_CODE" | grep -q 'invalidateCache' && echo true || echo false)" \
  "Missing cache invalidation"

assert "Players module invalidates cache after mutations" \
  "$(echo "$PLAYERS_CODE" | grep -q 'invalidateCache' && echo true || echo false)" \
  "Missing cache invalidation"

# --- 8. Export/backup routes ---
echo ""; echo "[8/8] Export/backup route paths"

assert "Excel export uses /export-excel path" \
  "$(echo "$EXPORT_CODE" | grep -q 'export-excel' && echo true || echo false)" \
  "Found /export/excel instead"

assert "JSON backup uses /backup path" \
  "$(echo "$EXPORT_CODE" | grep -q '/backup' && echo true || echo false)" \
  "Found /backup/json instead"

# --- Frontend results ---
FE_PASS=$PASS
FE_FAIL=$FAIL
FE_TOTAL=$TOTAL

echo ""
echo "=========================================="
echo "FRONTEND RESULTS: $FE_PASS/$FE_TOTAL passed, $FE_FAIL failed"
echo "=========================================="

# ──────────────────────────────────────────────────────────────────────
# PART 2: BACKEND API TESTS (requires running server)
# ──────────────────────────────────────────────────────────────────────

echo ""
echo "=========================================="
echo "PART 2: BACKEND API TESTS"
echo "=========================================="

# Reset counters for backend section
BE_PASS=0
BE_FAIL=0
BE_TOTAL=0

be_assert() {
  local name="$1" expected="$2" actual="$3"
  BE_TOTAL=$((BE_TOTAL+1))
  if [ "$actual" = "$expected" ]; then
    BE_PASS=$((BE_PASS+1)); echo "  ✅ $name"
  else
    BE_FAIL=$((BE_FAIL+1)); echo "  ❌ $name (expected: $expected, got: $actual)"
  fi
}

be_assert_field() {
  local name="$1" field="$2" body="$3"
  BE_TOTAL=$((BE_TOTAL+1))
  if echo "$body" | grep -q "\"$field\""; then
    BE_PASS=$((BE_PASS+1)); echo "  ✅ $name"
  else
    BE_FAIL=$((BE_FAIL+1)); echo "  ❌ $name - missing '$field'"
  fi
}

be_assert_is_array() {
  local name="$1" body="$2"
  BE_TOTAL=$((BE_TOTAL+1))
  if echo "$body" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null && \
     echo "$body" | python3 -c "import sys,json; assert isinstance(json.load(sys.stdin), list)" 2>/dev/null; then
    BE_PASS=$((BE_PASS+1)); echo "  ✅ $name (array)"
  else
    BE_FAIL=$((BE_FAIL+1)); echo "  ❌ $name - not a valid array"
  fi
}

be_assert_is_obj() {
  local name="$1" body="$2"
  BE_TOTAL=$((BE_TOTAL+1))
  if echo "$body" | python3 -c "import sys,json; assert isinstance(json.load(sys.stdin), dict)" 2>/dev/null; then
    BE_PASS=$((BE_PASS+1)); echo "  ✅ $name (object)"
  else
    BE_FAIL=$((BE_FAIL+1)); echo "  ❌ $name - not a valid object"
  fi
}

BASE="http://localhost:3001/tennis"

# Login helper
do_login() {
  local user="$1" pass="$2" cookie_file="$3"
  local lr_resp=$(curl -s -c "$cookie_file" "$BASE/api/auth/login")
  local login_csrf=$(echo "$lr_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('loginCsrf',''))" 2>/dev/null)
  local csrf_token=$(curl -s -b "$cookie_file" "$BASE/api/csrf-token" | python3 -c "import sys,json; print(json.load(sys.stdin).get('csrfToken',''))" 2>/dev/null)
  local resp=$(curl -s -c "$cookie_file" -b "$cookie_file" \
    -X POST "$BASE/api/auth/login" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $csrf_token" \
    -d "{\"username\":\"$user\",\"password\":\"$pass\",\"_loginCsrf\":\"$login_csrf\",\"_csrf\":\"$csrf_token\"}")
  echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('csrfToken',''))" 2>/dev/null
}

get_csrf() {
  curl -s -b "$1" "$BASE/api/csrf-token" | python3 -c "import sys,json; print(json.load(sys.stdin).get('csrfToken',''))" 2>/dev/null
}

record_match() {
  local csrf="$1" cookie_file="$2" p1="$3" p2="$4" p3="$5" p4="$6" wt="$7" score1="$8" score2="$9" date="${10}" season="${11}"
  curl -s -o /dev/null -w '%{http_code}' -b "$cookie_file" -X POST "$BASE/api/matches" \
    -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" \
    -d "{\"seasonId\":$season,\"playDate\":\"$date\",\"player1Id\":$p1,\"player2Id\":$p2,\"player3Id\":$p3,\"player4Id\":$p4,\"team1Score\":$score1,\"team2Score\":$score2,\"winningTeam\":$wt}"
}

# --- 1. SPA Loading ---
echo ""; echo "[1/17] SPA Loading"
be_assert "SPA loads" "200" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")"
SPA_BODY=$(curl -s "$BASE/")
be_assert_field "SPA has app-container" "app-container" "$SPA_BODY"
BE_TOTAL=$((BE_TOTAL+1))
if echo "$SPA_BODY" | grep -q 'assets/index-'; then BE_PASS=$((BE_PASS+1)); echo "  ✅ SPA loads JS bundle"
else BE_FAIL=$((BE_FAIL+1)); echo "  ❌ SPA loads JS bundle - missing 'assets/index-'"; fi
BE_TOTAL=$((BE_TOTAL+1))
if echo "$SPA_BODY" | grep -qi "tennis"; then BE_PASS=$((BE_PASS+1)); echo "  ✅ SPA has title"
else BE_FAIL=$((BE_FAIL+1)); echo "  ❌ SPA has title - missing 'Tennis'"; fi

# --- 2. Authentication ---
echo ""; echo "[2/17] Authentication"
CSRF=$(do_login "admin" "dev_admin_password" "/tmp/cookies.txt")
AUTH=$(curl -s -b /tmp/cookies.txt "$BASE/api/auth/status")
be_assert_field "Admin login csrfToken" "csrfToken" "$AUTH"
be_assert_field "Auth authenticated" "authenticated" "$AUTH"
be_assert_field "Auth username" "username" "$AUTH"

CSRF=$(get_csrf "/tmp/cookies.txt")

INIT=$(curl -s -b /tmp/cookies.txt "$BASE/api/init")
be_assert_field "Init: players" "players" "$INIT"
be_assert_field "Init: seasons" "seasons" "$INIT"
be_assert_field "Init: activeSeason" "activeSeason" "$INIT"

SEASON_ID=$(echo "$INIT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('activeSeason',{}).get('id',1))" 2>/dev/null || echo "1")
P1_ID=$(echo "$INIT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['players'][0]['id'])" 2>/dev/null || echo "1")
P2_ID=$(echo "$INIT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['players'][1]['id'])" 2>/dev/null || echo "2")
P3_ID=$(echo "$INIT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['players'][2]['id'])" 2>/dev/null || echo "3")
P4_ID=$(echo "$INIT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['players'][3]['id'])" 2>/dev/null || echo "4")
echo "  Season=$SEASON_ID, P1=$P1_ID, P2=$P2_ID, P3=$P3_ID, P4=$P4_ID"

# Bad login
B_LR=$(curl -s -c /tmp/bad.txt "$BASE/api/auth/login" | python3 -c "import sys,json; print(json.load(sys.stdin).get('loginCsrf',''))" 2>/dev/null)
B_CT=$(curl -s -b /tmp/bad.txt "$BASE/api/csrf-token" | python3 -c "import sys,json; print(json.load(sys.stdin).get('csrfToken',''))" 2>/dev/null)
be_assert "Bad login rejected" "401" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/bad.txt -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -H "X-CSRF-Token: $B_CT" -d "{\"username\":\"admin\",\"password\":\"wrong\",\"_loginCsrf\":\"$B_LR\",\"_csrf\":\"x\"}")"

# --- 3. Players ---
echo ""; echo "[3/17] Players"
be_assert_is_array "Players list" "$(curl -s -b /tmp/cookies.txt "$BASE/api/players")"

CSRF=$(get_csrf "/tmp/cookies.txt")
be_assert "Create player" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X POST "$BASE/api/players" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d "{\"name\":\"UI Test Player $(date +%s)\",\"nickname\":\"UITest\"}")"

TEST_PID=$(curl -s -b /tmp/cookies.txt "$BASE/api/players" | python3 -c "import sys,json; [print(p['id']) for p in json.load(sys.stdin) if p.get('nickname')=='UITest']" 2>/dev/null | head -1)
if [ -n "$TEST_PID" ]; then
  CSRF=$(get_csrf "/tmp/cookies.txt")
  be_assert "Update player" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X PUT "$BASE/api/players/$TEST_PID" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{"name":"Updated UI Player"}')"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  be_assert "Delete player" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X DELETE "$BASE/api/players/$TEST_PID" -H "X-CSRF-Token: $CSRF")"
fi

# --- 4. Seasons ---
echo ""; echo "[4/17] Seasons"
CSRF=$(get_csrf "/tmp/cookies.txt")
be_assert_is_array "Seasons list" "$(curl -s -b /tmp/cookies.txt "$BASE/api/seasons")"
be_assert_is_obj "Active season" "$(curl -s -b /tmp/cookies.txt "$BASE/api/seasons/active-one")"

CREATE_S_RESP=$(curl -s -b /tmp/cookies.txt -X POST "$BASE/api/seasons" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{"name":"UI Test Season","startDate":"2026-01-01","endDate":"2026-12-31"}')
be_assert "Create season" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X POST "$BASE/api/seasons" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{"name":"UI Test Season B","startDate":"2026-06-01","endDate":"2026-11-30"}')"
S_ID=$(echo "$CREATE_S_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',0))" 2>/dev/null || echo "0")

if [ "$S_ID" != "0" ]; then
  CSRF=$(get_csrf "/tmp/cookies.txt")
  be_assert "Update season" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X PUT "$BASE/api/seasons/$S_ID" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{"name":"Updated UI Season","startDate":"2026-01-01","endDate":"2026-12-31"}')"
  be_assert_is_array "Season players" "$(curl -s -b /tmp/cookies.txt "$BASE/api/seasons/$S_ID/players")"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  be_assert "Add players to season" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X POST "$BASE/api/seasons/$S_ID/players" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d "{\"playerIds\":[$P1_ID,$P2_ID]}")"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  be_assert "End season" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X POST "$BASE/api/seasons/$S_ID/end" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{"endDate":"2026-12-31"}')"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  be_assert "Reactivate season" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X POST "$BASE/api/seasons/$S_ID/reactivate" -H "X-CSRF-Token: $CSRF")"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  be_assert "Season results" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X PUT "$BASE/api/seasons/$S_ID/results" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{"finalResults":"Winner: P1"}')"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  curl -s -b /tmp/cookies.txt -X POST "$BASE/api/seasons/$S_ID/end" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{"endDate":"2026-12-31"}' > /dev/null
  CSRF=$(get_csrf "/tmp/cookies.txt")
  be_assert "Delete ended season" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X DELETE "$BASE/api/seasons/$S_ID" -H "X-CSRF-Token: $CSRF")"
fi
CSRF=$(get_csrf "/tmp/cookies.txt")
be_assert "Check expired" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X POST "$BASE/api/seasons/check-expired" -H "X-CSRF-Token: $CSRF")"

# --- 5. Matches ---
echo ""; echo "[5/17] Matches"
be_assert_is_array "Matches list" "$(curl -s -b /tmp/cookies.txt "$BASE/api/matches")"
CSRF=$(get_csrf "/tmp/cookies.txt")
be_assert "Record match 1" "200" "$(record_match "$CSRF" "/tmp/cookies.txt" $P1_ID $P2_ID $P3_ID $P4_ID 1 6 7 "2026-07-17" "$SEASON_ID")"
CSRF=$(get_csrf "/tmp/cookies.txt")
be_assert "Record match 2" "200" "$(record_match "$CSRF" "/tmp/cookies.txt" $P2_ID $P3_ID $P4_ID $P1_ID 2 5 6 "2026-07-18" "$SEASON_ID")"
be_assert_is_array "Match history" "$(curl -s -b /tmp/cookies.txt "$BASE/api/matches?date=2026-07-17")"
be_assert_is_array "Play dates" "$(curl -s -b /tmp/cookies.txt "$BASE/api/play-dates")"

MATCH_ID=$(curl -s -b /tmp/cookies.txt "$BASE/api/matches?date=2026-07-17" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')" 2>/dev/null || echo "")
if [ -n "$MATCH_ID" ]; then
  CSRF=$(get_csrf "/tmp/cookies.txt")
  be_assert "Edit match" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X PUT "$BASE/api/matches/$MATCH_ID" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d "{\"seasonId\":$SEASON_ID,\"playDate\":\"2026-07-17\",\"player1Id\":$P1_ID,\"player2Id\":$P2_ID,\"player3Id\":$P3_ID,\"player4Id\":$P4_ID,\"team1Score\":7,\"team2Score\":6,\"winningTeam\":2}")"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  be_assert "Delete match" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X DELETE "$BASE/api/matches/$MATCH_ID" -H "X-CSRF-Token: $CSRF")"
fi

# --- 6. Rankings ---
echo ""; echo "[6/17] Rankings"
be_assert_is_obj "Lifetime rankings" "$(curl -s -b /tmp/cookies.txt "$BASE/api/rankings")"
be_assert_is_array "Season rankings" "$(curl -s -b /tmp/cookies.txt "$BASE/api/rankings/season/$SEASON_ID")"
be_assert_is_array "Date rankings" "$(curl -s -b /tmp/cookies.txt "$BASE/api/rankings/date/2026-07-17")"

# --- 7. Cups ---
echo ""; echo "[7/17] Cups"
CSRF=$(get_csrf "/tmp/cookies.txt")
be_assert_is_array "Cups list" "$(curl -s -b /tmp/cookies.txt "$BASE/api/cups")"

CREATE_C_RESP=$(curl -s -b /tmp/cookies.txt -X POST "$BASE/api/cups" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d "{\"name\":\"UI Test Cup\",\"seasonId\":$SEASON_ID,\"format\":\"single_elimination\",\"numTeams\":2,\"startDate\":\"2026-08-01\"}")
be_assert "Create cup" "201" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X POST "$BASE/api/cups" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d "{\"name\":\"UI Test Cup B\",\"seasonId\":$SEASON_ID,\"format\":\"single_elimination\",\"numTeams\":2,\"startDate\":\"2026-08-15\"}")"
CUP_ID=$(echo "$CREATE_C_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',0))" 2>/dev/null || echo "0")

if [ "$CUP_ID" != "0" ]; then
  be_assert_is_obj "Cup detail" "$(curl -s -b /tmp/cookies.txt "$BASE/api/cups/$CUP_ID")"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  be_assert "Add participant 1" "201" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X POST "$BASE/api/cups/$CUP_ID/participants" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d "{\"player1Id\":$P1_ID,\"player2Id\":$P2_ID}")"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  be_assert "Add participant 2" "201" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X POST "$BASE/api/cups/$CUP_ID/participants" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d "{\"player1Id\":$P3_ID,\"player2Id\":$P4_ID}")"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  be_assert "Shuffle seeds" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X POST "$BASE/api/cups/$CUP_ID/seed-shuffle" -H "X-CSRF-Token: $CSRF")"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  be_assert "Generate bracket" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X POST "$BASE/api/cups/$CUP_ID/generate-bracket" -H "X-CSRF-Token: $CSRF")"
  be_assert_is_array "Bracket view" "$(curl -s -b /tmp/cookies.txt "$BASE/api/cups/$CUP_ID/bracket")"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  be_assert "Edit cup" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X PUT "$BASE/api/cups/$CUP_ID" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{"name":"Updated UI Cup"}')"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  be_assert "Delete cup" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X DELETE "$BASE/api/cups/$CUP_ID" -H "X-CSRF-Token: $CSRF")"
fi

# --- 8. Images ---
echo ""; echo "[8/17] Images"
be_assert_is_array "Images list" "$(curl -s -b /tmp/cookies.txt "$BASE/api/images")"

# --- 9. Export ---
echo ""; echo "[9/17] Export"
be_assert "Excel export" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt "$BASE/api/export-excel")"

# --- 10. Backup ---
echo ""; echo "[10/17] Backup"
be_assert "JSON backup" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt "$BASE/api/backup")"

# --- 11. Admin ---
echo ""; echo "[11/17] Admin"
be_assert_field "FCM status" "status" "$(curl -s -b /tmp/cookies.txt "$BASE/api/admin/fcm/status")"
be_assert_field "Cache stats" "hitRate" "$(curl -s -b /tmp/cookies.txt "$BASE/api/cache-stats")"

# --- 12. Users ---
echo ""; echo "[12/17] Users"
be_assert_is_obj "Users list" "$(curl -s -b /tmp/cookies.txt "$BASE/api/users")"

# --- 13. System ---
echo ""; echo "[13/17] System"
be_assert_field "Data version" "version" "$(curl -s -b /tmp/cookies.txt "$BASE/api/data-version")"

# --- 14. Cache Coherence ---
echo ""; echo "[14/17] Cache Coherence"
V1=$(curl -s -b /tmp/cookies.txt "$BASE/api/data-version" | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])" 2>/dev/null)
sleep 1
CSRF=$(get_csrf "/tmp/cookies.txt")
SEASON_UPD=$(curl -s -w "\n%{http_code}" -b /tmp/cookies.txt -X PUT "$BASE/api/seasons/$SEASON_ID" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d "{\"name\":\"Season $(date +%s)\",\"startDate\":\"2026-01-01\",\"endDate\":\"2026-12-31\"}")
sleep 1
V2=$(curl -s -b /tmp/cookies.txt "$BASE/api/data-version" | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])" 2>/dev/null)
BE_TOTAL=$((BE_TOTAL+1))
SEASON_STATUS=$(echo "$SEASON_UPD" | tail -1)
if [ "$SEASON_STATUS" != "200" ]; then BE_FAIL=$((BE_FAIL+1)); echo "  ❌ Cache coherence - season update failed (HTTP $SEASON_STATUS)"
elif [ "$V1" != "$V2" ]; then BE_PASS=$((BE_PASS+1)); echo "  ✅ Data version changed ($V1 -> $V2)"
else BE_FAIL=$((BE_FAIL+1)); echo "  ❌ Data version unchanged ($V1)"; fi

# --- 15. SSE ---
echo ""; echo "[15/17] SSE"
SSE_CODE=$(timeout 2 curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt "$BASE/api/events" 2>/dev/null || echo "0")
BE_TOTAL=$((BE_TOTAL+1))
if [ "$SSE_CODE" = "200" ] || [ "$SSE_CODE" = "0" ]; then BE_PASS=$((BE_PASS+1)); echo "  ✅ SSE endpoint accessible"
else BE_FAIL=$((BE_FAIL+1)); echo "  ❌ SSE failed ($SSE_CODE)"; fi

# --- 16. Health ---
echo ""; echo "[16/17] Health"
be_assert_field "Health check" "status" "$(curl -s -b /tmp/cookies.txt "$BASE/api/health")"

# --- 17. Editor role ---
echo ""; echo "[17/17] Editor Role"
E_CSRF=$(do_login "editor" "dev_editor_password" "/tmp/ec.txt")
be_assert_field "Editor login" "csrfToken" "$(curl -s -b /tmp/ec.txt "$BASE/api/auth/status")"

E_CSRF=$(get_csrf "/tmp/ec.txt")
be_assert "Editor cannot create season" "403" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/ec.txt -X POST "$BASE/api/seasons" -H 'Content-Type: application/json' -H "X-CSRF-Token: $E_CSRF" -d '{"name":"E","startDate":"2026-01-01"}')"
be_assert "Editor cannot delete season" "403" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/ec.txt -X DELETE "$BASE/api/seasons/$SEASON_ID" -H "X-CSRF-Token: $E_CSRF")"
E_CSRF=$(get_csrf "/tmp/ec.txt")
be_assert "Editor can record match" "200" "$(record_match "$E_CSRF" "/tmp/ec.txt" $P1_ID $P3_ID $P2_ID $P4_ID 2 7 6 "2026-07-20" "$SEASON_ID")"

# --- Backend results ---
echo ""
echo "=========================================="
echo "BACKEND RESULTS: $BE_PASS/$BE_TOTAL passed, $BE_FAIL failed"
echo "=========================================="

# ──────────────────────────────────────────────────────────────────────
# GRAND TOTAL
# ──────────────────────────────────────────────────────────────────────

GRAND_PASS=$((FE_PASS + BE_PASS))
GRAND_FAIL=$((FE_FAIL + BE_FAIL))
GRAND_TOTAL=$((FE_TOTAL + BE_TOTAL))

echo ""
echo "=========================================="
echo "GRAND TOTAL: $GRAND_PASS/$GRAND_TOTAL passed, $GRAND_FAIL failed"
echo "  Frontend: $FE_PASS/$FE_TOTAL  |  Backend: $BE_PASS/$BE_TOTAL"
echo "=========================================="

[ $((FE_FAIL + BE_FAIL)) -gt 0 ] && exit 1
exit 0
