#!/bin/bash
# Comprehensive UI verification test suite
# API returns plain arrays for lists, 200 for creates, match fields: player1Id/player3Id/team1Score/winningTeam

BASE="http://localhost:3001/tennis"
PASS=0
FAIL=0
TOTAL=0

assert_status() {
  local name="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL+1))
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS+1)); echo "  ✅ $name"
  else
    FAIL=$((FAIL+1)); echo "  ❌ $name (expected: $expected, got: $actual)"
  fi
}

assert_field() {
  local name="$1" field="$2" body="$3"
  TOTAL=$((TOTAL+1))
  if echo "$body" | grep -q "\"$field\""; then
    PASS=$((PASS+1)); echo "  ✅ $name"
  else
    FAIL=$((FAIL+1)); echo "  ❌ $name - missing '$field'"
  fi
}

assert_is_array() {
  local name="$1" body="$2"
  TOTAL=$((TOTAL+1))
  if echo "$body" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null && \
     echo "$body" | python3 -c "import sys,json; assert isinstance(json.load(sys.stdin), list)" 2>/dev/null; then
    PASS=$((PASS+1)); echo "  ✅ $name (array)"
  else
    FAIL=$((FAIL+1)); echo "  ❌ $name - not a valid array"
  fi
}

assert_is_obj() {
  local name="$1" body="$2"
  TOTAL=$((TOTAL+1))
  if echo "$body" | python3 -c "import sys,json; assert isinstance(json.load(sys.stdin), dict)" 2>/dev/null; then
    PASS=$((PASS+1)); echo "  ✅ $name (object)"
  else
    FAIL=$((FAIL+1)); echo "  ❌ $name - not a valid object"
  fi
}

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

# Record match helper (uses correct field names)
record_match() {
  local csrf="$1" cookie_file="$2" p1="$3" p2="$4" p3="$5" p4="$6" wt="$7" score1="$8" score2="$9" date="${10}" season="${11}"
  curl -s -o /dev/null -w '%{http_code}' -b "$cookie_file" -X POST "$BASE/api/matches" \
    -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" \
    -d "{\"seasonId\":$season,\"playDate\":\"$date\",\"player1Id\":$p1,\"player2Id\":$p2,\"player3Id\":$p3,\"player4Id\":$p4,\"team1Score\":$score1,\"team2Score\":$score2,\"winningTeam\":$wt}"
}

echo "=========================================="
echo "TENNIS RANKING - UI VERIFICATION TESTS"
echo "=========================================="

# --- 1. SPA Loading ---
echo ""; echo "[1/17] SPA Loading"
assert_status "SPA loads" "200" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")"
SPA_BODY=$(curl -s "$BASE/")
assert_field "SPA has app-container" "app-container" "$SPA_BODY"
TOTAL=$((TOTAL+1))
if echo "$SPA_BODY" | grep -q 'assets/index-'; then PASS=$((PASS+1)); echo "  ✅ SPA loads JS bundle"
else FAIL=$((FAIL+1)); echo "  ❌ SPA loads JS bundle - missing 'assets/index-'"; fi
TOTAL=$((TOTAL+1))
if echo "$SPA_BODY" | grep -qi "tennis"; then PASS=$((PASS+1)); echo "  ✅ SPA has title"
else FAIL=$((FAIL+1)); echo "  ❌ SPA has title - missing 'Tennis'"; fi

# --- 2. Authentication ---
echo ""; echo "[2/17] Authentication"
CSRF=$(do_login "admin" "dev_admin_password" "/tmp/cookies.txt")
AUTH=$(curl -s -b /tmp/cookies.txt "$BASE/api/auth/status")
assert_field "Admin login csrfToken" "csrfToken" "$AUTH"
assert_field "Auth authenticated" "authenticated" "$AUTH"
assert_field "Auth username" "username" "$AUTH"

CSRF=$(get_csrf "/tmp/cookies.txt")

INIT=$(curl -s -b /tmp/cookies.txt "$BASE/api/init")
assert_field "Init: players" "players" "$INIT"
assert_field "Init: seasons" "seasons" "$INIT"
assert_field "Init: activeSeason" "activeSeason" "$INIT"

SEASON_ID=$(echo "$INIT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('activeSeason',{}).get('id',1))" 2>/dev/null || echo "1")
P1_ID=$(echo "$INIT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['players'][0]['id'])" 2>/dev/null || echo "1")
P2_ID=$(echo "$INIT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['players'][1]['id'])" 2>/dev/null || echo "2")
P3_ID=$(echo "$INIT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['players'][2]['id'])" 2>/dev/null || echo "3")
P4_ID=$(echo "$INIT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['players'][3]['id'])" 2>/dev/null || echo "4")
echo "  Season=$SEASON_ID, P1=$P1_ID, P2=$P2_ID, P3=$P3_ID, P4=$P4_ID"

# Bad login
B_LR=$(curl -s -c /tmp/bad.txt "$BASE/api/auth/login" | python3 -c "import sys,json; print(json.load(sys.stdin).get('loginCsrf',''))" 2>/dev/null)
B_CT=$(curl -s -b /tmp/bad.txt "$BASE/api/csrf-token" | python3 -c "import sys,json; print(json.load(sys.stdin).get('csrfToken',''))" 2>/dev/null)
assert_status "Bad login rejected" "401" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/bad.txt -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -H "X-CSRF-Token: $B_CT" -d "{\"username\":\"admin\",\"password\":\"wrong\",\"_loginCsrf\":\"$B_LR\",\"_csrf\":\"x\"}")"

