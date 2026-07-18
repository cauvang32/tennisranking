import './style.css'

// @ 2026-07-14T14-00 cache-bust v2
const __APP_VERSION__ = '2.0.4'

// ── Infrastructure modules (already extracted) ────────────────────────────────
import { connectSSE, closeSSE } from './modules/sse-manager.js'
import { createCacheManager } from './modules/cache-manager.js'
import { getCSRFToken as moduleGetCSRFToken, makeAuthenticatedRequest as moduleMakeAuthenticatedRequest, resetCSRFToken, setCSRFToken, refreshAuthToken } from './modules/csrf-handler.js'
import { detectServerMode as moduleDetectServerMode, checkAuthStatus as moduleCheckAuthStatus, login as moduleLogin, logout as moduleLogout, getApiBaseUrl as moduleGetApiBaseUrl, updateUIForAuthStatus as moduleUpdateUIForAuthStatus } from './modules/auth-manager.js'
import { normalizeText } from './lib/vietnamese-normalize.js'

// ── Feature modules (factories — receive `this` as ctx) ───────────────────────
import { createPlayersModule } from './features/players/players.js'
import { createRankingsModule } from './features/rankings/rankings.js'
import { createMatchesModule } from './features/matches/matches.js'
import { createBatchModeModule } from './features/matches/batch-mode.js'
import { createScreenshotModule } from './features/matches/screenshot.js'
import { createMatchModalModule } from './features/matches/match-modal.js'
import { createSeasonsModule } from './features/seasons/seasons.js'
import { createSeasonResultsModule } from './features/seasons/season-results.js'
import { createCupsModule } from './features/cups/cups.js'
import { createAccountsModule } from './features/accounts/accounts.js'
import { createImagesModule } from './features/images/images.js'
import { createExportModule } from './features/export/export.js'

// Tab manager logic is integrated directly into the switchTab method above
// ================================================================================
// TennisRankingSystem — thin bootstrap, delegates everything to feature modules
// ================================================================================
class TennisRankingSystem {
  constructor() {
    // ── Shared state (accessed by feature modules via ctx) ──────────────────
    this.players = []
    this.matches = []
    this.seasons = []
    this.playDates = []
    this.normalizedPlayers = []    // {normalized, id, name} sorted index for fuzzy matching
    this.seasonPlayers = []        // Players allowed in selected match season
    this.currentSeasonPlayers = [] // Same as seasonPlayers, set by onMatchSeasonChange

    this.currentViewMode = 'daily' // rankings view: daily | season | lifetime
    this.selectedDate = null
    this.selectedSeason = null
    this.selectedMatchSeason = null // Season selected in match form
    this.isManualWinnerMode = false
    this.currentMatchType = 'duo'  // 'duo' or 'solo'
    this.currentWinningTeam = null

    // Batch mode state
    this.batchMatches = []
    this.batchMatchId = 0
    this.batchMatchType = 'duo'

    // Screenshot parsing state
    this.parsedMatchesBuffer = []

    // Auth state
    this.serverMode = true
    this.apiBase = moduleGetApiBaseUrl()
    this.isAuthenticated = false
    this.user = null
    this.csrfToken = null

    // SSE / cache coherence
    this.appVersion = __APP_VERSION__
    this.eventHandlers = []

    // ── Infrastructure (cache + CSRF) ───────────────────────────────────────
    const cacheManager = createCacheManager()
    this.cache = cacheManager.cache
    this.CACHE_TTL = cacheManager.CACHE_TTL
    this.isCacheValid = cacheManager.isCacheValid
    this.setCache = cacheManager.setCache
    this.getCache = cacheManager.getCache
    this.invalidateCache = cacheManager.invalidateCache
    this.clearCache = cacheManager.clearCache

    // ── Utility methods (used by all feature modules) ───────────────────────
    this.escapeHtml = escapeHtml
    this.formatDate = formatDate
    this.formatMoney = formatMoney
    this.showToast = showToast
    this.showModal = showModal
    this.hideModal = hideModal
    this.updateFileStatus = updateFileStatus
    this.setTodaysDate = setTodaysDate

    // ── Auth helpers (delegate to auth-manager) ─────────────────────────────
    this.detectServerMode = async () => {
      const result = await moduleDetectServerMode(this.apiBase)
      this.serverMode = result.serverMode
      if (result.serverMode) this.apiBase = result.apiBase
    }
    this.checkAuthStatus = async () => {
      if (!this.serverMode) return
      const result = await moduleCheckAuthStatus(this.apiBase)
      this.isAuthenticated = result.isAuthenticated
      this.user = result.user
      this.csrfToken = result.csrfToken
      this.updateScreenshotSectionVisibility()
    }
    this.login = async (username, password) => {
      const result = await moduleLogin(this.apiBase, username, password)
      if (result.success) {
        this.isAuthenticated = true
        this.user = result.user
        this.csrfToken = result.csrfToken
        setCSRFToken(result.csrfToken)
        this.updateUIForAuthStatus()
        this.updateScreenshotSectionVisibility()
        await this.loadInitialData()
      }
      return result
    }
    this.logout = async () => {
      await moduleLogout(this.apiBase, this.csrfToken)
      resetCSRFToken()
      this.isAuthenticated = false
      this.user = null
      this.csrfToken = null
      this.updateUIForAuthStatus()
    }
    this.makeAuthenticatedRequest = (url, options) => moduleMakeAuthenticatedRequest(this.apiBase, url, options)
    this.getCSRFToken = async () => {
      if (this.csrfToken) return this.csrfToken
      const token = await moduleGetCSRFToken(this.apiBase)
      if (token) this.csrfToken = token
      return token
    }

    // ── Wire up feature modules ─────────────────────────────────────────────
    wireFeatureModules(this)

    // ── Start! ──────────────────────────────────────────────────────────────
    this.startVersionPolling()
    this.init()
  }

