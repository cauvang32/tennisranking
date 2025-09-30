import './style.css'
import ExcelJS from 'exceljs'

// Tennis Ranking System with PostgreSQL Database
class TennisRankingSystem {
  constructor() {
    this.players = []
    this.matches = []
    this.seasons = []
    this.playDates = []
    this.currentViewMode = 'daily' // daily, season, lifetime
    this.selectedDate = null
    this.selectedSeason = null
    this.autoSaveEnabled = true
    this.serverMode = true
    this.apiBase = this.getApiBaseUrl()
    this.isAuthenticated = false
    this.user = null
    this.csrfToken = null // CSRF token for secure requests
    this.currentWinningTeam = null
    this.isManualWinnerMode = false
    this.init()
  }

  // Auto-detect API base URL for subpath deployments
  getApiBaseUrl() {
    const currentPath = window.location.pathname
    const currentOrigin = window.location.origin
    const currentHost = window.location.host
    
    console.log('🔍 Detecting API base URL...')
    console.log('📍 Current path:', currentPath)
    console.log('🌐 Current origin:', currentOrigin)
    console.log('🏠 Current host:', currentHost)
    
    // Special case: if we're on hungsanity.com or similar production domains
    // and the path starts with /tennis, use tennis subpath
    if (currentPath.startsWith('/tennis')) {
      const apiBase = `${currentOrigin}/tennis/api`
      console.log('✅ Tennis subpath deployment detected')
      console.log('🔗 API Base URL:', apiBase)
      return apiBase
    }
    
    // Check if we're on a production domain (not localhost)
    const isProduction = !currentHost.includes('localhost') && !currentHost.includes('127.0.0.1')
    
    if (isProduction) {
      // For production domains, check if we need to use a subpath
      const pathSegments = currentPath.split('/').filter(segment => segment && segment !== 'index.html')
      
      if (pathSegments.length > 0) {
        const potentialSubpath = pathSegments[0]
        const commonSubpaths = ['tennis', 'app', 'ranking', 'admin', 'dashboard']
        
        if (commonSubpaths.includes(potentialSubpath)) {
          const apiBase = `${currentOrigin}/${potentialSubpath}/api`
          console.log('✅ Production subpath detected:', potentialSubpath)
          console.log('🔗 API Base URL:', apiBase)
          return apiBase
        }
      }
      
      // Production domain but no clear subpath - try tennis as default
      // This handles cases where the app is served from /tennis/ but accessed directly
      const testApiBase = `${currentOrigin}/tennis/api`
      console.log('✅ Production domain - trying tennis subpath as default')
      console.log('🔗 API Base URL (will test):', testApiBase)
      
      // We'll test this URL and fall back to root if it doesn't work
      return testApiBase
    }
    
    // Development or localhost - use root API
    const apiBase = `${currentOrigin}/api`
    console.log('✅ Development/localhost detected - using root API')
    console.log('🔗 API Base URL:', apiBase)
    return apiBase
  }

  async init() {
    try {
      await this.detectServerMode()
      await this.checkAuthStatus()
      
      // Wait for DOM to be fully loaded
      if (document.readyState === 'loading') {
        await new Promise(resolve => {
          document.addEventListener('DOMContentLoaded', resolve)
        })
      }
      
      // Hide all view mode sections initially
      this.hideAllViewModeSections()
      
      this.setupEventListeners()
      await this.loadInitialData()
      this.updateUIForAuthStatus()
      
      // Ensure rankings tab is properly activated
      this.switchTab('rankings')
      
      // System is ready
      this.updateFileStatus('✅ Hệ thống đã sẵn sàng', 'success')
    } catch (error) {
      console.error('Error initializing system:', error)
      this.updateFileStatus('❌ Lỗi khởi tạo hệ thống. Vui lòng tải lại trang.', 'error')
    }
  }

  hideAllViewModeSections() {
    try {
      // Hide any view mode sections that might be visible outside their proper containers
      const viewModeSections = document.querySelectorAll('.view-mode-section')
      viewModeSections.forEach(section => {
        section.classList.add('hidden')
      })
    } catch (error) {
      console.error('Error hiding view mode sections:', error)
    }
  }

  async detectServerMode() {
    try {
      const response = await fetch(`${this.apiBase}/players`, {
        credentials: 'include',
        headers: {
          'Accept': 'application/json'
        }
      })
      
      if (response.ok) {
        this.serverMode = true
        console.log('✅ Server mode detected - using server database')
        console.log('✅ API base URL confirmed:', this.apiBase)
        return
      } else {
        throw new Error(`Server responded with ${response.status}`)
      }
    } catch (error) {
      console.log('⚠️ Primary API URL failed:', this.apiBase)
      console.log('🔄 Trying fallback API URL...')
      
      // Try fallback URL - if we tried subpath, try root, and vice versa
      let fallbackApiBase
      const currentOrigin = window.location.origin
      
      if (this.apiBase.includes('/tennis/api')) {
        // We tried tennis subpath, try root
        fallbackApiBase = `${currentOrigin}/api`
      } else {
        // We tried root, try tennis subpath
        fallbackApiBase = `${currentOrigin}/tennis/api`
      }
      
      try {
        console.log('🔄 Testing fallback:', fallbackApiBase)
        const fallbackResponse = await fetch(`${fallbackApiBase}/players`, {
          credentials: 'include',
          headers: {
            'Accept': 'application/json'
          }
        })
        
        if (fallbackResponse.ok) {
          this.apiBase = fallbackApiBase
          this.serverMode = true
          console.log('✅ Fallback API URL works - updated API base:', this.apiBase)
          return
        }
      } catch (fallbackError) {
        console.log('❌ Fallback API URL also failed')
      }
      
      console.log('⚠️ No server available, falling back to local storage mode')
      this.serverMode = false
      this.apiBase = null
    }
  }

  async checkAuthStatus() {
    if (!this.serverMode) return
    
    try {
      const response = await fetch(`${this.apiBase}/auth/status`, {
        method: 'GET',
        credentials: 'include' // Use httpOnly cookies instead of Authorization header
      })
      
      if (response.ok) {
        const data = await response.json()
        this.isAuthenticated = data.authenticated
        this.user = data.user
        this.csrfToken = data.csrfToken // Get CSRF token for authenticated users
      }
    } catch (error) {
      console.log('Auth status check failed:', error)
      this.isAuthenticated = false
      this.csrfToken = null
    }
  }