# --- 3. Players ---
echo ""; echo "[3/17] Players"
assert_is_array "Players list" "$(curl -s -b /tmp/cookies.txt "$BASE/api/players")"

CSRF=$(get_csrf "/tmp/cookies.txt")
assert_status "Create player" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X POST "$BASE/api/players" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d "{\"name\":\"UI Test Player $(date +%s)\",\"nickname\":\"UITest\"}")"

TEST_PID=$(curl -s -b /tmp/cookies.txt "$BASE/api/players" | python3 -c "import sys,json; [print(p['id']) for p in json.load(sys.stdin) if p.get('nickname')=='UITest']" 2>/dev/null | head -1)
if [ -n "$TEST_PID" ]; then
  CSRF=$(get_csrf "/tmp/cookies.txt")
  assert_status "Update player" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X PUT "$BASE/api/players/$TEST_PID" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{"name":"Updated UI Player"}')"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  assert_status "Delete player" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X DELETE "$BASE/api/players/$TEST_PID" -H "X-CSRF-Token: $CSRF")"
fi

# --- 4. Seasons ---
echo ""; echo "[4/17] Seasons"
CSRF=$(get_csrf "/tmp/cookies.txt")
assert_is_array "Seasons list" "$(curl -s -b /tmp/cookies.txt "$BASE/api/seasons")"
assert_is_obj "Active season" "$(curl -s -b /tmp/cookies.txt "$BASE/api/seasons/active-one")"

CREATE_S_RESP=$(curl -s -b /tmp/cookies.txt -X POST "$BASE/api/seasons" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{"name":"UI Test Season","startDate":"2026-01-01","endDate":"2026-12-31"}')
assert_status "Create season" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X POST "$BASE/api/seasons" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{"name":"UI Test Season B","startDate":"2026-06-01","endDate":"2026-11-30"}')"
S_ID=$(echo "$CREATE_S_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',0))" 2>/dev/null || echo "0")

if [ "$S_ID" != "0" ]; then
  CSRF=$(get_csrf "/tmp/cookies.txt")
  assert_status "Update season" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X PUT "$BASE/api/seasons/$S_ID" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{"name":"Updated UI Season","startDate":"2026-01-01","endDate":"2026-12-31"}')"
  assert_is_array "Season players" "$(curl -s -b /tmp/cookies.txt "$BASE/api/seasons/$S_ID/players")"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  assert_status "Add players to season" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X POST "$BASE/api/seasons/$S_ID/players" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d "{\"playerIds\":[$P1_ID,$P2_ID]}")"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  assert_status "End season" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X POST "$BASE/api/seasons/$S_ID/end" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{"endDate":"2026-12-31"}')"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  assert_status "Reactivate season" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X POST "$BASE/api/seasons/$S_ID/reactivate" -H "X-CSRF-Token: $CSRF")"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  assert_status "Season results" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X PUT "$BASE/api/seasons/$S_ID/results" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{"finalResults":"Winner: P1"}')"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  curl -s -b /tmp/cookies.txt -X POST "$BASE/api/seasons/$S_ID/end" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{"endDate":"2026-12-31"}' > /dev/null
  CSRF=$(get_csrf "/tmp/cookies.txt")
  assert_status "Delete ended season" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X DELETE "$BASE/api/seasons/$S_ID" -H "X-CSRF-Token: $CSRF")"
fi
CSRF=$(get_csrf "/tmp/cookies.txt")
assert_status "Check expired" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X POST "$BASE/api/seasons/check-expired" -H "X-CSRF-Token: $CSRF")"