  // ── SSE / cache coherence ─────────────────────────────────────────────────
  startVersionPolling() {
    connectSSE(this.apiBase, this.cache,
      (newVersion) => { this.cache.serverVersion = newVersion; this.invalidateCache(); this.reloadCurrentView() },
      () => this.reloadCurrentView()
    )
  }

  stopVersionPolling() {
    closeSSE()
  }

  async reloadCurrentView() {
    try {
      await Promise.all([this.loadPlayDates(), this.loadSeasons(), this.loadPlayers()])
      this.updateDateSelector()
      this.updateSeasonSelector()
      this.updatePlayerSelects()
      this.updateSeasonSelect()

      const activeTabId = document.querySelector('.tab-content.active')?.id
      switch (activeTabId) {
        case 'rankings-tab': await this.renderRankings(); break
        case 'matches-tab': this.updateMatchHistoryDateSelector(); await this.renderMatchHistory(); break
        case 'players-tab': this.renderPlayers(); break
        case 'seasons-tab': this.renderSeasons(); break
        case 'cups-tab': this.loadCups(); break
        case 'accounts-tab':
          this.renderAccounts()
          if (this.user?.role === 'admin') { this.renderCacheStatus(); this.fetchFcmStatus() }
          break
      }
    } catch (error) {
      console.warn('⚠️ Failed to reload current view:', error)
    }
  }

  // ── Initialization ────────────────────────────────────────────────────────
  async init() {
    try {
      await this.detectServerMode()
      await this.checkAuthStatus()
      this.updateUIForAuthStatus()

      // Proactive token refresh if access token expired but refresh token valid
      if (!this.isAuthenticated && this.serverMode) {
        const refreshed = await refreshAuthToken(this.apiBase)
        if (refreshed) {
          this.isAuthenticated = true
          this.user = refreshed.user
          this.csrfToken = refreshed.csrfToken
          setCSRFToken(refreshed.csrfToken)
          this.updateUIForAuthStatus()
        }
      }

      if (document.readyState === 'loading') {
        await new Promise(r => document.addEventListener('DOMContentLoaded', r))
      }

      this.hideAllViewModeSections()
      this.setupEventListeners()
      await this.loadInitialData()
      this.updateUIForAuthStatus()
      this.switchTab('rankings')
      try { this.loadHeroBanner() } catch (e) { /* ignore if unauthenticated */ }
      this.updateFileStatus('✅ Hệ thống đã sẵn sàng', 'success')
    } catch (error) {
      console.error('Error initializing system:', error)
      this.updateUIForAuthStatus()
      this.updateFileStatus('❌ Lỗi khởi tạo hệ thống. Vui lòng tải lại trang.', 'error')
    }
  }

  hideAllViewModeSections() {
    document.querySelectorAll('.view-mode-section').forEach(s => s.classList.add('hidden'))
  }