  async login(username, password) {
    try {
      const response = await fetch(`${this.apiBase}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({ username, password })
      })

      const data = await response.json()
      
      if (response.ok) {
        this.isAuthenticated = true
        this.user = data.user
        this.csrfToken = data.csrfToken // Store CSRF token from login response
        this.updateUIForAuthStatus()
        await this.loadInitialData() // Reload data after login
        return { success: true, message: data.message }
      } else {
        return { success: false, message: data.error }
      }
    } catch (error) {
      return { success: false, message: 'Lỗi kết nối server' }
    }
  }

  async logout() {
    try {
      // Include CSRF token if authenticated
      const headers = {
        'Content-Type': 'application/json'
      }
      if (this.csrfToken) {
        headers['X-CSRF-Token'] = this.csrfToken
      }
      
      await fetch(`${this.apiBase}/auth/logout`, {
        method: 'POST',
        headers,
        credentials: 'include'
      })
    } catch (error) {
      console.log('Logout request failed:', error)
    }
    
    this.isAuthenticated = false
    this.user = null
    this.csrfToken = null
    this.updateUIForAuthStatus()
  }

  updateUIForAuthStatus() {
    this.updateAuthHeader()
    
    const userRole = this.user?.role || null
    
    // Handle general edit elements (for any authenticated user)
    const editElements = document.querySelectorAll('.edit-only')
    editElements.forEach(element => {
      if (this.isAuthenticated) {
        element.classList.remove('hidden')
      } else {
        element.classList.add('hidden')
      }
    })
    
    // Handle admin-only elements
    const adminElements = document.querySelectorAll('.admin-only')
    adminElements.forEach(element => {
      if (userRole === 'admin') {
        element.classList.remove('hidden')
      } else {
        element.classList.add('hidden')
      }
    })
    
    // Handle editor elements (admin or editor)
    const editorElements = document.querySelectorAll('.editor-only')
    editorElements.forEach(element => {
      if (userRole === 'admin' || userRole === 'editor') {
        element.classList.remove('hidden')
      } else {
        element.classList.add('hidden')
      }
    })
    
    const guestInfo = document.querySelector('.guest-info')
    if (guestInfo) {
      if (this.isAuthenticated) {
        guestInfo.classList.add('hidden')
      } else {
        guestInfo.classList.remove('hidden')
      }
    }
    
    // Show/hide tabs based on role
    const playerTab = document.querySelector('[data-tab="players"]')
    const matchTab = document.querySelector('[data-tab="matches"]')
    const seasonTab = document.querySelector('[data-tab="seasons"]')
    
    // Admin gets access to all tabs
    if (userRole === 'admin') {
      [playerTab, matchTab, seasonTab].forEach(tab => {
        if (tab) tab.classList.remove('hidden')
      })
    }
    // Editor gets limited access - only matches for editing
    else if (userRole === 'editor') {
      if (playerTab) playerTab.classList.add('hidden')
      if (matchTab) matchTab.classList.remove('hidden')
      if (seasonTab) seasonTab.classList.add('hidden')
    }
    // Guests see no editing tabs
    else {
      [playerTab, matchTab, seasonTab].forEach(tab => {
        if (tab) {
          tab.classList.add('hidden')
          if (tab.classList.contains('active')) {
            this.switchTab('rankings')
          }
        }
      })
    }
    
    this.renderPlayers()
    this.renderSeasons()
    this.renderMatchHistory()
  }

  // Helper method to get CSRF token
  async getCSRFToken() {
    if (this.csrfToken) {
      return this.csrfToken
    }
    
    try {
      const response = await fetch(`${this.apiBase}/csrf-token`, {
        credentials: 'include'
      })
      
      if (response.ok) {
        const data = await response.json()
        this.csrfToken = data.csrfToken
        return this.csrfToken
      }
    } catch (error) {
      console.error('Failed to get CSRF token:', error)
    }
    
    return null
  }

  // Helper method to make authenticated requests with CSRF protection
  async makeAuthenticatedRequest(url, options = {}) {
    if (!this.isAuthenticated) {
      throw new Error('Authentication required')
    }
    
    const csrfToken = await this.getCSRFToken()
    if (!csrfToken) {
      throw new Error('CSRF token required')
    }
    
    const headers = {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
      ...options.headers
    }
    
    return fetch(url, {
      ...options,
      headers,
      credentials: 'include'
    })
  }

  updateAuthHeader() {
    const header = document.querySelector('header')
    let authDiv = header.querySelector('.auth-section')
    
    if (!authDiv) {
      authDiv = document.createElement('div')
      authDiv.className = 'auth-section'
      header.appendChild(authDiv)
    }
    
    if (this.isAuthenticated) {
      const roleLabel = this.user.role === 'admin' ? '👑 Quản trị viên' : '✏️ Biên tập viên'
      const roleClass = this.user.role === 'admin' ? 'admin-role' : 'editor-role'
      
      authDiv.innerHTML = `
        <div class="user-info">
          <span class="user-name">👤 ${this.user.username}</span>
          <span class="user-role ${roleClass}">${roleLabel}</span>
          <button id="logoutBtn" class="logout-btn">Đăng xuất</button>
        </div>
      `
      document.getElementById('logoutBtn').addEventListener('click', () => this.logout())
    } else {
      authDiv.innerHTML = `
        <div class="login-section">
          <span class="view-mode">📖 Chế độ xem</span>
          <button id="loginBtn" class="login-btn">Đăng nhập</button>
        </div>
      `
      document.getElementById('loginBtn').addEventListener('click', () => this.showLoginModal())
    }
  }

  showLoginModal() {
    const modal = document.createElement('div')
    modal.className = 'modal'
    modal.innerHTML = `
      <div class="modal-content">
        <h2>🔐 Đăng nhập quản trị</h2>
        <form id="loginForm">
          <div class="form-group">
            <label for="loginUsername">Tên đăng nhập:</label>
            <input type="text" id="loginUsername" required>
          </div>
          <div class="form-group">
            <label for="loginPassword">Mật khẩu:</label>
            <input type="password" id="loginPassword" required>
          </div>
          <div class="form-actions">
            <button type="submit">Đăng nhập</button>
            <button type="button" id="cancelLogin">Hủy</button>
          </div>
        </form>
        <div id="loginError" class="error-message"></div>
      </div>
    `
    
    document.body.appendChild(modal)
    
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault()
      const username = document.getElementById('loginUsername').value
      const password = document.getElementById('loginPassword').value
      const errorDiv = document.getElementById('loginError')
      
      const result = await this.login(username, password)
      
      if (result.success) {
        document.body.removeChild(modal)
        this.updateFileStatus('✅ Đăng nhập thành công!', 'success')
      } else {
        errorDiv.textContent = result.message
      }
    })
    
    document.getElementById('cancelLogin').addEventListener('click', () => {
      document.body.removeChild(modal)
    })
    
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        document.body.removeChild(modal)
      }
    })
  }

  async loadInitialData() {
    if (!this.serverMode) {
      this.updateFileStatus('⚠️ Không thể kết nối server. Vui lòng khởi động server.', 'error')
      return
    }

    try {
      // Load all data
      await Promise.all([
        this.loadPlayers(),
        this.loadSeasons(),
        this.loadPlayDates(),
        this.loadMatches()
      ])
      
      // Update UI components after loading data
      this.updatePlayerSelects()
      this.setTodaysDate()
      
      // Set default view mode and render
      await this.setDefaultViewMode()
      
    } catch (error) {
      console.error('Error loading initial data:', error)
      this.updateFileStatus('❌ Lỗi tải dữ liệu từ server', 'error')
    }
  }

  async loadPlayers() {
    try {
      const response = await fetch(`${this.apiBase}/players`)
      if (response.ok) {
        this.players = await response.json()
      }
    } catch (error) {
      console.error('Error loading players:', error)
    }
  }

  async loadSeasons() {
    try {
      const response = await fetch(`${this.apiBase}/seasons`)
      if (response.ok) {
        this.seasons = await response.json()
      }
    } catch (error) {
      console.error('Error loading seasons:', error)
    }
  }

  async loadPlayDates() {
    try {
      const response = await fetch(`${this.apiBase}/play-dates`)
      if (response.ok) {
        this.playDates = await response.json()
      }
    } catch (error) {
      console.error('Error loading play dates:', error)
    }
  }

  async loadMatches() {
    try {
      const response = await fetch(`${this.apiBase}/matches`)
      if (response.ok) {
        this.matches = await response.json()
      }
    } catch (error) {
      console.error('Error loading matches:', error)
    }
  }

  async setDefaultViewMode() {
    try {
      // Check if we have any play dates
      if (this.playDates.length > 0) {
        this.currentViewMode = 'daily'
        // Convert to date-only format to avoid timezone issues
        this.selectedDate = this.playDates[0].play_date.split('T')[0]
      } else {
        // Fall back to season mode
        const activeSeason = this.seasons.find(s => s.is_active)
        if (activeSeason) {
          this.currentViewMode = 'season'
          this.selectedSeason = activeSeason.id
        } else {
          this.currentViewMode = 'lifetime'
        }
      }
      
      // Only update UI elements if we're on the rankings tab
      if (document.querySelector('.tab-content.active')?.id === 'rankings-tab') {
        this.updateDateSelector()
        this.updateSeasonSelector()
        await this.renderRankings()
        await this.renderMatchHistory()
      }
      
      this.updatePlayerSelects()
    } catch (error) {
      console.error('Error setting default view mode:', error)
      // Fallback to lifetime mode
      this.currentViewMode = 'lifetime'
    }
  }

  setupEventListeners() {
    try {
      // Tab switching
      document.querySelectorAll('.tab-button').forEach(button => {
        button.addEventListener('click', (e) => {
          this.switchTab(e.target.dataset.tab)
        })
      })

      // Add player
      const addPlayerBtn = document.getElementById('addPlayer')
      if (addPlayerBtn) {
        addPlayerBtn.addEventListener('click', async () => {
          await this.addPlayer()
        })
      }

      const playerNameInput = document.getElementById('playerName')
      if (playerNameInput) {
        playerNameInput.addEventListener('keypress', async (e) => {
          if (e.key === 'Enter') {
            await this.addPlayer()
          }
        })
      }

      // Delete player buttons (using event delegation)
      document.addEventListener('click', async (e) => {
        if (e.target.classList.contains('delete-btn') && e.target.dataset.playerId) {
          const playerId = parseInt(e.target.dataset.playerId)
          await this.removePlayer(playerId)
        }
      })

      // Record match
      const recordMatchBtn = document.getElementById('recordMatch')
      if (recordMatchBtn) {
        recordMatchBtn.addEventListener('click', async () => {
          await this.recordMatch()
        })
      }

      // Add match modal
      const addMatchModalBtn = document.getElementById('addMatchModal')
      if (addMatchModalBtn) {
        addMatchModalBtn.addEventListener('click', () => {
          this.showMatchModal()
        })
      }

      // Export rankings
      const exportBtn = document.getElementById('exportRankings')
      if (exportBtn) {
        exportBtn.addEventListener('click', () => {
          this.exportToExcel()
        })
      }

      // View mode switching
      const viewModeDailyBtn = document.getElementById('viewModeDaily')
      if (viewModeDailyBtn) {
        viewModeDailyBtn.addEventListener('click', () => {
          this.switchViewMode('daily')
        })
      }
      
      const viewModeSeasonBtn = document.getElementById('viewModeSeason')
      if (viewModeSeasonBtn) {
        viewModeSeasonBtn.addEventListener('click', () => {
          this.switchViewMode('season')
        })
      }
      
      const viewModeLifetimeBtn = document.getElementById('viewModeLifetime')
      if (viewModeLifetimeBtn) {
        viewModeLifetimeBtn.addEventListener('click', () => {
          this.switchViewMode('lifetime')
        })
      }

      // Date and season selectors
      const dateSelector = document.getElementById('dateSelector')
      if (dateSelector) {
        dateSelector.addEventListener('change', (e) => {
          this.selectedDate = e.target.value
          if (this.currentViewMode === 'daily') {
            this.renderRankings()
            this.renderMatchHistory()
          }
        })
      }

      const seasonSelector = document.getElementById('seasonSelector')
      if (seasonSelector) {
        seasonSelector.addEventListener('change', (e) => {
          this.selectedSeason = parseInt(e.target.value)
          if (this.currentViewMode === 'season') {
            this.renderRankings()
            this.renderMatchHistory()
          }
        })
      }

      // Season management
      const addSeasonBtn = document.getElementById('addSeason')
      if (addSeasonBtn) {
        addSeasonBtn.addEventListener('click', () => {
          this.showSeasonModal()
        })
      }

      // Clear all data button
      const clearAllDataBtn = document.getElementById('clearAllData')
      if (clearAllDataBtn) {
        clearAllDataBtn.addEventListener('click', () => {
          this.clearAllData()
        })
      }

      // Backup data button
      const backupDataBtn = document.getElementById('backupData')
      if (backupDataBtn) {
        backupDataBtn.addEventListener('click', () => {
          this.backupData()
        })
      }

      // Restore data button
      const restoreDataBtn = document.getElementById('restoreData')
      if (restoreDataBtn) {
        restoreDataBtn.addEventListener('click', () => {
          this.restoreData()
        })
      }

      // Auto-winner detection for score inputs
      const team1ScoreInput = document.getElementById('team1Score')
      const team2ScoreInput = document.getElementById('team2Score')
      if (team1ScoreInput && team2ScoreInput) {
        team1ScoreInput.addEventListener('input', () => this.updateAutoWinner())
        team2ScoreInput.addEventListener('input', () => this.updateAutoWinner())
      }

      // Manual winner toggle
      const useManualWinnerBtn = document.getElementById('useManualWinner')
      const useAutoWinnerBtn = document.getElementById('useAutoWinner')
      if (useManualWinnerBtn && useAutoWinnerBtn) {
        useManualWinnerBtn.addEventListener('click', () => this.toggleWinnerMode(true))
        useAutoWinnerBtn.addEventListener('click', () => this.toggleWinnerMode(false))
      }


    } catch (error) {
      console.error('Error setting up event listeners:', error)
    }
  }

  switchTab(tabName) {
    // First hide all view mode sections
    this.hideAllViewModeSections()
    
    document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'))
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'))

    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active')
    document.getElementById(`${tabName}-tab`).classList.add('active')

    if (tabName === 'rankings') {
      // Show view mode section only in rankings tab
      const viewModeSection = document.querySelector('#rankings-tab .view-mode-section')
      if (viewModeSection) {
        viewModeSection.classList.remove('hidden')
      }
      
      // Setup view mode UI when switching to rankings
      this.updateDateSelector()
      this.updateSeasonSelector()
      this.setupViewModeUI()
      this.renderRankings()
      this.renderMatchHistory()
    } else if (tabName === 'matches') {
      // Update player selects and set today's date when switching to matches
      this.updatePlayerSelects()
      this.setTodaysDate()
      this.renderMatchHistory()
    } else if (tabName === 'players') {
      this.renderPlayers()
    } else if (tabName === 'seasons') {
      this.renderSeasons()
    }
  }

  async switchViewMode(mode) {
    this.currentViewMode = mode
    
    // Update active button
    document.querySelectorAll('.view-mode-btn').forEach(btn => btn.classList.remove('active'))
    document.getElementById(`viewMode${mode.charAt(0).toUpperCase() + mode.slice(1)}`).classList.add('active')
    
    // Show/hide relevant selectors
    const dateContainer = document.getElementById('dateSelectContainer')
    const seasonContainer = document.getElementById('seasonSelectContainer')
    
    if (dateContainer) {
      if (mode === 'daily') {
        dateContainer.classList.remove('hidden')
      } else {
        dateContainer.classList.add('hidden')
      }
    }
    
    if (seasonContainer) {
      if (mode === 'season') {
        seasonContainer.classList.remove('hidden')
      } else {
        seasonContainer.classList.add('hidden')
      }
    }
    
    // Set default selections if needed
    if (mode === 'daily' && !this.selectedDate && this.playDates.length > 0) {
      // Convert to date-only format to avoid timezone issues
      this.selectedDate = this.playDates[0].play_date.split('T')[0]
      document.getElementById('dateSelector').value = this.selectedDate
    }
    
    if (mode === 'season' && !this.selectedSeason) {
      const activeSeason = this.seasons.find(s => s.is_active)
      if (activeSeason) {
        this.selectedSeason = activeSeason.id
        document.getElementById('seasonSelector').value = this.selectedSeason
      }
    }
    
    await this.renderRankings()
    await this.renderMatchHistory()
  }

  setupViewModeUI() {
    try {
      // Update active view mode button
      document.querySelectorAll('.view-mode-btn').forEach(btn => btn.classList.remove('active'))
      const activeBtn = document.getElementById(`viewMode${this.currentViewMode.charAt(0).toUpperCase() + this.currentViewMode.slice(1)}`)
      if (activeBtn) {
        activeBtn.classList.add('active')
      }
      
      // Show/hide relevant selectors
      const dateContainer = document.getElementById('dateSelectContainer')
      const seasonContainer = document.getElementById('seasonSelectContainer')
      
      if (dateContainer) {
        if (this.currentViewMode === 'daily') {
          dateContainer.classList.remove('hidden')
        } else {
          dateContainer.classList.add('hidden')
        }
      }
      
      if (seasonContainer) {
        if (this.currentViewMode === 'season') {
          seasonContainer.classList.remove('hidden')
        } else {
          seasonContainer.classList.add('hidden')
        }
      }
      
      // Update view mode display
      this.updateViewModeDisplay()
    } catch (error) {
      console.error('Error setting up view mode UI:', error)
    }
  }

  async addPlayer() {
    const playerName = document.getElementById('playerName').value.trim()
    if (!playerName) {
      this.updateFileStatus('❌ Vui lòng nhập tên người chơi', 'error')
      return
    }

    if (!this.isAuthenticated) {
      this.updateFileStatus('❌ Cần đăng nhập để thêm người chơi', 'error')
      return
    }

    try {
      const response = await this.makeAuthenticatedRequest(`${this.apiBase}/players`, {
        method: 'POST',
        body: JSON.stringify({ name: playerName })
      })

      const data = await response.json()
      
      if (response.ok) {
        await this.loadPlayers()
        this.renderPlayers()
        this.updatePlayerSelects()
        document.getElementById('playerName').value = ''
        this.updateFileStatus(`✅ Đã thêm người chơi: ${playerName}`, 'success')
      } else {
        this.updateFileStatus(`❌ ${data.error}`, 'error')
      }
    } catch (error) {
      console.error('Error adding player:', error)
      this.updateFileStatus('❌ Lỗi khi thêm người chơi', 'error')
    }
  }

  async removePlayer(playerId) {
    if (!this.isAuthenticated) {
      this.updateFileStatus('❌ Cần đăng nhập để xóa người chơi', 'error')
      return
    }

    const player = this.players.find(p => p.id === playerId)
    if (!player) return

    const confirmDelete = confirm(`Bạn có chắc muốn xóa người chơi "${player.name}"? Tất cả lịch sử thi đấu của người này cũng sẽ bị xóa.`)
    if (!confirmDelete) return

    try {
      const response = await this.makeAuthenticatedRequest(`${this.apiBase}/players/${playerId}`, {
        method: 'DELETE'
      })

      if (response.ok) {
        await this.loadPlayers()
        await this.loadMatches()
        this.renderPlayers()
        this.renderRankings()
        this.renderMatchHistory()
        this.updatePlayerSelects()
        this.updateFileStatus(`✅ Đã xóa người chơi: ${player.name}`, 'success')
      } else {
        const data = await response.json()
        this.updateFileStatus(`❌ ${data.error}`, 'error')
      }
    } catch (error) {
      console.error('Error removing player:', error)
      this.updateFileStatus('❌ Lỗi khi xóa người chơi', 'error')
    }
  }

  async recordMatch() {
    if (!this.isAuthenticated) {
      this.updateFileStatus('❌ Cần đăng nhập để ghi nhận kết quả', 'error')
      return
    }

    // Check if we have an active season
    const activeSeason = this.seasons.find(s => s.is_active)
    if (!activeSeason) {
      this.updateFileStatus('❌ Cần tạo mùa giải trước khi ghi nhận trận đấu', 'error')
      this.switchTab('seasons')
      return
    }

    const playDate = document.getElementById('matchDate').value
    const player1Id = parseInt(document.getElementById('player1').value)
    const player2Id = parseInt(document.getElementById('player2').value)
    const player3Id = parseInt(document.getElementById('player3').value)
    const player4Id = parseInt(document.getElementById('player4').value)
    const team1Score = parseInt(document.getElementById('team1Score').value)
    const team2Score = parseInt(document.getElementById('team2Score').value)
    const winningTeam = parseInt(document.getElementById('winningTeam').value)

    // Validation
    if (!playDate) {
      this.updateFileStatus('❌ Vui lòng chọn ngày đánh', 'error')
      return
    }

    const playerIds = [player1Id, player2Id, player3Id, player4Id]
    if (playerIds.some(id => isNaN(id))) {
      this.updateFileStatus('❌ Vui lòng chọn đủ 4 người chơi', 'error')
      return
    }

    const uniquePlayerIds = [...new Set(playerIds)]
    if (uniquePlayerIds.length !== 4) {
      this.updateFileStatus('❌ Cần 4 người chơi khác nhau', 'error')
      return
    }

    if (isNaN(team1Score) || isNaN(team2Score) || team1Score < 0 || team2Score < 0) {
      this.updateFileStatus('❌ Vui lòng nhập tỷ số hợp lệ', 'error')
      return
    }

    // Use auto-selected winner if available
    let finalWinningTeam = winningTeam
    if (!this.isManualWinnerMode && this.currentWinningTeam) {
      finalWinningTeam = this.currentWinningTeam
    }

    if (finalWinningTeam !== 1 && finalWinningTeam !== 2) {
      this.updateFileStatus('❌ Vui lòng chọn đội thắng', 'error')
      return
    }

    try {
      const response = await this.makeAuthenticatedRequest(`${this.apiBase}/matches`, {
        method: 'POST',
        body: JSON.stringify({
          seasonId: activeSeason.id,
          playDate,
          player1Id,
          player2Id,
          player3Id,
          player4Id,
          team1Score,
          team2Score,
          winningTeam: finalWinningTeam
        })
      })

      const data = await response.json()
      
      if (response.ok) {
        await this.loadMatches()
        await this.loadPlayDates()
        
        // Reset form
        document.getElementById('matchDate').value = ''
        document.getElementById('team1Score').value = ''
        document.getElementById('team2Score').value = ''
        document.getElementById('winningTeam').value = ''
        
        // Reset to auto winner mode
        this.toggleWinnerMode(false)
        this.setTodaysDate()
        
        // Update displays
        this.renderRankings()
        this.renderMatchHistory()
        this.updateDateSelector()
        
        this.updateFileStatus('✅ Đã ghi nhận kết quả trận đấu', 'success')
      } else {
        this.updateFileStatus(`❌ ${data.error}`, 'error')
      }
    } catch (error) {
      console.error('Error recording match:', error)
      this.updateFileStatus('❌ Lỗi khi ghi nhận kết quả', 'error')
    }
  }

  renderPlayers() {
    try {
      const container = document.getElementById('playersList')
      if (!container) {
        console.warn('Players list container not found')
        return
      }

      const userRole = this.user?.role
      
      container.innerHTML = this.players.map(player => `
        <div class="player-card">
          <span class="player-name">${player.name}</span>
          ${userRole === 'admin' ? `
            <button class="delete-btn" data-player-id="${player.id}">❌</button>
          ` : ''}
        </div>
      `).join('')
    } catch (error) {
      console.error('Error rendering players:', error)
    }
  }

  renderSeasons() {
    try {
      const container = document.getElementById('seasonsList')
      if (!container) {
        console.warn('Seasons list container not found')
        return
      }

      const userRole = this.user?.role

      container.innerHTML = this.seasons.map(season => `
        <div class="season-card ${season.is_active ? 'active' : ''}">
          <div class="season-info">
            <h3>${season.name} ${season.is_active ? '(Đang hoạt động)' : ''}</h3>
            <p>📅 Từ: ${this.formatDate(season.start_date)}</p>
            ${season.end_date ? `<p>📅 Đến: ${this.formatDate(season.end_date)}</p>` : ''}
          </div>
          ${userRole === 'admin' ? `
            <div class="season-actions">
              ${season.is_active ? `
                <button data-action="end-season" data-id="${season.id}" class="end-season-btn">Kết thúc</button>
              ` : ''}
              <button data-action="edit-season" data-id="${season.id}" class="edit-btn">Sửa</button>
              <button data-action="delete-season" data-id="${season.id}" class="delete-btn">Xóa</button>
            </div>
          ` : ''}
        </div>
      `).join('')

      // Add event listeners for season actions
      if (userRole === 'admin') {
        container.querySelectorAll('[data-action]').forEach(button => {
          button.addEventListener('click', (e) => {
            const action = e.target.dataset.action
            const seasonId = parseInt(e.target.dataset.id)
            
            if (action === 'end-season') {
              this.endSeason(seasonId)
            } else if (action === 'edit-season') {
              this.editSeason(seasonId)
            } else if (action === 'delete-season') {
              this.deleteSeason(seasonId)
            }
          })
        })
      }
    } catch (error) {
      console.error('Error rendering seasons:', error)
    }
  }

  async renderRankings() {
    let rankings = []
    
    try {
      if (this.currentViewMode === 'daily' && this.selectedDate) {
        const response = await fetch(`${this.apiBase}/rankings/date/${this.selectedDate}`)
        if (response.ok) rankings = await response.json()
      } else if (this.currentViewMode === 'season' && this.selectedSeason) {
        const response = await fetch(`${this.apiBase}/rankings/season/${this.selectedSeason}`)
        if (response.ok) rankings = await response.json()
      } else if (this.currentViewMode === 'lifetime') {
        const response = await fetch(`${this.apiBase}/rankings/lifetime`)
        if (response.ok) rankings = await response.json()
      }
    } catch (error) {
      console.error('Error loading rankings:', error)
    }

    const container = document.getElementById('rankingsTable')
    if (!container) return

    const tbody = container.querySelector('tbody')
    tbody.innerHTML = rankings.map((player, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${player.name}</td>
        <td>${player.wins}</td>
        <td>${player.losses}</td>
        <td>${player.total_matches}</td>
        <td>${player.points}</td>
        <td>${player.win_percentage}%</td>
        <td>${this.formatMoney(player.money_lost)}</td>
        <td class="form-indicator">${this.renderForm(player.form || [])}</td>
      </tr>
    `).join('')

    // Update view mode display
    this.updateViewModeDisplay()
  }

  renderForm(form) {
    if (!form || form.length === 0) return ''
    
    return form.map(match => {
      const cssClass = match.result === 'win' ? 'form-dot-win' : 'form-dot-loss'
      return `<span class="form-dot ${cssClass}" title="${match.result === 'win' ? 'Thắng' : 'Thua'} - ${this.formatDate(match.play_date)}"></span>`
    }).join('')
  }

  async renderMatchHistory() {
    let matches = []
    
    try {
      if (this.currentViewMode === 'daily' && this.selectedDate) {
        const response = await fetch(`${this.apiBase}/matches/by-date/${this.selectedDate}`)
        if (response.ok) matches = await response.json()
      } else if (this.currentViewMode === 'season' && this.selectedSeason) {
        const response = await fetch(`${this.apiBase}/matches/by-season/${this.selectedSeason}`)
        if (response.ok) matches = await response.json()
      } else {
        const response = await fetch(`${this.apiBase}/matches`)
        if (response.ok) matches = await response.json()
      }
    } catch (error) {
      console.error('Error loading matches:', error)
    }

    const container = document.getElementById('matchHistory')
    if (!container) return

    container.innerHTML = matches.map(match => {
      const team1Players = `${match.player1_name} & ${match.player2_name}`
      const team2Players = `${match.player3_name} & ${match.player4_name}`
      const winnerClass = match.winning_team === 1 ? 'team1-win' : 'team2-win'
      
      const userRole = this.user?.role
      let editDeleteButtons = ''
      
      if (userRole === 'admin' || userRole === 'editor') {
        editDeleteButtons = `
          <div class="match-actions">
            <button data-action="edit-match" data-id="${match.id}" class="edit-btn" title="Sửa trận đấu">✏️</button>
            <button data-action="delete-match" data-id="${match.id}" class="delete-btn" title="Xóa trận đấu">🗑️</button>
          </div>
        `
      }
      
      return `
        <div class="match-card ${winnerClass}">
          <div class="match-info">
            <div class="match-date">📅 ${this.formatDate(match.play_date)}</div>
            <div class="match-season">🏆 ${match.season_name}</div>
            ${editDeleteButtons}
          </div>
          <div class="match-details">
            <div class="team ${match.winning_team === 1 ? 'winner' : ''}">
              <div class="team-players">${team1Players}</div>
              <div class="team-score">${match.team1_score}</div>
            </div>
            <div class="vs">VS</div>
            <div class="team ${match.winning_team === 2 ? 'winner' : ''}">
              <div class="team-players">${team2Players}</div>
              <div class="team-score">${match.team2_score}</div>
            </div>
          </div>
        </div>
      `
    }).join('')

    // Add event listeners for match actions
    if (this.isAuthenticated) {
      container.querySelectorAll('[data-action]').forEach(button => {
        button.addEventListener('click', (e) => {
          const action = e.target.dataset.action
          const matchId = parseInt(e.target.dataset.id)
          
          if (action === 'edit-match') {
            this.editMatch(matchId)
          } else if (action === 'delete-match') {
            this.deleteMatch(matchId)
          }
        })
      })
    }
  }

  updatePlayerSelects() {
    try {
      const playerOptions = this.players.map(player => 
        `<option value="${player.id}">${player.name}</option>`
      ).join('')

      const selects = ['player1', 'player2', 'player3', 'player4']
      selects.forEach(selectId => {
        const select = document.getElementById(selectId)
        if (select) {
          select.innerHTML = `<option value="">Chọn người chơi...</option>${playerOptions}`
        }
      })
    } catch (error) {
      console.error('Error updating player selects:', error)
    }
  }

  updateDateSelector() {
    const selector = document.getElementById('dateSelector')
    if (!selector) return

    selector.innerHTML = this.playDates.map(dateObj => {
      // Convert to date-only format (YYYY-MM-DD) to avoid timezone issues
      const dateOnly = dateObj.play_date.split('T')[0]
      return `<option value="${dateOnly}">${this.formatDate(dateObj.play_date)}</option>`
    }).join('')

    if (this.selectedDate) {
      // Also ensure selectedDate is in date-only format
      const selectedDateOnly = this.selectedDate.split('T')[0]
      selector.value = selectedDateOnly
    }
  }

  updateSeasonSelector() {
    const selector = document.getElementById('seasonSelector')
    if (!selector) return

    selector.innerHTML = this.seasons.map(season => 
      `<option value="${season.id}">${season.name}</option>`
    ).join('')

    if (this.selectedSeason) {
      selector.value = this.selectedSeason
    }
  }

  updateViewModeDisplay() {
    const display = document.getElementById('currentViewMode')
    if (!display) return

    let modeText = ''
    let exportText = '📊 Xuất Excel'
    
    if (this.currentViewMode === 'daily') {
      modeText = `Bảng xếp hạng theo ngày: ${this.formatDate(this.selectedDate)}`
      exportText = `📊 Xuất Excel (${this.formatDate(this.selectedDate)})`
    } else if (this.currentViewMode === 'season') {
      const season = this.seasons.find(s => s.id === this.selectedSeason)
      const seasonName = season ? season.name : 'Không xác định'
      modeText = `Bảng xếp hạng mùa giải: ${seasonName}`
      exportText = `📊 Xuất Excel (${seasonName})`
    } else {
      modeText = 'Bảng xếp hạng tổng (toàn thời gian)'
      exportText = '📊 Xuất Excel (Toàn thời gian)'
    }
    
    display.textContent = modeText
    
    // Update export button text
    const exportBtn = document.getElementById('exportRankings')
    if (exportBtn) {
      exportBtn.textContent = exportText
    }
  }

  showSeasonModal(seasonId = null) {
    const isEdit = seasonId !== null
    const season = isEdit ? this.seasons.find(s => s.id === seasonId) : null
    
    const modal = document.createElement('div')
    modal.className = 'modal'
    modal.innerHTML = `
      <div class="modal-content">
        <h2>${isEdit ? 'Chỉnh sửa mùa giải' : 'Tạo mùa giải mới'}</h2>
        <form id="seasonForm">
          <div class="form-group">
            <label for="seasonName">Tên mùa giải:</label>
            <input type="text" id="seasonName" value="${season ? season.name : ''}" required>
          </div>
          <div class="form-group">
            <label for="seasonStartDate">Ngày bắt đầu:</label>
            <input type="date" id="seasonStartDate" value="${season ? season.start_date : ''}" required>
          </div>
          ${isEdit ? `
            <div class="form-group">
              <label for="seasonEndDate">Ngày kết thúc:</label>
              <input type="date" id="seasonEndDate" value="${season ? season.end_date || '' : ''}">
            </div>
          ` : ''}
          <div class="form-actions">
            <button type="submit">${isEdit ? 'Cập nhật' : 'Tạo mùa giải'}</button>
            <button type="button" id="cancelSeason">Hủy</button>
          </div>
        </form>
        <div id="seasonError" class="error-message"></div>
      </div>
    `
    
    document.body.appendChild(modal)
    
    document.getElementById('seasonForm').addEventListener('submit', async (e) => {
      e.preventDefault()
      const name = document.getElementById('seasonName').value.trim()
      const startDate = document.getElementById('seasonStartDate').value
      const endDate = isEdit ? document.getElementById('seasonEndDate').value : null
      const errorDiv = document.getElementById('seasonError')
      
      if (!name || !startDate) {
        errorDiv.textContent = 'Vui lòng điền đầy đủ thông tin'
        return
      }
      
      const result = isEdit ? 
        await this.updateSeason(seasonId, name, startDate, endDate) :
        await this.createSeason(name, startDate)
      
      if (result.success) {
        document.body.removeChild(modal)
        this.updateFileStatus(result.message, 'success')
      } else {
        errorDiv.textContent = result.message
      }
    })
    
    document.getElementById('cancelSeason').addEventListener('click', () => {
      document.body.removeChild(modal)
    })
    
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        document.body.removeChild(modal)
      }
    })
  }

  async createSeason(name, startDate) {
    try {
      // Check if there's an active season that needs to be ended
      const activeSeason = this.seasons.find(s => s.is_active)
      
      if (activeSeason) {
        // Calculate the end date as one day before the new season starts
        const newSeasonDate = new Date(startDate)
        const endDate = new Date(newSeasonDate)
        endDate.setDate(endDate.getDate() - 1)
        const endDateString = endDate.toISOString().split('T')[0]
        
        // Ask user for confirmation
        const confirmEnd = confirm(
          `Hiện tại đang có mùa giải "${activeSeason.name}" đang hoạt động.\n` +
          `Bạn có muốn tự động kết thúc mùa giải này vào ngày ${this.formatDate(endDateString)} ` +
          `để bắt đầu mùa giải mới "${name}" vào ngày ${this.formatDate(startDate)}?`
        )
        
        if (!confirmEnd) {
          return { success: false, message: 'Đã hủy tạo mùa giải mới' }
        }
      }

      const response = await this.makeAuthenticatedRequest(`${this.apiBase}/seasons`, {
        method: 'POST',
        body: JSON.stringify({ 
          name, 
          startDate,
          autoEndPrevious: !!activeSeason
        })
      })

      const data = await response.json()
      
      if (response.ok) {
        await this.loadSeasons()
        this.renderSeasons()
        this.updateSeasonSelector()
        
        const message = activeSeason ? 
          `Đã tạo mùa giải mới "${name}" và kết thúc mùa giải trước đó` :
          'Đã tạo mùa giải mới thành công'
          
        return { success: true, message }
      } else {
        return { success: false, message: data.error }
      }
    } catch (error) {
      console.error('Error creating season:', error)
      return { success: false, message: 'Lỗi khi tạo mùa giải' }
    }
  }

  async updateSeason(seasonId, name, startDate, endDate) {
    try {
      const response = await this.makeAuthenticatedRequest(`${this.apiBase}/seasons/${seasonId}`, {
        method: 'PUT',
        body: JSON.stringify({ name, startDate, endDate })
      })

      const data = await response.json()
      
      if (response.ok) {
        await this.loadSeasons()
        this.renderSeasons()
        this.updateSeasonSelector()
        return { success: true, message: 'Đã cập nhật mùa giải thành công' }
      } else {
        return { success: false, message: data.error }
      }
    } catch (error) {
      console.error('Error updating season:', error)
      return { success: false, message: 'Lỗi khi cập nhật mùa giải' }
    }
  }

  async endSeason(seasonId) {
    const endDate = new Date().toISOString().split('T')[0]
    
    try {
      const response = await this.makeAuthenticatedRequest(`${this.apiBase}/seasons/${seasonId}/end`, {
        method: 'POST',
        body: JSON.stringify({ endDate })
      })

      const data = await response.json()
      
      if (response.ok) {
        await this.loadSeasons()
        this.renderSeasons()
        this.updateFileStatus('Đã kết thúc mùa giải', 'success')
      } else {
        this.updateFileStatus(`❌ ${data.error}`, 'error')
      }
    } catch (error) {
      console.error('Error ending season:', error)
      this.updateFileStatus('❌ Lỗi khi kết thúc mùa giải', 'error')
    }
  }

  editSeason(seasonId) {
    this.showSeasonModal(seasonId)
  }

  async deleteSeason(seasonId) {
    if (!this.isAuthenticated) {
      this.updateFileStatus('❌ Cần đăng nhập để xóa mùa giải', 'error')
      return
    }

    const season = this.seasons.find(s => s.id === seasonId)
    if (!season) {
      this.updateFileStatus('❌ Không tìm thấy mùa giải', 'error')
      return
    }

    // Check if this is an active season
    if (season.is_active) {
      this.updateFileStatus('❌ Không thể xóa mùa giải đang hoạt động. Vui lòng kết thúc mùa giải trước khi xóa.', 'error')
      return
    }

    // Show confirmation dialog
    const confirmDelete = confirm(
      `Bạn có chắc chắn muốn xóa mùa giải "${season.name}"?\n\n` +
      `⚠️ CẢNH BÁO: Tất cả dữ liệu trận đấu và thống kê liên quan đến mùa giải này sẽ bị xóa vĩnh viễn!\n\n` +
      `Hành động này không thể hoàn tác.`
    )

    if (!confirmDelete) {
      return
    }

    try {
      const response = await this.makeAuthenticatedRequest(`${this.apiBase}/seasons/${seasonId}`, {
        method: 'DELETE'
      })

      const data = await response.json()
      
      if (response.ok) {
        // Reload all data since deleting a season affects matches and rankings
        await Promise.all([
          this.loadSeasons(),
          this.loadMatches(),
          this.loadPlayDates()
        ])
        
        this.renderSeasons()
        this.updateSeasonSelector()
        
        // If we're in season view mode and this was the selected season, switch to lifetime view
        if (this.currentViewMode === 'season' && this.selectedSeason === seasonId) {
          await this.switchViewMode('lifetime')
        }
        
        this.updateFileStatus(`✅ Đã xóa mùa giải "${season.name}" thành công`, 'success')
      } else {
        this.updateFileStatus(`❌ ${data.error || 'Lỗi khi xóa mùa giải'}`, 'error')
      }
    } catch (error) {
      console.error('Error deleting season:', error)
      this.updateFileStatus('❌ Lỗi kết nối khi xóa mùa giải', 'error')
    }
  }

  async exportToExcel() {
    try {
      // Determine the export type based on current view mode
      let exportUrl = `${this.apiBase}/export-excel`
      let fileName = 'tennis-rankings'
      
      if (this.currentViewMode === 'daily' && this.selectedDate) {
        exportUrl += `/date/${this.selectedDate}`
        fileName += `-${this.selectedDate}`
      } else if (this.currentViewMode === 'season' && this.selectedSeason) {
        exportUrl += `/season/${this.selectedSeason}`
        fileName += `-season-${this.selectedSeason}`
      } else if (this.currentViewMode === 'lifetime') {
        exportUrl += '/lifetime'
        fileName += '-lifetime'
      }
      
      fileName += `-${new Date().toISOString().split('T')[0]}.xlsx`
      
      const response = await fetch(exportUrl)
      
      if (response.ok) {
        const blob = await response.blob()
        const url = window.URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.classList.add('hidden')
        a.href = url
        a.download = fileName
        document.body.appendChild(a)
        a.click()
        window.URL.revokeObjectURL(url)
        document.body.removeChild(a)
        
        let statusMessage = '✅ Đã xuất dữ liệu ra Excel thành công'
        if (this.currentViewMode === 'daily' && this.selectedDate) {
          statusMessage += ` (theo ngày: ${this.formatDate(this.selectedDate)})`
        } else if (this.currentViewMode === 'season' && this.selectedSeason) {
          statusMessage += ` (theo mùa giải: ${this.selectedSeason})`
        } else if (this.currentViewMode === 'lifetime') {
          statusMessage += ' (toàn thời gian)'
        }
        
        this.updateFileStatus(statusMessage, 'success')
      } else {
        this.updateFileStatus('❌ Lỗi khi xuất dữ liệu ra Excel', 'error')
      }
    } catch (error) {
      console.error('Error exporting to Excel:', error)
      this.updateFileStatus('❌ Lỗi khi xuất dữ liệu ra Excel', 'error')
    }
  }

  formatDate(dateValue) {
    if (!dateValue) return ''
    
    let date
    if (dateValue instanceof Date) {
      // If it's already a Date object, use local date components to avoid timezone issues
      date = new Date(dateValue.getFullYear(), dateValue.getMonth(), dateValue.getDate())
    } else if (typeof dateValue === 'string') {
      // If it's a string, parse it as local date to avoid UTC timezone conversion
      if (dateValue.includes('T') || dateValue.includes('Z')) {
        // ISO string format - extract date part only
        const datePart = dateValue.split('T')[0]
        const [year, month, day] = datePart.split('-').map(Number)
        date = new Date(year, month - 1, day) // month is 0-based
      } else {
        // Date-only string format like "2025-09-30"
        const [year, month, day] = dateValue.split('-').map(Number)
        date = new Date(year, month - 1, day) // month is 0-based
      }
    } else {
      return ''
    }
    
    return date.toLocaleDateString('vi-VN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
  }

  formatMoney(amount) {
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND'
    }).format(amount)
  }

  updateFileStatus(message, type = 'info') {
    try {
      const statusElement = document.getElementById('fileStatus')
      if (statusElement) {
        statusElement.textContent = message
        statusElement.className = `status-message status-${type}`
        
        setTimeout(() => {
          if (statusElement.textContent === message) {
            statusElement.textContent = ''
            statusElement.className = 'status-message'
          }
        }, 5000)
      } else {
        console.log(`Status: ${message} (${type})`)
      }
    } catch (error) {
      console.error('Error updating file status:', error)
      console.log(`Status: ${message} (${type})`)
    }
  }

  setTodaysDate() {
    const today = new Date().toISOString().split('T')[0]
    const matchDateInput = document.getElementById('matchDate')
    if (matchDateInput) {
      matchDateInput.value = today
    }
  }

  async clearAllData() {
    if (!this.isAuthenticated) {
      this.updateFileStatus('❌ Cần đăng nhập để xóa dữ liệu', 'error')
      return
    }

    // First confirmation
    const firstConfirm = confirm(
      '⚠️ CẢNH BÁO NGHIÊM TRỌNG ⚠️\n\n' +
      'Bạn sắp XÓA TẤT CẢ DỮ LIỆU trong hệ thống bao gồm:\n' +
      '• Tất cả người chơi\n' +
      '• Tất cả trận đấu\n' +
      '• Tất cả mùa giải\n' +
      '• Tất cả thống kê\n\n' +
      'HÀNH ĐỘNG NÀY KHÔNG THỂ HOÀN TÁC!\n\n' +
      'Bạn có chắc chắn muốn tiếp tục?'
    )

    if (!firstConfirm) return

    // Second confirmation with type verification
    const confirmText = prompt(
      'Để xác nhận việc xóa tất cả dữ liệu, vui lòng gõ chính xác từ: DELETE_ALL\n\n' +
      '(Gõ chính xác "DELETE_ALL" để xác nhận)'
    )

    if (confirmText !== 'DELETE_ALL') {
      this.updateFileStatus('❌ Đã hủy xóa dữ liệu (từ xác nhận không đúng)', 'info')
      return
    }

    // Final confirmation
    const finalConfirm = confirm(
      '🚨 XÁC NHẬN CUỐI CÙNG 🚨\n\n' +
      'Đây là cơ hội cuối cùng để hủy bỏ.\n' +
      'Sau khi nhấn OK, TẤT CẢ DỮ LIỆU sẽ bị xóa vĩnh viễn.\n\n' +
      'Bạn có THỰC SỰ muốn xóa tất cả dữ liệu?'
    )

    if (!finalConfirm) {
      this.updateFileStatus('❌ Đã hủy xóa dữ liệu (xác nhận cuối cùng)', 'info')
      return
    }

    try {
      this.updateFileStatus('🔄 Đang xóa tất cả dữ liệu...', 'info')

      const response = await this.makeAuthenticatedRequest(`${this.apiBase}/clear-all-data`, {
        method: 'DELETE'
      })

      const data = await response.json()

      if (response.ok) {
        // Clear local data
        this.players = []
        this.matches = []
        this.seasons = []
        this.playDates = []
        this.selectedDate = null
        this.selectedSeason = null

        // Refresh all UI
        this.renderPlayers()
        this.renderSeasons()
        this.renderRankings()
        this.renderMatchHistory()
        this.updatePlayerSelects()
        this.updateDateSelector()
        this.updateSeasonSelector()

        this.updateFileStatus('✅ Đã xóa tất cả dữ liệu thành công. Hệ thống đã được reset hoàn toàn.', 'success')
      } else {
        this.updateFileStatus(`❌ ${data.error || 'Lỗi khi xóa dữ liệu'}`, 'error')
      }
    } catch (error) {
      console.error('Error clearing all data:', error)
      this.updateFileStatus('❌ Lỗi kết nối khi xóa dữ liệu', 'error')
    }
  }

  async backupData() {
    if (!this.isAuthenticated) {
      this.updateFileStatus('❌ Cần đăng nhập để sao lưu dữ liệu', 'error')
      return
    }

    try {
      this.updateFileStatus('📦 Đang tạo bản sao lưu...', 'info')

      const response = await this.makeAuthenticatedRequest(`${this.apiBase}/backup-data`, {
        method: 'GET'
      })

      if (response.ok) {
        const blob = await response.blob()
        const url = window.URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.classList.add('hidden')
        a.href = url
        
        // Get filename from response header or create default
        const contentDisposition = response.headers.get('content-disposition')
        let fileName = 'tennis-backup.json'
        if (contentDisposition) {
          const fileNameMatch = contentDisposition.match(/filename="?([^"]+)"?/)
          if (fileNameMatch) {
            fileName = fileNameMatch[1]
          }
        }
        
        a.download = fileName
        document.body.appendChild(a)
        a.click()
        window.URL.revokeObjectURL(url)
        document.body.removeChild(a)

        this.updateFileStatus('✅ Đã tạo bản sao lưu thành công', 'success')
      } else {
        const errorData = await response.json()
        this.updateFileStatus(`❌ ${errorData.error || 'Lỗi khi tạo bản sao lưu'}`, 'error')
      }
    } catch (error) {
      console.error('Error creating backup:', error)
      this.updateFileStatus('❌ Lỗi kết nối khi tạo bản sao lưu', 'error')
    }
  }

  async restoreData() {
    if (!this.isAuthenticated) {
      this.updateFileStatus('❌ Cần đăng nhập để khôi phục dữ liệu', 'error')
      return
    }

    // Show file input dialog
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.classList.add('hidden')
    
    input.onchange = async (event) => {
      const file = event.target.files[0]
      if (!file) return

      try {
        // Validate file type
        if (!file.name.endsWith('.json')) {
          this.updateFileStatus('❌ Vui lòng chọn file JSON (.json)', 'error')
          return
        }

        // Read file
        const fileContent = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = e => resolve(e.target.result)
          reader.onerror = reject
          reader.readAsText(file)
        })

        // Parse JSON
        let backupData
        try {
          backupData = JSON.parse(fileContent)
        } catch (error) {
          this.updateFileStatus('❌ File không phải là JSON hợp lệ', 'error')
          return
        }

        // Validate backup structure
        if (!backupData.version || !backupData.data) {
          this.updateFileStatus('❌ File sao lưu không đúng định dạng', 'error')
          return
        }

        // Show restore options
        this.showRestoreDialog(backupData)

      } catch (error) {
        console.error('Error reading backup file:', error)
        this.updateFileStatus('❌ Lỗi khi đọc file sao lưu', 'error')
      }
    }

    document.body.appendChild(input)
    input.click()
    document.body.removeChild(input)
  }

  showRestoreDialog(backupData) {
    const modal = document.createElement('div')
    modal.className = 'modal'
    modal.innerHTML = `
      <div class="modal-content">
        <h2>Khôi Phục Dữ Liệu</h2>
        <div class="backup-info">
          <p><strong>Thông tin bản sao lưu:</strong></p>
          <ul>
            <li>Phiên bản: ${backupData.version}</li>
            <li>Ngày tạo: ${new Date(backupData.timestamp).toLocaleString('vi-VN')}</li>
            <li>Người tạo: ${backupData.exportedBy || 'Không rõ'}</li>
            <li>Số người chơi: ${backupData.metadata?.playersCount || 0}</li>
            <li>Số mùa giải: ${backupData.metadata?.seasonsCount || 0}</li>
            <li>Số trận đấu: ${backupData.metadata?.matchesCount || 0}</li>
          </ul>
        </div>
        <div class="form-group">
          <label>
            <input type="checkbox" id="clearExisting" />
            Xóa tất cả dữ liệu hiện tại trước khi khôi phục
          </label>
          <small style="color: #666; display: block; margin-top: 0.5rem;">
            ⚠️ Nếu không chọn, dữ liệu mới sẽ được thêm vào dữ liệu hiện tại (có thể bị trùng lặp)
          </small>
        </div>
        <div class="form-actions">
          <button type="button" id="confirmRestore">Khôi Phục</button>
          <button type="button" id="cancelRestore">Hủy</button>
        </div>
      </div>
    `

    document.body.appendChild(modal)

    const confirmBtn = modal.querySelector('#confirmRestore')
    const cancelBtn = modal.querySelector('#cancelRestore')
    const clearExistingCheckbox = modal.querySelector('#clearExisting')

    confirmBtn.onclick = async () => {
      const clearExisting = clearExistingCheckbox.checked

      if (clearExisting) {
        const confirmClear = confirm(
          '⚠️ CẢNH BÁO ⚠️\n\n' +
          'Bạn đã chọn xóa tất cả dữ liệu hiện tại.\n' +
          'Điều này sẽ XÓA TẤT CẢ dữ liệu hiện tại và thay thế bằng dữ liệu từ bản sao lưu.\n\n' +
          'Bạn có chắc chắn muốn tiếp tục?'
        )
        if (!confirmClear) return
      }

      document.body.removeChild(modal)
      await this.performRestore(backupData, clearExisting)
    }

    cancelBtn.onclick = () => {
      document.body.removeChild(modal)
      this.updateFileStatus('❌ Đã hủy khôi phục dữ liệu', 'info')
    }

    // Close modal when clicking outside
    modal.onclick = (e) => {
      if (e.target === modal) {
        document.body.removeChild(modal)
        this.updateFileStatus('❌ Đã hủy khôi phục dữ liệu', 'info')
      }
    }
  }

  async performRestore(backupData, clearExisting) {
    try {
      this.updateFileStatus('🔄 Đang khôi phục dữ liệu...', 'info')

      const response = await this.makeAuthenticatedRequest(`${this.apiBase}/restore-data`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          backupData,
          clearExisting
        })
      })

      const data = await response.json()

      if (response.ok) {
        // Reload all data after restore
        await Promise.all([
          this.loadPlayers(),
          this.loadSeasons(),
          this.loadMatches(),
          this.loadPlayDates()
        ])

        this.renderPlayers()
        this.renderSeasons()
        this.renderRankings()
        this.renderMatchHistory()
        this.updatePlayerSelects()
        this.updateDateSelector()
        this.updateSeasonSelector()

        let statusMessage = '✅ Đã khôi phục dữ liệu thành công!'
        statusMessage += `\n📊 Kết quả: ${data.results.playersImported} người chơi, ${data.results.seasonsImported} mùa giải, ${data.results.matchesImported} trận đấu`
        
        if (data.results.errors && data.results.errors.length > 0) {
          statusMessage += `\n⚠️ ${data.results.errors.length} lỗi nhỏ (có thể do dữ liệu trùng lặp)`
        }

        this.updateFileStatus(statusMessage, 'success')
      } else {
        this.updateFileStatus(`❌ ${data.error || 'Lỗi khi khôi phục dữ liệu'}`, 'error')
      }
    } catch (error) {
      console.error('Error restoring data:', error)
      this.updateFileStatus('❌ Lỗi kết nối khi khôi phục dữ liệu', 'error')
    }
  }

  async editMatch(matchId) {
    if (!this.isAuthenticated) {
      this.updateFileStatus('❌ Cần đăng nhập để sửa trận đấu', 'error')
      return
    }

    const match = this.matches.find(m => m.id === matchId)
    if (!match) {
      this.updateFileStatus('❌ Không tìm thấy trận đấu', 'error')
      return
    }

    this.showMatchEditModal(match)
  }

  async deleteMatch(matchId) {
    if (!this.isAuthenticated) {
      this.updateFileStatus('❌ Cần đăng nhập để xóa trận đấu', 'error')
      return
    }

    const match = this.matches.find(m => m.id === matchId)
    if (!match) {
      this.updateFileStatus('❌ Không tìm thấy trận đấu', 'error')
      return
    }

    const confirmDelete = confirm(
      `Bạn có chắc chắn muốn xóa trận đấu này?\n\n` +
      `📅 ${this.formatDate(match.play_date)}\n` +
      `👥 ${match.player1_name} & ${match.player2_name} vs ${match.player3_name} & ${match.player4_name}\n` +
      `📊 ${match.team1_score} - ${match.team2_score}\n\n` +
      `Hành động này không thể hoàn tác.`
    )

    if (!confirmDelete) return

    try {
      const response = await this.makeAuthenticatedRequest(`${this.apiBase}/matches/${matchId}`, {
        method: 'DELETE'
      })

      const data = await response.json()
      
      if (response.ok) {
        await this.loadMatches()
        await this.loadPlayDates()
        this.renderRankings()
        this.renderMatchHistory()
        this.updateDateSelector()
        this.updateFileStatus('✅ Đã xóa trận đấu thành công', 'success')
      } else {
        this.updateFileStatus(`❌ ${data.error}`, 'error')
      }
    } catch (error) {
      console.error('Error deleting match:', error)
      this.updateFileStatus('❌ Lỗi kết nối khi xóa trận đấu', 'error')
    }
  }

  showMatchEditModal(match) {
    const modal = document.createElement('div')
    modal.className = 'modal'
    modal.innerHTML = `
      <div class="modal-content">
        <h2>Sửa trận đấu</h2>
        <form id="editMatchForm">
          <div class="form-group">
            <label for="editMatchDate">Ngày đánh:</label>
            <input type="date" id="editMatchDate" value="${match.play_date.split('T')[0]}" required>
          </div>
          
          <div class="form-group">
            <label for="editSeasonId">Mùa giải:</label>
            <select id="editSeasonId" required>
              ${this.seasons.map(season => 
                `<option value="${season.id}" ${season.id === match.season_id ? 'selected' : ''}>${season.name}</option>`
              ).join('')}
            </select>
          </div>

          <div class="teams">
            <div class="team-section">
              <h3>Đội 1</h3>
              <div class="form-group">
                <label for="editPlayer1">Người chơi 1:</label>
                <select id="editPlayer1" required>
                  ${this.players.map(player => 
                    `<option value="${player.id}" ${player.id === match.player1_id ? 'selected' : ''}>${player.name}</option>`
                  ).join('')}
                </select>
              </div>
              <div class="form-group">
                <label for="editPlayer2">Người chơi 2:</label>
                <select id="editPlayer2" required>
                  ${this.players.map(player => 
                    `<option value="${player.id}" ${player.id === match.player2_id ? 'selected' : ''}>${player.name}</option>`
                  ).join('')}
                </select>
              </div>
              <div class="form-group">
                <label for="editTeam1Score">Tỷ số đội 1:</label>
                <input type="number" id="editTeam1Score" value="${match.team1_score}" min="0" required>
              </div>
            </div>

            <div class="team-section">
              <h3>Đội 2</h3>
              <div class="form-group">
                <label for="editPlayer3">Người chơi 3:</label>
                <select id="editPlayer3" required>
                  ${this.players.map(player => 
                    `<option value="${player.id}" ${player.id === match.player3_id ? 'selected' : ''}>${player.name}</option>`
                  ).join('')}
                </select>
              </div>
              <div class="form-group">
                <label for="editPlayer4">Người chơi 4:</label>
                <select id="editPlayer4" required>
                  ${this.players.map(player => 
                    `<option value="${player.id}" ${player.id === match.player4_id ? 'selected' : ''}>${player.name}</option>`
                  ).join('')}
                </select>
              </div>
              <div class="form-group">
                <label for="editTeam2Score">Tỷ số đội 2:</label>
                <input type="number" id="editTeam2Score" value="${match.team2_score}" min="0" required>
              </div>
            </div>
          </div>

          <div class="form-group">
            <label for="editWinningTeam">Đội thắng:</label>
            <select id="editWinningTeam" required>
              <option value="1" ${match.winning_team === 1 ? 'selected' : ''}>Đội 1</option>
              <option value="2" ${match.winning_team === 2 ? 'selected' : ''}>Đội 2</option>
            </select>
          </div>

          <div class="form-actions">
            <button type="submit">Cập nhật trận đấu</button>
            <button type="button" id="cancelEditMatch">Hủy</button>
          </div>
        </form>
        <div id="editMatchError" class="error-message"></div>
      </div>
    `
    
    document.body.appendChild(modal)
    
    document.getElementById('editMatchForm').addEventListener('submit', async (e) => {
      e.preventDefault()
      
      const seasonId = parseInt(document.getElementById('editSeasonId').value)
      const playDate = document.getElementById('editMatchDate').value
      const player1Id = parseInt(document.getElementById('editPlayer1').value)
      const player2Id = parseInt(document.getElementById('editPlayer2').value)
      const player3Id = parseInt(document.getElementById('editPlayer3').value)
      const player4Id = parseInt(document.getElementById('editPlayer4').value)
      const team1Score = parseInt(document.getElementById('editTeam1Score').value)
      const team2Score = parseInt(document.getElementById('editTeam2Score').value)
      const winningTeam = parseInt(document.getElementById('editWinningTeam').value)
      const errorDiv = document.getElementById('editMatchError')
      
      // Validation
      if (!playDate || !seasonId || !player1Id || !player2Id || !player3Id || !player4Id || 
          isNaN(team1Score) || isNaN(team2Score) || !winningTeam) {
        errorDiv.textContent = 'Vui lòng điền đầy đủ thông tin'
        return
      }

      const playerIds = [player1Id, player2Id, player3Id, player4Id]
      const uniquePlayerIds = [...new Set(playerIds)]
      if (uniquePlayerIds.length !== 4) {
        errorDiv.textContent = 'Cần 4 người chơi khác nhau'
        return
      }

      if (team1Score < 0 || team2Score < 0) {
        errorDiv.textContent = 'Tỷ số phải là số không âm'
        return
      }

      try {
        const response = await this.makeAuthenticatedRequest(`${this.apiBase}/matches/${match.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            seasonId,
            playDate,
            player1Id,
            player2Id,
            player3Id,
            player4Id,
            team1Score,
            team2Score,
            winningTeam
          })
        })

        const data = await response.json()
        
        if (response.ok) {
          document.body.removeChild(modal)
          await this.loadMatches()
          await this.loadPlayDates()
          this.renderRankings()
          this.renderMatchHistory()
          this.updateDateSelector()
          this.updateFileStatus('✅ Đã cập nhật trận đấu thành công', 'success')
        } else {
          errorDiv.textContent = data.error
        }
      } catch (error) {
        console.error('Error updating match:', error)
        errorDiv.textContent = 'Lỗi kết nối khi cập nhật trận đấu'
      }
    })
    
    document.getElementById('cancelEditMatch').addEventListener('click', () => {
      document.body.removeChild(modal)
    })
    
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        document.body.removeChild(modal)
      }
    })
  }

  // Auto-winner detection based on scores
  updateAutoWinner() {
    if (this.isManualWinnerMode) return // Don't auto-update if in manual mode

    const team1ScoreInput = document.getElementById('team1Score')
    const team2ScoreInput = document.getElementById('team2Score')
    const winnerDisplay = document.getElementById('winnerDisplay')
    const winningTeamSelect = document.getElementById('winningTeam')

    if (!team1ScoreInput || !team2ScoreInput || !winnerDisplay) return

    const team1Score = parseInt(team1ScoreInput.value) || 0
    const team2Score = parseInt(team2ScoreInput.value) || 0

    // Only auto-select winner if scores are different and at least one is > 0
    if (team1Score !== team2Score && (team1Score > 0 || team2Score > 0)) {
      const winningTeam = team1Score > team2Score ? 1 : 2
      
      // Update the hidden select value for form submission
      if (winningTeamSelect) {
        winningTeamSelect.value = winningTeam
      }
      
      // Update the display text
      winnerDisplay.textContent = `🏆 Đội ${winningTeam} thắng (${team1Score > team2Score ? team1Score + ' - ' + team2Score : team2Score + ' - ' + team1Score})`
      winnerDisplay.className = 'winner-display-auto'
      
      // Store the current winning team
      this.currentWinningTeam = winningTeam
    } else if (team1Score === team2Score && team1Score > 0) {
      // Handle tie case
      winnerDisplay.textContent = `⚖️ Hòa (${team1Score} - ${team2Score}). Vui lòng chọn thủ công.`
      winnerDisplay.className = 'winner-display-manual'
      if (winningTeamSelect) {
        winningTeamSelect.value = ''
      }
      this.currentWinningTeam = null
    } else {
      // No scores or both are 0
      winnerDisplay.textContent = 'Nhập điểm số để tự động xác định đội thắng'
      winnerDisplay.className = 'winner-display-no-winner'
      if (winningTeamSelect) {
        winningTeamSelect.value = ''
      }
      this.currentWinningTeam = null
    }
  }

  // Show match modal for quick match entry
  showMatchModal() {
    // For now, just switch to the matches tab
    this.switchTab('matches')
    
    // Scroll to the match form
    const matchForm = document.querySelector('#matches-tab .match-form')
    if (matchForm) {
      matchForm.scrollIntoView({ behavior: 'smooth' })
    }
  }

  // Toggle between auto and manual winner selection mode
  toggleWinnerMode(isManual) {
    this.isManualWinnerMode = isManual
    
    const autoWinnerDiv = document.querySelector('.auto-winner')
    const manualWinnerDiv = document.querySelector('.manual-winner')
    const useManualWinnerBtn = document.getElementById('useManualWinner')
    const useAutoWinnerBtn = document.getElementById('useAutoWinner')
    const winningTeamSelect = document.getElementById('winningTeam')

    if (isManual) {
      // Switch to manual mode
      if (autoWinnerDiv) autoWinnerDiv.classList.add('hidden')
      if (manualWinnerDiv) {
        manualWinnerDiv.classList.remove('hidden')
        manualWinnerDiv.classList.add('flex')
      }
      if (useManualWinnerBtn) useManualWinnerBtn.classList.add('hidden')
      if (useAutoWinnerBtn) {
        useAutoWinnerBtn.classList.remove('hidden')
        useAutoWinnerBtn.classList.add('inline-block')
      }
    } else {
      // Switch to auto mode
      if (autoWinnerDiv) autoWinnerDiv.classList.remove('hidden')
      if (manualWinnerDiv) manualWinnerDiv.classList.add('hidden')
      if (useManualWinnerBtn) {
        useManualWinnerBtn.classList.remove('hidden')
        useManualWinnerBtn.classList.add('inline-block')
      }
      if (useAutoWinnerBtn) useAutoWinnerBtn.classList.add('hidden')
      
      // Reset manual winner selection
      if (winningTeamSelect) winningTeamSelect.value = ''
      
      // Update winner based on current scores
      this.updateAutoWinner()
    }
  }

  // ...existing code...
}

// Initialize the application
const app = new TennisRankingSystem()

// Expose app to global scope for event handlers
window.app = app