# --- 5. Matches ---
echo ""; echo "[5/17] Matches"
assert_is_array "Matches list" "$(curl -s -b /tmp/cookies.txt "$BASE/api/matches")"
CSRF=$(get_csrf "/tmp/cookies.txt")
assert_status "Record match 1" "200" "$(record_match "$CSRF" "/tmp/cookies.txt" $P1_ID $P2_ID $P3_ID $P4_ID 1 6 7 "2026-07-17" "$SEASON_ID")"
CSRF=$(get_csrf "/tmp/cookies.txt")
assert_status "Record match 2" "200" "$(record_match "$CSRF" "/tmp/cookies.txt" $P2_ID $P3_ID $P4_ID $P1_ID 2 5 6 "2026-07-18" "$SEASON_ID")"
assert_is_array "Match history" "$(curl -s -b /tmp/cookies.txt "$BASE/api/matches?date=2026-07-17")"
assert_is_array "Play dates" "$(curl -s -b /tmp/cookies.txt "$BASE/api/play-dates")"

MATCH_ID=$(curl -s -b /tmp/cookies.txt "$BASE/api/matches?date=2026-07-17" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')" 2>/dev/null || echo "")
if [ -n "$MATCH_ID" ]; then
  CSRF=$(get_csrf "/tmp/cookies.txt")
  assert_status "Edit match" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X PUT "$BASE/api/matches/$MATCH_ID" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d "{\"seasonId\":$SEASON_ID,\"playDate\":\"2026-07-17\",\"player1Id\":$P1_ID,\"player2Id\":$P2_ID,\"player3Id\":$P3_ID,\"player4Id\":$P4_ID,\"team1Score\":7,\"team2Score\":6,\"winningTeam\":2}")"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  assert_status "Delete match" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X DELETE "$BASE/api/matches/$MATCH_ID" -H "X-CSRF-Token: $CSRF")"
fi

# --- 6. Rankings ---
echo ""; echo "[6/17] Rankings"
assert_is_obj "Lifetime rankings" "$(curl -s -b /tmp/cookies.txt "$BASE/api/rankings")"
assert_is_array "Season rankings" "$(curl -s -b /tmp/cookies.txt "$BASE/api/rankings/season/$SEASON_ID")"
assert_is_array "Date rankings" "$(curl -s -b /tmp/cookies.txt "$BASE/api/rankings/date/2026-07-17")"

# --- 7. Cups ---
echo ""; echo "[7/17] Cups"
CSRF=$(get_csrf "/tmp/cookies.txt")
assert_is_array "Cups list" "$(curl -s -b /tmp/cookies.txt "$BASE/api/cups")"

CREATE_C_RESP=$(curl -s -b /tmp/cookies.txt -X POST "$BASE/api/cups" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d "{\"name\":\"UI Test Cup\",\"seasonId\":$SEASON_ID,\"format\":\"single_elimination\",\"numTeams\":2,\"startDate\":\"2026-08-01\"}")
assert_status "Create cup" "201" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X POST "$BASE/api/cups" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d "{\"name\":\"UI Test Cup B\",\"seasonId\":$SEASON_ID,\"format\":\"single_elimination\",\"numTeams\":2,\"startDate\":\"2026-08-15\"}")"
CUP_ID=$(echo "$CREATE_C_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',0))" 2>/dev/null || echo "0")

if [ "$CUP_ID" != "0" ]; then
  assert_is_obj "Cup detail" "$(curl -s -b /tmp/cookies.txt "$BASE/api/cups/$CUP_ID")"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  assert_status "Add participant 1" "201" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X POST "$BASE/api/cups/$CUP_ID/participants" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d "{\"player1Id\":$P1_ID,\"player2Id\":$P2_ID}")"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  assert_status "Add participant 2" "201" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X POST "$BASE/api/cups/$CUP_ID/participants" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d "{\"player1Id\":$P3_ID,\"player2Id\":$P4_ID}")"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  assert_status "Shuffle seeds" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X POST "$BASE/api/cups/$CUP_ID/seed-shuffle" -H "X-CSRF-Token: $CSRF")"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  assert_status "Generate bracket" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X POST "$BASE/api/cups/$CUP_ID/generate-bracket" -H "X-CSRF-Token: $CSRF")"
  assert_is_array "Bracket view" "$(curl -s -b /tmp/cookies.txt "$BASE/api/cups/$CUP_ID/bracket")"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  assert_status "Edit cup" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X PUT "$BASE/api/cups/$CUP_ID" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{"name":"Updated UI Cup"}')"
  CSRF=$(get_csrf "/tmp/cookies.txt")
  assert_status "Delete cup" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt -X DELETE "$BASE/api/cups/$CUP_ID" -H "X-CSRF-Token: $CSRF")"
fi