  // ── Data loading ──────────────────────────────────────────────────────────
  async loadInitialData() {
    if (!this.serverMode) {
      this.updateFileStatus('⚠️ Không thể kết nối server.', 'error')
      return
    }
    try {
      const response = await fetch(`${this.apiBase}/init`, { credentials: 'include' })
      if (response.ok) {
        const data = await response.json()
        this.players = data.players || []
        this.seasons = data.seasons || []
        this.playDates = data.playDates || []
        this.setCache('players', null, this.players)
        this.setCache('seasons', null, this.seasons)
        this.setCache('playDates', null, this.playDates)
        if (data.lifetimeRankings) this.setCache('rankings', 'lifetime', data.lifetimeRankings)
        if (data.defaultDate && data.defaultDateRankings) this.setCache('rankings', `daily:${data.defaultDate}`, data.defaultDateRankings)
        if (data.defaultDate && data.defaultDateMatches) this.setCache('matches', `date:${data.defaultDate}`, data.defaultDateMatches)
        this.cache.serverVersion = data.version
        if (data.defaultDate) this.selectedDate = data.defaultDate
        if (data.isAuthenticated && data.csrfToken) {
          this.csrfToken = data.csrfToken
          setCSRFToken(data.csrfToken)
        }
        this.updateSeasonSelect()
      } else {
        await Promise.all([this.loadPlayers(), this.loadSeasons(), this.loadPlayDates(), this.loadMatches()])
      }
      this.updatePlayerSelects()
      this.setTodaysDate()
      await this.setDefaultViewMode()
    } catch (error) {
      console.error('Error loading initial data:', error)
      this.updateFileStatus('❌ Lỗi tải dữ liệu từ server', 'error')
    }
  }

  async loadPlayers() {
    try {
      const cached = this.getCache('players')
      if (cached) {
        this.players = cached
        this.normalizedPlayers = this.players.map(p => ({ normalized: normalizeText(p.name).toLowerCase(), id: p.id, name: p.name })).sort((a, b) => a.normalized.localeCompare(b.normalized))
        return
      }
      const response = await fetch(`${this.apiBase}/players`)
      if (response.ok) {
        this.players = await response.json()
        this.setCache('players', null, this.players)
        this.normalizedPlayers = this.players.map(p => ({ normalized: normalizeText(p.name).toLowerCase(), id: p.id, name: p.name })).sort((a, b) => a.normalized.localeCompare(b.normalized))
      }
    } catch (error) { console.error('Error loading players:', error) }
  }

  async loadSeasons() {
    try {
      const cached = this.getCache('seasons')
      if (cached) { this.seasons = cached; this.updateSeasonSelect(); return }
      const response = await fetch(`${this.apiBase}/seasons`)
      if (response.ok) { this.seasons = await response.json(); this.setCache('seasons', null, this.seasons); this.updateSeasonSelect() }
    } catch (error) { console.error('Error loading seasons:', error) }
  }

  async loadPlayDates() {
    try {
      const cached = this.getCache('playDates')
      if (cached) { this.playDates = cached; return }
      const response = await fetch(`${this.apiBase}/play-dates`)
      if (response.ok) { this.playDates = await response.json(); this.setCache('playDates', null, this.playDates) }
    } catch (error) { console.error('Error loading play dates:', error) }
  }

  async loadMatches() {
    try {
      this.matches = []
      let nextCursor = null
      do {
        const url = nextCursor ? `${this.apiBase}/matches?after=${nextCursor}&limit=50` : `${this.apiBase}/matches?limit=50`
        const response = await fetch(url)
        if (!response.ok) break
        const batch = await response.json()
        if (!batch || batch.length === 0) break
        this.matches.push(...batch)
        nextCursor = response.headers.get('X-Next-Cursor') || null
      } while (nextCursor)
      if (this.matches.length > 0) this.setCache('matches', 'all', this.matches)
    } catch (error) { console.error('Error loading matches:', error) }
  }

  async setDefaultViewMode() {
    try {
      if (this.playDates.length > 0) {
        this.currentViewMode = 'daily'
        this.selectedDate = this.playDates[0].play_date.split('T')[0]
      } else {
        const activeSeason = this.seasons.find(s => s.is_active)
        if (activeSeason) { this.currentViewMode = 'season'; this.selectedSeason = activeSeason.id }
        else this.currentViewMode = 'lifetime'
      }
      if (document.querySelector('.tab-content.active')?.id === 'rankings-tab') {
        this.updateDateSelector()
        this.updateSeasonSelector()
        await this.renderRankings()
      }
      this.updatePlayerSelects()
    } catch (error) { console.error('Error setting default view mode:', error); this.currentViewMode = 'lifetime' }
  }

