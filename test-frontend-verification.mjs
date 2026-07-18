#!/usr/bin/env node
// Automated frontend verification script
// Checks for common wiring/pattern issues in feature modules
// Run with: node test-frontend-verification.mjs

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = join(__dirname, 'src')

let pass = 0
let fail = 0
let total = 0

function assert(name, condition, detail = '') {
  total++
  if (condition) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`)
  }
}

function read(file) {
  return readFileSync(join(srcDir, file), 'utf8')
}

console.log('==========================================')
console.log('FRONTEND AUTOMATED VERIFICATION')
console.log('==========================================')

// --- 1. Module factory signatures ---
console.log('\n[1/8] Module factory signatures (must use ctx pattern)')

const playersCode = read('features/players/players.js')
const rankingsCode = read('features/rankings/rankings.js')
const matchesCode = read('features/matches/matches.js')
const cupsCode = read('features/cups/cups.js')
const seasonsCode = read('features/seasons/seasons.js')
const accountsCode = read('features/accounts/accounts.js')
const exportCode = read('features/export/export.js')
const imagesCode = read('features/images/images.js')

// Check that modules use single-arg ctx pattern (not multi-arg state/api/cache/ui)
assert('Players module uses ctx pattern',
  playersCode.includes('createPlayersModule(ctx)'),
  'Found multi-arg signature instead')

assert('Rankings module uses ctx pattern',
  rankingsCode.includes('createRankingsModule(ctx)'),
  'Found multi-arg signature instead')

assert('Matches module uses ctx pattern',
  matchesCode.includes('createMatchesModule(ctx)'),
  'Found multi-arg signature instead')

assert('Cups module uses ctx pattern',
  cupsCode.includes('createCupsModule(ctx)'),
  'Found multi-arg signature instead')

assert('Seasons module uses ctx pattern',
  seasonsCode.includes('createSeasonsModule(ctx)'),
  'Found multi-arg signature instead')

assert('Accounts module uses ctx pattern',
  accountsCode.includes('createAccountsModule(ctx)'),
  'Found multi-arg signature instead')

assert('Export module uses ctx pattern',
  exportCode.includes('createExportModule(ctx)'),
  'Found multi-arg signature instead')

assert('Images module uses ctx pattern',
  imagesCode.includes('createImagesModule(ctx)'),
  'Found multi-arg signature instead')

// Check that no module uses state.get() or state.set() (old pattern)
assert('Players module does not use state.get()',
  !playersCode.includes('state.get('),
  'Found state.get() calls')

assert('Rankings module does not use state.get()',
  !rankingsCode.includes('state.get('),
  'Found state.get() calls')

assert('Players module does not use api.createPlayer()',
  !playersCode.includes('api.createPlayer(') && !playersCode.includes('api.deletePlayer('),
  'Found old API method calls')

assert('Rankings module does not use api.getRankings()',
  !rankingsCode.includes('api.getRankings('),
  'Found old API method calls')

// --- 2. main.js wiring ---
console.log('\n[2/8] main.js wiring (must pass single ctx arg)')

const mainCode = read('main.js')

assert('Players wired with single ctx arg',
  mainCode.includes('createPlayersModule(app)'),
  'Found multi-arg wiring')

assert('Rankings wired with single ctx arg',
  mainCode.includes('createRankingsModule(app)'),
  'Found multi-arg wiring')

assert('No broken createPlayersModule(app, app, app) pattern',
  !mainCode.includes('createPlayersModule(app, app, app'),
  'Found broken 3-arg wiring')

assert('No broken createRankingsModule(app, app, app) pattern',
  !mainCode.includes('createRankingsModule(app, app, app'),
  'Found broken 3-arg wiring')

// --- 3. API endpoint paths ---
console.log('\n[3/8] API endpoint paths')

assert('Match creation uses correct field names',
  matchesCode.includes('player1Id') && matchesCode.includes('player3Id') &&
  matchesCode.includes('team1Score') && matchesCode.includes('winningTeam'),
  'Missing required match fields')

assert('Cup creation uses single_elimination format',
  cupsCode.includes('single_elimination'),
  'Found "duo" format instead of single_elimination')

assert('Cup participants uses player1Id (not playerIds array)',
  cupsCode.includes('player1Id') && !cupsCode.includes('playerIds'),
  'Uses playerIds array instead of player1Id')

assert('Cup bracket uses generate-bracket endpoint',
  cupsCode.includes('generate-bracket'),
  'Found /bracket instead of /generate-bracket')

assert('Cup shuffle uses seed-shuffle endpoint',
  cupsCode.includes('seed-shuffle'),
  'Found /shuffle-seeds instead of /seed-shuffle')

// --- 4. Auth flow ---
console.log('\n[4/8] Auth flow')

const authCode = read('modules/auth-manager.js')
const csrfCode = read('modules/csrf-handler.js')

assert('Login uses /api/auth/login endpoint',
  authCode.includes('/auth/login'),
  'Found /api/login instead')

assert('Login uses loginCsrf double-submit pattern',
  authCode.includes('loginCsrf') && authCode.includes('_loginCsrf'),
  'Missing loginCsrf flow')

assert('Auth status uses /api/auth/status endpoint',
  authCode.includes('/auth/status'),
  'Found /api/auth-status instead')

assert('Logout uses /api/auth/logout endpoint',
  authCode.includes('/auth/logout'),
  'Found /api/logout instead')

assert('makeAuthenticatedRequest injects X-CSRF-Token header',
  csrfCode.includes('X-CSRF-Token'),
  'Missing CSRF header injection')

// --- 5. Response parsing ---
console.log('\n[5/8] Response parsing (must handle plain arrays/objects)')

assert('Players list parsed as plain array',
  !playersCode.includes('data.players') && !playersCode.includes('response.data'),
  'Expects {data: [...]} wrapper')

assert('Cups list uses Array.isArray check',
  cupsCode.includes('Array.isArray'),
  'No array type check')

assert('Seasons reads from ctx.seasons directly',
  seasonsCode.includes('ctx.seasons'),
  'Uses state.get() instead')

// --- 6. Credentials for fetch calls ---
console.log('\n[6/8] Fetch credentials (must include cookies)')

assert('Excel export uses credentials: include',
  exportCode.includes("credentials: 'include'"),
  'Missing credentials in fetch call')

assert('Rankings fetch uses credentials: include',
  rankingsCode.includes("credentials: 'include'"),
  'Missing credentials in fetch call')

// --- 7. Cache coherence ---
console.log('\n[7/8] Cache invalidation after mutations')

assert('Matches module invalidates cache after recordMatch',
  matchesCode.includes('invalidateCache'),
  'Missing cache invalidation')

assert('Seasons module invalidates cache after mutations',
  seasonsCode.includes('invalidateCache'),
  'Missing cache invalidation')

assert('Cups module invalidates cache after mutations',
  cupsCode.includes('invalidateCache'),
  'Missing cache invalidation')

assert('Players module invalidates cache after mutations',
  playersCode.includes('invalidateCache'),
  'Missing cache invalidation')

// --- 8. Export/backup routes ---
console.log('\n[8/8] Export/backup route paths')

assert('Excel export uses /export-excel path',
  exportCode.includes('export-excel'),
  'Found /export/excel instead')

assert('JSON backup uses /backup path',
  exportCode.includes('/backup'),
  'Found /backup/json instead')

// --- Results ---
console.log('\n==========================================')
console.log(`RESULTS: ${pass}/${total} passed, ${fail} failed`)
console.log('==========================================')

if (fail > 0) {
  console.log('\n⚠️  Some checks failed. Review the issues above.')
  process.exit(1)
} else {
  console.log('\n🎉 All frontend checks passed!')
  process.exit(0)
}