# --- 8. Images ---
echo ""; echo "[8/17] Images"
assert_is_array "Images list" "$(curl -s -b /tmp/cookies.txt "$BASE/api/images")"

# --- 9. Export ---
echo ""; echo "[9/17] Export"
assert_status "Excel export" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt "$BASE/api/export-excel")"

# --- 10. Backup ---
echo ""; echo "[10/17] Backup"
assert_status "JSON backup" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt "$BASE/api/backup")"

# --- 11. Admin ---
echo ""; echo "[11/17] Admin"
assert_field "FCM status" "status" "$(curl -s -b /tmp/cookies.txt "$BASE/api/admin/fcm/status")"
assert_field "Cache stats" "hitRate" "$(curl -s -b /tmp/cookies.txt "$BASE/api/cache-stats")"

# --- 12. Users ---
echo ""; echo "[12/17] Users"
assert_is_obj "Users list" "$(curl -s -b /tmp/cookies.txt "$BASE/api/users")"

# --- 13. System ---
echo ""; echo "[13/17] System"
assert_field "Data version" "version" "$(curl -s -b /tmp/cookies.txt "$BASE/api/data-version")"

# --- 14. Cache Coherence ---
echo ""; echo "[14/17] Cache Coherence"
V1=$(curl -s -b /tmp/cookies.txt "$BASE/api/data-version" | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])" 2>/dev/null)
sleep 1
CSRF=$(get_csrf "/tmp/cookies.txt")
# Use season update for cache coherence (PUT /api/players/:id route does not exist)
SEASON_UPD=$(curl -s -w "\n%{http_code}" -b /tmp/cookies.txt -X PUT "$BASE/api/seasons/$SEASON_ID" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d "{\"name\":\"Season $(date +%s)\",\"startDate\":\"2026-01-01\",\"endDate\":\"2026-12-31\"}")
sleep 1
V2=$(curl -s -b /tmp/cookies.txt "$BASE/api/data-version" | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])" 2>/dev/null)
TOTAL=$((TOTAL+1))
SEASON_STATUS=$(echo "$SEASON_UPD" | tail -1)
if [ "$SEASON_STATUS" != "200" ]; then FAIL=$((FAIL+1)); echo "  ❌ Cache coherence - season update failed (HTTP $SEASON_STATUS)"
elif [ "$V1" != "$V2" ]; then PASS=$((PASS+1)); echo "  ✅ Data version changed ($V1 -> $V2)"
else FAIL=$((FAIL+1)); echo "  ❌ Data version unchanged ($V1)"; fi

# --- 15. SSE ---
echo ""; echo "[15/17] SSE"
SSE_CODE=$(timeout 2 curl -s -o /dev/null -w '%{http_code}' -b /tmp/cookies.txt "$BASE/api/events" 2>/dev/null || echo "0")
TOTAL=$((TOTAL+1))
if [ "$SSE_CODE" = "200" ] || [ "$SSE_CODE" = "0" ]; then PASS=$((PASS+1)); echo "  ✅ SSE endpoint accessible"
else FAIL=$((FAIL+1)); echo "  ❌ SSE failed ($SSE_CODE)"; fi

# --- 16. Health ---
echo ""; echo "[16/17] Health"
assert_field "Health check" "status" "$(curl -s -b /tmp/cookies.txt "$BASE/api/health")"

# --- 17. Editor role ---
echo ""; echo "[17/17] Editor Role"
E_CSRF=$(do_login "editor" "dev_editor_password" "/tmp/ec.txt")
assert_field "Editor login" "csrfToken" "$(curl -s -b /tmp/ec.txt "$BASE/api/auth/status")"

E_CSRF=$(get_csrf "/tmp/ec.txt")
assert_status "Editor cannot create season" "403" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/ec.txt -X POST "$BASE/api/seasons" -H 'Content-Type: application/json' -H "X-CSRF-Token: $E_CSRF" -d '{"name":"E","startDate":"2026-01-01"}')"
assert_status "Editor cannot delete season" "403" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/ec.txt -X DELETE "$BASE/api/seasons/$SEASON_ID" -H "X-CSRF-Token: $E_CSRF")"
E_CSRF=$(get_csrf "/tmp/ec.txt")
assert_status "Editor can record match" "200" "$(record_match "$E_CSRF" "/tmp/ec.txt" $P1_ID $P3_ID $P2_ID $P4_ID 2 7 6 "2026-07-20" "$SEASON_ID")"

echo ""
echo "=========================================="
echo "RESULTS: $PASS/$TOTAL passed, $FAIL failed"
echo "=========================================="
[ $FAIL -gt 0 ] && exit 1
exit 0