  // ── UI helpers (used by auth-manager) ─────────────────────────────────────
  updateUIForAuthStatus() {
    moduleUpdateUIForAuthStatus(this)
  }

  // ── Event listeners (one big setup, called once on init) ──────────────────
  setupEventListeners() {
    try {
      // Tab switching
      document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', (e) => { const tab = e.currentTarget.dataset.tab; if (tab) this.switchTab(tab) })
      })

      // View mode switching
      document.querySelectorAll('.view-btn').forEach(btn => {
        btn.addEventListener('click', (e) => { const view = e.currentTarget.dataset.view; if (view) this.switchViewMode(view) })
      })

      // Match type toggle
      document.querySelectorAll('.type-btn').forEach(btn => {
        btn.addEventListener('click', (e) => { const type = e.currentTarget.dataset.type; if (type) this.switchMatchType(type) })
      })

      // Match form
      const matchForm = document.getElementById('matchForm')
      if (matchForm) matchForm.addEventListener('submit', (e) => { e.preventDefault(); this.recordMatch() })

      // Reset form
      const resetBtn = document.getElementById('resetFormBtn')
      if (resetBtn) resetBtn.addEventListener('click', () => this.resetMatchForm())

      // Score inputs → auto-winner
      ;['team1Score', 'team2Score'].forEach(id => {
        const input = document.getElementById(id)
        if (input) input.addEventListener('input', () => this.updateAutoWinner())
      })

      // Winner select
      const winnerSelect = document.getElementById('winner')
      if (winnerSelect) winnerSelect.addEventListener('change', (e) => {
        this.currentWinningTeam = e.target.value === 'team1' ? 1 : (e.target.value === 'team2' ? 2 : null)
      })

      // Manual / auto winner toggle
      const useManualBtn = document.getElementById('useManualWinner')
      const useAutoBtn = document.getElementById('useAutoWinner')
      if (useManualBtn && useAutoBtn) {
        useManualBtn.addEventListener('click', () => this.toggleWinnerMode(true))
        useAutoBtn.addEventListener('click', () => this.toggleWinnerMode(false))
      }

      // Match season selector
      const matchSeasonSelect = document.getElementById('matchSeasonSelect')
      if (matchSeasonSelect) matchSeasonSelect.addEventListener('change', async (e) => {
        await this.onMatchSeasonChange(parseInt(e.target.value))
        this.updateTeamLabelsForMatchType()
      })

      // Login / logout buttons
      const loginBtn = document.getElementById('loginBtn')
      if (loginBtn) loginBtn.addEventListener('click', () => this.showLoginModal())
      const logoutBtn = document.getElementById('logoutBtn')
      if (logoutBtn) logoutBtn.addEventListener('click', () => this.logout())

      // Today button
      const todayBtn = document.getElementById('todayBtn')
      if (todayBtn) todayBtn.addEventListener('click', () => {
        const today = new Date().toISOString().split('T')[0]
        const dateSelect = document.getElementById('rankingDateSelect')
        if (dateSelect) {
          const hasToday = Array.from(dateSelect.options).some(o => o.value === today)
          if (hasToday) dateSelect.value = today
          else { const opt = document.createElement('option'); opt.value = today; opt.textContent = this.formatDate(today); dateSelect.insertBefore(opt, dateSelect.options[1]); dateSelect.value = today }
        }
        this.selectedDate = today
        this.renderRankings()
      })

      // Date / season selectors for rankings
      const rankingDateSelect = document.getElementById('rankingDateSelect')
      if (rankingDateSelect) rankingDateSelect.addEventListener('change', (e) => { this.selectedDate = e.target.value; if (this.currentViewMode === 'daily') this.renderRankings() })
      const seasonSelect = document.getElementById('seasonSelect')
      if (seasonSelect) seasonSelect.addEventListener('change', (e) => { this.selectedSeason = parseInt(e.target.value); if (this.currentViewMode === 'season') this.renderRankings() })

      // Match history date filter
      const matchHistoryDate = document.getElementById('matchHistoryDate')
      if (matchHistoryDate) matchHistoryDate.addEventListener('change', () => this.renderMatchHistory())

      // Season form
      const seasonForm = document.getElementById('seasonForm')
      if (seasonForm) seasonForm.addEventListener('submit', (e) => { e.preventDefault(); this.saveSeason() })

      // Account form
      const accountForm = document.getElementById('accountForm')
      if (accountForm) accountForm.addEventListener('submit', (e) => { e.preventDefault(); this.saveAccount() })

      // Add player
      const addPlayerBtn = document.getElementById('addPlayer')
      if (addPlayerBtn) addPlayerBtn.addEventListener('click', () => this.addPlayer())
      ;['playerName', 'newPlayerName'].forEach(id => {
        const input = document.getElementById(id)
        if (input) input.addEventListener('keypress', (e) => { if (e.key === 'Enter') this.addPlayer() })
      })

      // Delete player (event delegation)
      document.addEventListener('click', async (e) => {
        const btn = e.target.closest('.delete-btn, .delete-player-btn')
        if (btn?.dataset.playerId) this.removePlayer(parseInt(btn.dataset.playerId))
      })

      // Modal dismiss
      document.addEventListener('click', (e) => {
        const dismissBtn = e.target.closest('[data-dismiss="modal"]')
        if (dismissBtn) { const modal = dismissBtn.closest('.modal'); if (modal) this.hideModal(modal.id); return }
        const backdrop = e.target.closest('.modal-backdrop')
        if (backdrop) { const modal = backdrop.closest('.modal'); if (modal) this.hideModal(modal.id) }
      })

      // Create buttons
      const createSeasonBtn = document.getElementById('createSeasonBtn')
      if (createSeasonBtn) createSeasonBtn.addEventListener('click', () => this.showSeasonModal())
      const createAccountBtn = document.getElementById('createAccountBtn')
      if (createAccountBtn) createAccountBtn.addEventListener('click', () => this.showAccountModal())

      // Export buttons
      ;[['exportExcelBtn', 'daily'], ['exportSeasonBtn', 'season'], ['exportLifetimeBtn', 'lifetime']].forEach(([id, mode]) => {
        const btn = document.getElementById(id)
        if (btn) btn.addEventListener('click', () => this.exportToExcel(mode))
      })
      const exportBtn = document.getElementById('exportRankings')
      if (exportBtn) exportBtn.addEventListener('click', () => this.exportToExcel(this.currentViewMode))

      // Backup / restore buttons
      const backupJsonBtn = document.getElementById('backupJsonBtn')
      if (backupJsonBtn) backupJsonBtn.addEventListener('click', () => this.backupToJson())
      const restoreJsonBtn = document.getElementById('restoreJsonBtn')
      const restoreJsonInput = document.getElementById('restoreJsonInput')
      if (restoreJsonBtn && restoreJsonInput) {
        restoreJsonBtn.addEventListener('click', () => restoreJsonInput.click())
        restoreJsonInput.addEventListener('change', (e) => this.restoreFromJson(e))
      }
      const backupDataBtn = document.getElementById('backupDataBtn')
      if (backupDataBtn) backupDataBtn.addEventListener('click', () => this.backupData())
      const restoreDataBtn = document.getElementById('restoreDataBtn')
      if (restoreDataBtn) restoreDataBtn.addEventListener('click', () => this.restoreData())
      const clearAllDataBtn = document.getElementById('clearAllData')
      if (clearAllDataBtn) clearAllDataBtn.addEventListener('click', () => this.clearAllData())
      const backupExcelBtn = document.getElementById('backupExcelBtn')
      if (backupExcelBtn) backupExcelBtn.addEventListener('click', () => this.exportToExcel('lifetime'))

      // Batch mode toggle
      const modeSingleBtn = document.getElementById('modeSingleBtn')
      const modeBatchBtn = document.getElementById('modeBatchBtn')
      if (modeSingleBtn && modeBatchBtn) {
        modeSingleBtn.addEventListener('click', () => this.switchToSingleMode())
        modeBatchBtn.addEventListener('click', () => this.switchToBatchMode())
      }

      // Batch type toggle
      const batchTypeToggle = document.getElementById('batchTypeToggle')
      if (batchTypeToggle) {
        batchTypeToggle.querySelectorAll('.type-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const type = btn.dataset.type
            if (!type) return
            batchTypeToggle.querySelector('.type-btn.active')?.classList.remove('active')
            btn.classList.add('active')
            this.batchMatchType = type
            this.renderBatchMatchesTable()
          })
        })
      }

      // Batch buttons
      const addBatchBtn = document.getElementById('addBatchMatchBtn')
      if (addBatchBtn) addBatchBtn.addEventListener('click', () => this.addBatchMatchRow())
      const confirmBatchBtn = document.getElementById('confirmBatchMatchesBtn')
      if (confirmBatchBtn) confirmBatchBtn.addEventListener('click', () => this.confirmBatchMatches())
      const cancelBatchBtn = document.getElementById('cancelBatchMatchesBtn')
      if (cancelBatchBtn) cancelBatchBtn.addEventListener('click', () => this.hideBatchSection())

      // Screenshot buttons
      const uploadBtn = document.getElementById('uploadScreenshotBtn')
      const fileInput = document.getElementById('screenshotFile')
      if (uploadBtn && fileInput) uploadBtn.addEventListener('click', () => fileInput.click())
      if (fileInput) fileInput.addEventListener('change', (e) => this.handleScreenshotUpload(e))
      const clearScreenshotBtn = document.getElementById('clearScreenshotBtn')
      if (clearScreenshotBtn) clearScreenshotBtn.addEventListener('click', () => this.clearScreenshot())
      const confirmParsedBtn = document.getElementById('confirmParsedMatchesBtn')
      if (confirmParsedBtn) confirmParsedBtn.addEventListener('click', () => this.confirmParsedMatches())
      const cancelParsedBtn = document.getElementById('cancelParsedMatchesBtn')
      if (cancelParsedBtn) cancelParsedBtn.addEventListener('click', () => this.cancelParsedMatches())

      // Other buttons
      const recordMatchBtn = document.getElementById('recordMatch')
      if (recordMatchBtn) recordMatchBtn.addEventListener('click', () => this.recordMatch())
      const addMatchModalBtn = document.getElementById('addMatchModal')
      if (addMatchModalBtn) addMatchModalBtn.addEventListener('click', () => this.showMatchModal())

      // Admin buttons
      const refreshCacheBtn = document.getElementById('refreshCacheStatusBtn')
      if (refreshCacheBtn) refreshCacheBtn.addEventListener('click', () => { if (this.user?.role === 'admin') this.renderCacheStatus() })

      // FCM buttons
      const fcmRefreshBtn = document.getElementById('fcmRefreshBtn')
      if (fcmRefreshBtn) fcmRefreshBtn.addEventListener('click', () => this.fetchFcmStatus())
      const fcmPauseBtn = document.getElementById('fcmPauseBtn')
      if (fcmPauseBtn) fcmPauseBtn.addEventListener('click', () => this.controlFcm('pause'))
      const fcmResumeBtn = document.getElementById('fcmResumeBtn')
      if (fcmResumeBtn) fcmResumeBtn.addEventListener('click', () => this.controlFcm('resume'))
      const fcmBroadcastForm = document.getElementById('fcmBroadcastForm')
      if (fcmBroadcastForm) fcmBroadcastForm.addEventListener('submit', (e) => this.sendFcmBroadcast(e))

      // Feature module listeners
      this._players.setupEventListeners()
      this._rankings.setupEventListeners()
      this._seasonResults.setupSeasonResultsListeners()
      this._images.setupImageEditorListeners()
      this._cups.setupCupListeners()
    } catch (error) {
      console.error('Error setting up event listeners:', error)
    }
  }
} // end TennisRankingSystem

// ================================================================================
// Wire feature modules onto the class prototype
// Each module receives `this` as ctx and returns an object of methods
// ================================================================================
function wireFeatureModules(app) {
  // Players (ctx pattern)
  app._players = createPlayersModule(app)
  Object.assign(app, {
    renderPlayers: app._players.render,
    addPlayer: app._players.addPlayer,
    removePlayer: app._players.removePlayer,
  })

  // Rankings (ctx pattern)
  app._rankings = createRankingsModule(app)
  Object.assign(app, {
    renderRankings: app._rankings.render,
    getRankEmoji: app._rankings.getRankEmoji,
    renderForm: app._rankings.renderForm,
    updateDateSelector: app._rankings.updateDateSelector,
    updateSeasonSelector: app._rankings.updateSeasonSelector,
    switchViewMode: app._rankings.switchViewMode,
    setupViewModeUI: app._rankings.setupViewModeUI,
  })

  // Matches
  app._matches = createMatchesModule(app)
  Object.assign(app, {
    renderMatchHistory: app._matches.renderMatchHistory,
    recordMatch: app._matches.recordMatch,
    editMatch: app._matches.editMatch,
    deleteMatch: app._matches.deleteMatch,
    updatePlayerSelects: app._matches.updatePlayerSelects,
    updateSeasonSelect: app._matches.updateSeasonSelect,
    onMatchSeasonChange: app._matches.onMatchSeasonChange,
    updateMatchHistoryDateSelector: app._matches.updateMatchHistoryDateSelector,
    resetMatchForm: app._matches.resetMatchForm,
    updateAutoWinner: app._matches.updateAutoWinner,
    toggleWinnerMode: app._matches.toggleWinnerMode,
    showMatchModal: app._matches.showMatchModal,
    fuzzyMatchPlayer: app._matches.fuzzyMatchPlayer,
    levenshteinDistance: app._matches.levenshteinDistance,
    _scoreWordAgainstPlayer: app._matches._scoreWordAgainstPlayer,
    mapTeamToPlayerPair: app._matches.mapTeamToPlayerPair,
  })
  // Note: switchMatchType and updateTeamLabelsForMatchType are defined on prototype directly

  // Batch mode
  app._batchMode = createBatchModeModule(app)
  Object.assign(app, app._batchMode)

  // Screenshot
  app._screenshot = createScreenshotModule(app)
  Object.assign(app, app._screenshot)

  // Match modal
  app._matchModal = createMatchModalModule(app)
  Object.assign(app, app._matchModal)

  // Seasons
  app._seasons = createSeasonsModule(app)
  Object.assign(app, app._seasons)

  // Season results
  app._seasonResults = createSeasonResultsModule(app)
  Object.assign(app, app._seasonResults)

  // Cups
  app._cups = createCupsModule(app)
  Object.assign(app, app._cups)

  // Accounts
  app._accounts = createAccountsModule(app)
  Object.assign(app, app._accounts)

  // Images
  app._images = createImagesModule(app)
  Object.assign(app, app._images)

  // Export
  app._export = createExportModule(app)
  Object.assign(app, app._export)
}

// ================================================================================
// Pure utility functions (no `this` needed)
// ================================================================================
function escapeHtml(unsafe) {
  if (unsafe === null || unsafe === undefined) return ''
  return String(unsafe).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;')
}

function formatDate(dateValue) {
  if (!dateValue) return ''
  let date
  if (dateValue instanceof Date) {
    date = new Date(dateValue.getFullYear(), dateValue.getMonth(), dateValue.getDate())
  } else if (typeof dateValue === 'string') {
    const datePart = dateValue.split('T')[0]
    const [year, month, day] = datePart.split('-').map(Number)
    date = new Date(year, month - 1, day)
  } else return ''
  return date.toLocaleDateString('vi-VN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function formatMoney(amount) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount)
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer')
  if (!container) return
  const toast = document.createElement('div')
  toast.className = `toast ${type}`
  toast.innerHTML = `<span class="toast-message">${escapeHtml(message)}</span><button class="toast-close">&times;</button>`
  container.appendChild(toast)
  toast.querySelector('.toast-close').addEventListener('click', () => toast.remove())
  setTimeout(() => {
    if (toast.parentElement) {
      toast.style.animation = 'toastOut 0.3s ease forwards'
      setTimeout(() => toast.remove(), 300)
    }
  }, 5000)
}

function showModal(modalId) {
  const modal = document.getElementById(modalId)
  if (modal) { modal.classList.add('show'); document.body.style.overflow = 'hidden' }
}

function hideModal(modalId) {
  const modal = document.getElementById(modalId)
  if (modal) { modal.classList.remove('show', 'active'); modal.style.display = ''; document.body.style.overflow = '' }
}

function updateFileStatus(message, type = 'info') {
  // For backward compatibility: strip leading emoji and use toast
  const cleanMsg = message.replace(/^[✅❌⚠️]/g, '').trim()
  const toastType = type === 'success' ? 'success' : (type === 'error' ? 'error' : 'warning')
  showToast(cleanMsg, toastType)
}

function setTodaysDate() {
  const today = new Date().toISOString().split('T')[0]
  const matchDate = document.getElementById('matchDate')
  if (matchDate) matchDate.value = today
}

function formatUptime(seconds) {
  if (!seconds || seconds < 0) return 'N/A'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

// ================================================================================
// Tab switching (enhanced with feature dispatch)
// ================================================================================
// Override switchTab on prototype to include feature dispatch
TennisRankingSystem.prototype.switchTab = async function (tabName) {
  this.hideAllViewModeSections()

  const prevActiveBtn = document.querySelector('.nav-btn.active')
  const prevActiveContent = document.querySelector('.tab-content.active')

  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'))
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'))

  const tabBtn = document.querySelector(`.nav-btn[data-tab="${tabName}"]`)
  const tabContent = document.getElementById(`${tabName}-tab`)
  if (tabBtn) tabBtn.classList.add('active')
  if (tabContent) tabContent.classList.add('active')

  try {
    switch (tabName) {
      case 'rankings':
        this.updateDateSelector()
        this.updateSeasonSelector()
        this.setupViewModeUI()
        await this.renderRankings()
        break
      case 'matches':
        this.switchToSingleMode()
        await this.loadPlayers()
        this.updatePlayerSelects()
        this.setTodaysDate()
        this.updateMatchHistoryDateSelector()
        await this.renderMatchHistory()
        break
      case 'players': this.renderPlayers(); break
      case 'seasons': this.renderSeasons(); break
      case 'accounts':
        this.renderAccounts()
        if (this.user?.role === 'admin') this.renderCacheStatus()
        break
      case 'images': this.loadSiteImages(); break
      case 'cups': this.loadCups(); break
    }
  } catch (error) {
    if (prevActiveBtn) prevActiveBtn.classList.add('active')
    if (prevActiveContent) prevActiveContent.classList.add('active')
    if (tabBtn) tabBtn.classList.remove('active')
    if (tabContent) tabContent.classList.remove('active')
    this.showToast(`Lỗi khi tải tab ${tabName}`, 'error')
    console.error(`Tab switch failed for ${tabName}:`, error)
  }
}

// ── Match type toggle (needed by both matches module and event listeners) ────
TennisRankingSystem.prototype.switchMatchType = function (type) {
  this.currentMatchType = type
  const matchTypeInput = document.getElementById('matchType')
  if (matchTypeInput) matchTypeInput.value = type
  document.querySelectorAll('.type-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.type === type))
  this.updateTeamLabelsForMatchType()
  if (type === 'solo') document.querySelectorAll('.duo-only').forEach(el => el.style.display = 'none')
  else document.querySelectorAll('.duo-only').forEach(el => el.style.display = '')
  const winnerSelect = document.getElementById('winner')
  if (winnerSelect) winnerSelect.value = ''
  this.currentWinningTeam = null
}

TennisRankingSystem.prototype.updateTeamLabelsForMatchType = function () {
  const player3Label = document.querySelector('.player3-label')
  const team2Badge = document.querySelector('.team-2-badge')
  if (this.currentMatchType === 'solo') {
    if (player3Label) player3Label.textContent = 'Người chơi 2'
    if (team2Badge) team2Badge.textContent = 'Đối thủ'
  } else {
    if (player3Label) player3Label.textContent = 'Người chơi 3'
    if (team2Badge) team2Badge.textContent = 'Đội 2'
  }
}

// ── Login modal (uses existing #loginModal from HTML) ───────────────────
TennisRankingSystem.prototype.showLoginModal = function () {
  showModal('loginModal')
  // Wire submit handler (modal is reused, attach once)
  const form = document.getElementById('loginForm')
  if (form) {
    // Remove old listener if exists (clone node to reset listeners)
    const newForm = form.cloneNode(true)
    form.parentNode.replaceChild(newForm, form)
    newForm.addEventListener('submit', async (e) => {
      e.preventDefault()
      const result = await this.login(
        document.getElementById('loginUsername').value,
        document.getElementById('loginPassword').value
      )
      if (result.success) {
        hideModal('loginModal')
        this.updateFileStatus('✅ Đăng nhập thành công!', 'success')
      } else {
        document.getElementById('loginError').textContent = result.message
      }
    })
  }
}

// ── Save season alias (seasons module uses handleSeasonFormSubmit) ───────────
TennisRankingSystem.prototype.saveSeason = async function () {
  const seasonId = document.getElementById('seasonId').value
  const isEdit = !!seasonId
  await this.handleSeasonFormSubmit(isEdit, isEdit ? parseInt(seasonId) : null)
}

// ================================================================================
// Boot
// ================================================================================
document.addEventListener('DOMContentLoaded', () => {
  // Already handled in constructor via DOMContentLoaded wait
  // This is a safety net for direct script inclusion
  if (!window.__tennisApp) {
    window.__tennisApp = new TennisRankingSystem()
  }
})

// Immediate init (constructor handles DOMContentLoaded wait internally)
if (!document.readyState.includes('loading')) {
  window.__tennisApp = new TennisRankingSystem()
}
