import './style.css'

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
    this.currentMatchType = 'duo' // 'duo' (đánh đôi) or 'solo' (đánh đơn)
    this.currentSeasonPlayers = [] // Players eligible for current selected season
    this.eventHandlers = [] // Track event listeners for cleanup
    
    // Smart client-side cache with type-specific TTLs
    this.cache = {
      rankings: new Map(),   // Key: 'daily:date' | 'season:id' | 'lifetime'
      matches: new Map(),    // Key: 'all' | 'date:date' | 'season:id'
      players: null,
      seasons: null,
      playDates: null,
      lastFetch: new Map(),  // Track when each cache entry was fetched
      serverVersion: null    // Server data version for cache invalidation
    }
    
    // Different TTLs for different data types (in ms)
    this.CACHE_TTL = {
      rankings: 2 * 60 * 1000,      // 2 min - changes when matches recorded
      matches: 1 * 60 * 1000,       // 1 min - changes frequently
      players: 10 * 60 * 1000,      // 10 min - rarely changes
      seasons: 10 * 60 * 1000,      // 10 min - rarely changes
      playDates: 5 * 60 * 1000,     // 5 min - changes with new matches
      versionCheck: 30 * 1000       // 30 sec - check server version
    }
    
    // Start version polling for cache coherence
    this.startVersionPolling()
    
    this.init()
  }

  // Poll server for data version changes (ensures cache coherence across clients)
  startVersionPolling() {
    // Check immediately on start
    this.checkServerVersion()
    
    // Then poll every 30 seconds
    this.versionPollInterval = setInterval(() => {
      this.checkServerVersion()
    }, this.CACHE_TTL.versionCheck)
  }

  // Stop version polling (call on cleanup)
  stopVersionPolling() {
    if (this.versionPollInterval) {
      clearInterval(this.versionPollInterval)
      this.versionPollInterval = null
    }
  }

  // Check if server data version has changed
  async checkServerVersion() {
    if (!this.serverMode) return
    
    try {
      const response = await fetch(`${this.apiBase}/data-version`, {
        credentials: 'include'
      })
      
      if (response.ok) {
        const data = await response.json()
        const newVersion = data.version
        
        // If version changed, invalidate all client cache
        if (this.cache.serverVersion !== null && this.cache.serverVersion !== newVersion) {
          console.log(`🔄 Server data changed (${this.cache.serverVersion} → ${newVersion}), clearing cache`)
          this.invalidateCache() // Full clear
        }
        
        this.cache.serverVersion = newVersion
      }
    } catch (error) {
      // Silently ignore - server might be unavailable
      console.log('⚠️ Version check failed, using local cache')
    }
  }

  // Smart cache: check if cached data is still valid
  isCacheValid(cacheKey, type = 'rankings') {
    const lastFetch = this.cache.lastFetch.get(cacheKey)
    if (!lastFetch) return false
    
    const ttl = this.CACHE_TTL[type] || this.CACHE_TTL.rankings
    return (Date.now() - lastFetch) < ttl
  }

  // Smart cache: set data with timestamp
  setCache(type, key, data) {
    const cacheKey = key ? `${type}:${key}` : type
    
    if (type === 'rankings' || type === 'matches') {
      this.cache[type].set(key, data)
    } else {
      this.cache[type] = data
    }
    
    this.cache.lastFetch.set(cacheKey, Date.now())
    console.log(`💾 Cache SET: ${cacheKey}`)
  }

  // Smart cache: get data if valid
  getCache(type, key = null) {
    const cacheKey = key ? `${type}:${key}` : type
    
    if (!this.isCacheValid(cacheKey, type)) {
      console.log(`❌ Cache MISS: ${cacheKey}`)
      return null
    }
    
    let data = null
    if (type === 'rankings' || type === 'matches') {
      data = this.cache[type].get(key)
    } else {
      data = this.cache[type]
    }
    
    if (data) {
      console.log(`✅ Cache HIT: ${cacheKey}`)
    }
    return data
  }

  // Smart cache invalidation - only clear what changed
  invalidateCache(types = []) {
    if (!types || types.length === 0) {
      // Full clear (for restore/logout)
      this.cache.rankings.clear()
      this.cache.matches.clear()
      this.cache.lastFetch.clear()
      this.cache.players = null
      this.cache.seasons = null
      this.cache.playDates = null
      console.log('🗑️ Full cache cleared')
      return
    }
    
    // Selective invalidation
    types.forEach(type => {
      switch(type) {
        case 'rankings':
          this.cache.rankings.clear()
          for (const key of this.cache.lastFetch.keys()) {
            if (key.startsWith('rankings:')) {
              this.cache.lastFetch.delete(key)
            }
          }
          console.log('🗑️ Rankings cache cleared')
          break
          
        case 'matches':
          this.cache.matches.clear()
          this.cache.playDates = null
          for (const key of this.cache.lastFetch.keys()) {
            if (key.startsWith('matches:') || key === 'playDates') {
              this.cache.lastFetch.delete(key)
            }
          }
          console.log('🗑️ Matches cache cleared')
          break
          
        case 'players':
          this.cache.players = null
          this.cache.lastFetch.delete('players')
          console.log('🗑️ Players cache cleared')
          break
          
        case 'seasons':
          this.cache.seasons = null
          this.cache.lastFetch.delete('seasons')
          console.log('🗑️ Seasons cache cleared')
          break
          
        case 'playDates':
          this.cache.playDates = null
          this.cache.lastFetch.delete('playDates')
          console.log('🗑️ PlayDates cache cleared')
          break
      }
    })
  }

  // Legacy method for compatibility
  clearCache() {
    this.invalidateCache()
  }

  // Event listener management for proper cleanup
  addTrackedEventListener(element, event, handler, options) {
    if (!element) return
    element.addEventListener(event, handler, options)
    this.eventHandlers.push({ element, event, handler, options })
  }

  removeAllTrackedEventListeners() {
    this.eventHandlers.forEach(({ element, event, handler, options }) => {
      if (element) {
        element.removeEventListener(event, handler, options)
      }
    })
    this.eventHandlers = []
  }

  // Security: HTML escape to prevent XSS attacks
  escapeHtml(unsafe) {
    if (unsafe === null || unsafe === undefined) return ''
    return String(unsafe)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  // Loading overlay control
  showLoader(message = 'Đang tải...') {
    const overlay = document.getElementById('loadingOverlay')
    if (overlay) {
      const messageEl = overlay.querySelector('p')
      if (messageEl) messageEl.textContent = message
      overlay.classList.add('show')
    }
  }

  hideLoader() {
    const overlay = document.getElementById('loadingOverlay')
    if (overlay) {
      overlay.classList.remove('show')
    }
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
    const userRole = this.user?.role || null
    
    // Update body class for CSS targeting
    if (this.isAuthenticated) {
      document.body.classList.add('authenticated')
    } else {
      document.body.classList.remove('authenticated')
    }
    
    // Update user info display
    const userName = document.querySelector('.user-name')
    const userRoleBadge = document.querySelector('.user-role.badge')
    if (userName && this.user) {
      userName.textContent = this.user.displayName || this.user.username
    }
    if (userRoleBadge && this.user) {
      userRoleBadge.textContent = this.user.role === 'admin' ? 'Admin' : (this.user.role === 'editor' ? 'Editor' : 'Viewer')
    }
    
    // Handle general edit elements (for any authenticated user with edit rights)
    const editElements = document.querySelectorAll('.edit-only')
    editElements.forEach(element => {
      if (this.isAuthenticated && (userRole === 'admin' || userRole === 'editor')) {
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
    
    // Handle guest info elements
    const guestInfoElements = document.querySelectorAll('.guest-info')
    guestInfoElements.forEach(element => {
      if (this.isAuthenticated && (userRole === 'admin' || userRole === 'editor')) {
        element.classList.add('hidden')
      } else {
        element.classList.remove('hidden')
      }
    })
    
    // Handle logged-in/logged-out visibility
    document.querySelectorAll('.logged-in-only').forEach(el => {
      el.style.display = this.isAuthenticated ? '' : 'none'
    })
    document.querySelectorAll('.logged-out-only').forEach(el => {
      el.style.display = this.isAuthenticated ? 'none' : ''
    })
    
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
    
    // SSRF Protection: Validate URL is targeting our own API only
    const allowedOrigin = window.location.origin
    const parsedUrl = new URL(url, allowedOrigin)
    if (parsedUrl.origin !== allowedOrigin) {
      throw new Error('Invalid request URL: external URLs not allowed')
    }
    if (!parsedUrl.pathname.includes('/api/')) {
      throw new Error('Invalid request URL: must target API endpoint')
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
          <span class="user-name">👤 ${this.escapeHtml(this.user.username)}</span>
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
      // Check cache first (10 min TTL for players)
      const cached = this.getCache('players')
      if (cached) {
        this.players = cached
        return
      }
      
      const response = await fetch(`${this.apiBase}/players`)
      if (response.ok) {
        this.players = await response.json()
        this.setCache('players', null, this.players)
      }
    } catch (error) {
      console.error('Error loading players:', error)
    }
  }

  async loadSeasons() {
    try {
      // Check cache first (10 min TTL for seasons)
      const cached = this.getCache('seasons')
      if (cached) {
        this.seasons = cached
        this.updateSeasonSelect()
        return
      }
      
      const response = await fetch(`${this.apiBase}/seasons`)
      if (response.ok) {
        this.seasons = await response.json()
        this.setCache('seasons', null, this.seasons)
        this.updateSeasonSelect()
      }
    } catch (error) {
      console.error('Error loading seasons:', error)
    }
  }

  async loadPlayDates() {
    try {
      // Check cache first (5 min TTL for playDates)
      const cached = this.getCache('playDates')
      if (cached) {
        this.playDates = cached
        return
      }
      
      const response = await fetch(`${this.apiBase}/play-dates`)
      if (response.ok) {
        this.playDates = await response.json()
        this.setCache('playDates', null, this.playDates)
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
      // Tab switching (new nav-btn class)
      document.querySelectorAll('.nav-btn').forEach(button => {
        button.addEventListener('click', (e) => {
          const tab = e.currentTarget.dataset.tab
          if (tab) this.switchTab(tab)
        })
      })
      
      // View mode switching (new view-btn class)
      document.querySelectorAll('.view-btn').forEach(button => {
        button.addEventListener('click', (e) => {
          const view = e.currentTarget.dataset.view
          if (view) this.switchViewMode(view)
        })
      })
      
      // Match type toggle (new type-btn class)
      document.querySelectorAll('.type-btn').forEach(button => {
        button.addEventListener('click', (e) => {
          const type = e.currentTarget.dataset.type
          if (type) this.switchMatchType(type)
        })
      })
      
      // Match form submission
      const matchForm = document.getElementById('matchForm')
      if (matchForm) {
        matchForm.addEventListener('submit', async (e) => {
          e.preventDefault()
          await this.recordMatch()
        })
      }
      
      // Reset match form
      const resetFormBtn = document.getElementById('resetFormBtn')
      if (resetFormBtn) {
        resetFormBtn.addEventListener('click', () => this.resetMatchForm())
      }
      
      // Login button
      const loginBtn = document.getElementById('loginBtn')
      if (loginBtn) {
        loginBtn.addEventListener('click', () => this.showLoginModal())
      }
      
      // Logout button
      const logoutBtn = document.getElementById('logoutBtn')
      if (logoutBtn) {
        logoutBtn.addEventListener('click', () => this.logout())
      }
      
      // Create season button
      const createSeasonBtn = document.getElementById('createSeasonBtn')
      if (createSeasonBtn) {
        createSeasonBtn.addEventListener('click', () => this.showSeasonModal())
      }
      
      // Create account button
      const createAccountBtn = document.getElementById('createAccountBtn')
      if (createAccountBtn) {
        createAccountBtn.addEventListener('click', () => this.showAccountModal())
      }
      
      // Today button
      const todayBtn = document.getElementById('todayBtn')
      if (todayBtn) {
        todayBtn.addEventListener('click', () => {
          const today = new Date().toISOString().split('T')[0]
          const dateSelect = document.getElementById('rankingDateSelect')
          if (dateSelect) {
            // Check if today is in the list
            const hasToday = Array.from(dateSelect.options).some(opt => opt.value === today)
            if (hasToday) {
              dateSelect.value = today
            } else {
              // If today is not in the list, add it as a temporary option
              const tempOption = document.createElement('option')
              tempOption.value = today
              tempOption.textContent = this.formatDate(today)
              dateSelect.insertBefore(tempOption, dateSelect.options[1])
              dateSelect.value = today
            }
          }
          this.selectedDate = today
          this.renderRankings()
          this.renderMatchHistory()
        })
      }
      
      // Export Excel button (daily view)
      const exportExcelBtn = document.getElementById('exportExcelBtn')
      if (exportExcelBtn) {
        exportExcelBtn.addEventListener('click', () => this.exportToExcel('daily'))
      }
      
      // Export Excel button (season view)
      const exportSeasonBtn = document.getElementById('exportSeasonBtn')
      if (exportSeasonBtn) {
        exportSeasonBtn.addEventListener('click', () => this.exportToExcel('season'))
      }
      
      // Export Excel button (lifetime view)
      const exportLifetimeBtn = document.getElementById('exportLifetimeBtn')
      if (exportLifetimeBtn) {
        exportLifetimeBtn.addEventListener('click', () => this.exportToExcel('lifetime'))
      }
      
      // Ranking date picker (dropdown)
      const rankingDateSelect = document.getElementById('rankingDateSelect')
      if (rankingDateSelect) {
        rankingDateSelect.addEventListener('change', (e) => {
          this.selectedDate = e.target.value
          if (this.currentViewMode === 'daily') {
            this.renderRankings()
            this.renderMatchHistory()
          }
        })
      }
      
      // Season select
      const seasonSelect = document.getElementById('seasonSelect')
      if (seasonSelect) {
        seasonSelect.addEventListener('change', (e) => {
          this.selectedSeason = parseInt(e.target.value)
          if (this.currentViewMode === 'season') {
            this.renderRankings()
            this.renderMatchHistory()
          }
        })
      }
      
      // Match history date filter
      const matchHistoryDate = document.getElementById('matchHistoryDate')
      if (matchHistoryDate) {
        matchHistoryDate.addEventListener('change', () => this.renderMatchHistory())
      }
      
      // Modal close buttons
      document.querySelectorAll('[data-dismiss="modal"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const modal = e.target.closest('.modal')
          if (modal) this.hideModal(modal.id)
        })
      })
      
      // Modal backdrop click to close
      document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
        backdrop.addEventListener('click', (e) => {
          const modal = e.target.closest('.modal')
          if (modal) this.hideModal(modal.id)
        })
      })
      
      // Login form submission
      const loginForm = document.getElementById('loginForm')
      if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
          e.preventDefault()
          const username = document.getElementById('loginUsername').value
          const password = document.getElementById('loginPassword').value
          const result = await this.login(username, password)
          if (result.success) {
            this.hideModal('loginModal')
            this.showToast('Đăng nhập thành công!', 'success')
          } else {
            this.showToast(result.message, 'error')
          }
        })
      }
      
      // Season form submission
      const seasonForm = document.getElementById('seasonForm')
      if (seasonForm) {
        seasonForm.addEventListener('submit', async (e) => {
          e.preventDefault()
          await this.saveSeason()
        })
      }
      
      // Account form submission
      const accountForm = document.getElementById('accountForm')
      if (accountForm) {
        accountForm.addEventListener('submit', async (e) => {
          e.preventDefault()
          await this.saveAccount()
        })
      }
      
      // Auto-winner detection for score inputs
      const scoreInputs = ['team1Score', 'team2Score']
      scoreInputs.forEach(id => {
        const input = document.getElementById(id)
        if (input) {
          input.addEventListener('input', () => this.updateAutoWinner())
        }
      })
      
      // Winner select change
      const winnerSelect = document.getElementById('winner')
      if (winnerSelect) {
        winnerSelect.addEventListener('change', (e) => {
          this.currentWinningTeam = e.target.value === 'team1' ? 1 : (e.target.value === 'team2' ? 2 : null)
        })
      }

      // Add player
      const addPlayerBtn = document.getElementById('addPlayer')
      if (addPlayerBtn) {
        addPlayerBtn.addEventListener('click', async () => {
          await this.addPlayer()
        })
      }

      // Player name inputs - both old and new
      const playerNameInput = document.getElementById('playerName')
      if (playerNameInput) {
        playerNameInput.addEventListener('keypress', async (e) => {
          if (e.key === 'Enter') {
            await this.addPlayer()
          }
        })
      }
      
      const newPlayerNameInput = document.getElementById('newPlayerName')
      if (newPlayerNameInput) {
        newPlayerNameInput.addEventListener('keypress', async (e) => {
          if (e.key === 'Enter') {
            await this.addPlayer()
          }
        })
      }

      // Delete player buttons (using event delegation for both .delete-btn and .delete-player-btn)
      document.addEventListener('click', async (e) => {
        const deleteBtn = e.target.closest('.delete-btn, .delete-player-btn')
        if (deleteBtn && deleteBtn.dataset.playerId) {
          const playerId = parseInt(deleteBtn.dataset.playerId)
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

      // Export rankings (uses current view mode)
      const exportBtn = document.getElementById('exportRankings')
      if (exportBtn) {
        exportBtn.addEventListener('click', () => {
          this.exportToExcel(this.currentViewMode)
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
      
      // Backup JSON button (full database backup)
      const backupJsonBtn = document.getElementById('backupJsonBtn')
      if (backupJsonBtn) {
        backupJsonBtn.addEventListener('click', () => this.backupToJson())
      }
      
      // Restore JSON button (full database restore)
      const restoreJsonBtn = document.getElementById('restoreJsonBtn')
      const restoreJsonInput = document.getElementById('restoreJsonInput')
      if (restoreJsonBtn && restoreJsonInput) {
        restoreJsonBtn.addEventListener('click', () => restoreJsonInput.click())
        restoreJsonInput.addEventListener('change', (e) => this.restoreFromJson(e))
      }
      
      // Backup Excel button (in accounts tab - exports lifetime data)
      const backupExcelBtn = document.getElementById('backupExcelBtn')
      if (backupExcelBtn) {
        backupExcelBtn.addEventListener('click', () => this.exportToExcel('lifetime'))
      }
      
      // Match season selector
      const matchSeasonSelect = document.getElementById('matchSeasonSelect')
      if (matchSeasonSelect) {
        matchSeasonSelect.addEventListener('change', async (e) => {
          const seasonId = parseInt(e.target.value)
          await this.onMatchSeasonChange(seasonId)
          // Update labels for solo mode
          this.updateTeamLabelsForMatchType()
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

      // Match type toggle (Đánh đơn / Đánh đôi)
      const matchTypeDuoBtn = document.getElementById('matchTypeDuo')
      const matchTypeSoloBtn = document.getElementById('matchTypeSolo')
      if (matchTypeDuoBtn && matchTypeSoloBtn) {
        matchTypeDuoBtn.addEventListener('click', () => this.switchMatchType('duo'))
        matchTypeSoloBtn.addEventListener('click', () => this.switchMatchType('solo'))
      }

    } catch (error) {
      console.error('Error setting up event listeners:', error)
    }
  }

  // Match type toggle handler
  switchMatchType(type) {
    this.currentMatchType = type
    
    // Update hidden input
    const matchTypeInput = document.getElementById('matchType')
    if (matchTypeInput) matchTypeInput.value = type
    
    // Update button states (new UI)
    document.querySelectorAll('.type-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.type === type)
    })
    
    // Update team labels based on match type
    this.updateTeamLabelsForMatchType()
    
    // Show/hide elements based on match type
    if (type === 'solo') {
      // Hide duo-only elements (player 2 and player 4 selects)
      document.querySelectorAll('.duo-only').forEach(el => el.style.display = 'none')
    } else {
      // Show duo-only elements
      document.querySelectorAll('.duo-only').forEach(el => el.style.display = '')
    }
    
    // Reset winner selection
    const winnerSelect = document.getElementById('winner')
    if (winnerSelect) winnerSelect.value = ''
    this.currentWinningTeam = null
  }
  
  // Update team labels based on match type (solo = 1v1, duo = 2v2)
  updateTeamLabelsForMatchType() {
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

  // Handle season selection change in match form
  async onMatchSeasonChange(seasonId) {
    const duoPlayerSelects = ['player1', 'player2', 'player3', 'player4']
    const soloPlayerSelects = ['soloPlayer1', 'soloPlayer2']
    const allPlayerSelects = [...duoPlayerSelects, ...soloPlayerSelects]
    
    if (!seasonId) {
      // No season selected - disable player selects
      allPlayerSelects.forEach(id => {
        const select = document.getElementById(id)
        if (select) {
          select.disabled = true
          select.innerHTML = '<option value="">Chọn mùa giải trước...</option>'
        }
      })
      // Hide season info
      const seasonInfoEl = document.getElementById('selectedSeasonInfo')
      if (seasonInfoEl) seasonInfoEl.style.display = 'none'
      return
    }
    
    try {
      // Fetch players eligible for this season
      const response = await fetch(`${this.apiBase}/seasons/${seasonId}/players`)
      let seasonPlayers = []
      
      if (response.ok) {
        seasonPlayers = await response.json()
      }
      
      // If no players assigned to season, use all players (backward compatibility)
      if (seasonPlayers.length === 0) {
        seasonPlayers = this.players
      }
      
      // Update player selects with filtered players
      const playerOptions = seasonPlayers.map(player => 
        `<option value="${player.id}">${this.escapeHtml(player.name)}</option>`
      ).join('')
      
      allPlayerSelects.forEach(id => {
        const select = document.getElementById(id)
        if (select) {
          select.disabled = false
          select.innerHTML = `<option value="">Chọn người chơi...</option>${playerOptions}`
        }
      })
      
      // Store season players for reference
      this.currentSeasonPlayers = seasonPlayers
      this.selectedMatchSeason = seasonId
      this.seasonPlayers = seasonPlayers
      
      // Show season info
      const selectedSeason = this.seasons.find(s => s.id == seasonId)
      if (selectedSeason) {
        const seasonInfoEl = document.getElementById('selectedSeasonInfo')
        if (seasonInfoEl) {
          const playerCount = seasonPlayers.length !== this.players.length 
            ? `${seasonPlayers.length} người chơi được phép` 
            : 'Tất cả người chơi'
          const loseMoneyAmount = selectedSeason.lose_money_per_loss || 20000
          seasonInfoEl.innerHTML = `
            <div class="season-info-badge">
              <span class="badge-item">💰 ${this.formatMoney(loseMoneyAmount)}/trận thua</span>
              <span class="badge-item">👥 ${playerCount}</span>
            </div>
          `
          seasonInfoEl.style.display = 'block'
        }
      }
      
    } catch (error) {
      console.error('Error loading season players:', error)
      // Fallback to all players
      this.updatePlayerSelects()
    }
  }

  switchTab(tabName) {
    // First hide all view mode sections
    this.hideAllViewModeSections()
    
    // Update nav buttons (new class)
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'))
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'))

    const tabBtn = document.querySelector(`.nav-btn[data-tab="${tabName}"]`)
    const tabContent = document.getElementById(`${tabName}-tab`)
    
    if (tabBtn) tabBtn.classList.add('active')
    if (tabContent) tabContent.classList.add('active')

    if (tabName === 'rankings') {
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
    } else if (tabName === 'accounts') {
      this.renderAccounts()
    }
  }

  async switchViewMode(mode) {
    this.currentViewMode = mode
    
    // Update view buttons (new class)
    document.querySelectorAll('.view-btn').forEach(btn => btn.classList.remove('active'))
    const activeBtn = document.querySelector(`.view-btn[data-view="${mode}"]`)
    if (activeBtn) activeBtn.classList.add('active')
    
    // Show/hide view sections
    document.querySelectorAll('.view-section').forEach(section => section.classList.remove('active'))
    const activeView = document.getElementById(`${mode}-view`)
    if (activeView) activeView.classList.add('active')
    
    // Set default selections if needed
    if (mode === 'daily' && !this.selectedDate && this.playDates.length > 0) {
      this.selectedDate = this.playDates[0].play_date.split('T')[0]
      const rankingDateSelect = document.getElementById('rankingDateSelect')
      if (rankingDateSelect) rankingDateSelect.value = this.selectedDate
    }
    
    if (mode === 'season' && !this.selectedSeason) {
      const activeSeason = this.seasons.find(s => s.is_active)
      if (activeSeason) {
        this.selectedSeason = activeSeason.id
        const seasonSelect = document.getElementById('seasonSelect')
        if (seasonSelect) seasonSelect.value = this.selectedSeason
      }
    }
    
    await this.renderRankings()
    await this.renderMatchHistory()
  }

  setupViewModeUI() {
    try {
      // Update view buttons
      document.querySelectorAll('.view-btn').forEach(btn => btn.classList.remove('active'))
      const activeBtn = document.querySelector(`.view-btn[data-view="${this.currentViewMode}"]`)
      if (activeBtn) activeBtn.classList.add('active')
      
      // Show/hide view sections
      document.querySelectorAll('.view-section').forEach(section => section.classList.remove('active'))
      const activeView = document.getElementById(`${this.currentViewMode}-view`)
      if (activeView) activeView.classList.add('active')
    } catch (error) {
      console.error('Error setting up view mode UI:', error)
    }
  }

  async addPlayer() {
    // Support both old input (playerName) and new input (newPlayerName)
    const oldInput = document.getElementById('playerName')
    const newInput = document.getElementById('newPlayerName')
    const inputElement = (newInput && newInput.value.trim()) ? newInput : oldInput
    
    const playerName = inputElement?.value?.trim()
    if (!playerName) {
      this.showToast('Vui lòng nhập tên người chơi', 'error')
      return
    }

    if (!this.isAuthenticated) {
      this.showToast('Cần đăng nhập để thêm người chơi', 'error')
      return
    }

    try {
      const response = await this.makeAuthenticatedRequest(`${this.apiBase}/players`, {
        method: 'POST',
        body: JSON.stringify({ name: playerName })
      })

      const data = await response.json()
      
      if (response.ok) {
        this.invalidateCache(['players']) // Only players changed
        await this.loadPlayers()
        this.renderPlayers()
        this.updatePlayerSelects()
        // Clear both inputs
        if (oldInput) oldInput.value = ''
        if (newInput) newInput.value = ''
        this.showToast(`Đã thêm người chơi: ${playerName}`, 'success')
      } else {
        this.showToast(data.error, 'error')
      }
    } catch (error) {
      console.error('Error adding player:', error)
      this.showToast('Lỗi khi thêm người chơi', 'error')
    }
  }

  async removePlayer(playerId) {
    if (!this.isAuthenticated) {
      this.showToast('Cần đăng nhập để xóa người chơi', 'error')
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
        this.invalidateCache(['players', 'rankings', 'matches']) // Player deletion affects all
        await this.loadPlayers()
        await this.loadMatches()
        this.renderPlayers()
        this.renderRankings()
        this.renderMatchHistory()
        this.updatePlayerSelects()
        this.showToast(`Đã xóa người chơi: ${player.name}`, 'success')
      } else {
        const data = await response.json()
        this.showToast(data.error, 'error')
      }
    } catch (error) {
      console.error('Error removing player:', error)
      this.showToast('Lỗi khi xóa người chơi', 'error')
    }
  }
  
  // Alias for table button onclick
  async deletePlayer(playerId, playerName) {
    await this.removePlayer(playerId)
  }

  async recordMatch() {
    if (!this.isAuthenticated) {
      this.showToast('Cần đăng nhập để ghi nhận kết quả', 'error')
      return
    }

    const playDate = document.getElementById('matchDate')?.value
    const matchType = this.currentMatchType || 'duo'
    
    // Get selected season
    const seasonId = parseInt(document.getElementById('matchSeasonSelect')?.value)
    if (!seasonId) {
      this.showToast('Vui lòng chọn mùa giải', 'error')
      return
    }
    
    // Get lose money from selected season
    const selectedSeason = this.seasons.find(s => s.id === seasonId)
    const loseMoney = selectedSeason?.lose_money_per_loss || 20000
    const winMoney = loseMoney  // Win = Lose in this system
    
    let player1Id, player2Id, player3Id, player4Id, team1Score, team2Score
    
    // Get scores - same inputs for both duo and solo modes
    team1Score = parseInt(document.getElementById('team1Score')?.value) || 0
    team2Score = parseInt(document.getElementById('team2Score')?.value) || 0
    
    if (matchType === 'solo') {
      // Solo mode - player1 vs player3 (opponents)
      player1Id = parseInt(document.getElementById('player1')?.value)
      player2Id = null  // No partner in solo mode
      player3Id = parseInt(document.getElementById('player3')?.value)
      player4Id = null  // No partner in solo mode
    } else {
      // Duo mode - all 4 players
      player1Id = parseInt(document.getElementById('player1')?.value)
      player2Id = parseInt(document.getElementById('player2')?.value)
      player3Id = parseInt(document.getElementById('player3')?.value)
      player4Id = parseInt(document.getElementById('player4')?.value)
    }
    
    // Get winner from select
    const winnerValue = document.getElementById('winner')?.value
    let winningTeam = winnerValue === 'team1' ? 1 : (winnerValue === 'team2' ? 2 : null)

    // Validation
    if (!playDate) {
      this.showToast('Vui lòng chọn ngày đánh', 'error')
      return
    }

    // Validate players based on match type
    if (matchType === 'solo') {
      if (isNaN(player1Id) || isNaN(player3Id)) {
        this.showToast('Vui lòng chọn đủ 2 người chơi', 'error')
        return
      }
      if (player1Id === player3Id) {
        this.showToast('Cần 2 người chơi khác nhau', 'error')
        return
      }
    } else {
      const playerIds = [player1Id, player2Id, player3Id, player4Id]
      if (playerIds.some(id => isNaN(id))) {
        this.showToast('Vui lòng chọn đủ 4 người chơi', 'error')
        return
      }

      const uniquePlayerIds = [...new Set(playerIds)]
      if (uniquePlayerIds.length !== 4) {
        this.showToast('Cần 4 người chơi khác nhau', 'error')
        return
      }
    }

    if (team1Score < 0 || team2Score < 0) {
      this.showToast('Vui lòng nhập tỷ số hợp lệ', 'error')
      return
    }

    // Use auto-selected winner if available
    if (!winningTeam && this.currentWinningTeam) {
      winningTeam = this.currentWinningTeam
    }

    if (winningTeam !== 1 && winningTeam !== 2) {
      this.showToast('Vui lòng chọn đội thắng', 'error')
      return
    }

    try {
      const response = await this.makeAuthenticatedRequest(`${this.apiBase}/matches`, {
        method: 'POST',
        body: JSON.stringify({
          seasonId,
          playDate,
          player1Id,
          player2Id,
          player3Id,
          player4Id,
          team1Score,
          team2Score,
          winningTeam,
          matchType,
          winMoney,
          loseMoney
        })
      })

      const data = await response.json()
      
      if (response.ok) {
        this.invalidateCache(['rankings', 'matches', 'playDates']) // Only match-related data
        await this.loadMatches()
        await this.loadPlayDates()
        
        // Reset form
        this.resetMatchForm()
        
        // Update displays
        this.renderRankings()
        this.renderMatchHistory()
        this.updateDateSelector()
        
        this.showToast('Đã ghi nhận kết quả trận đấu', 'success')
      } else {
        this.showToast(data.error || 'Lỗi khi ghi nhận kết quả', 'error')
      }
    } catch (error) {
      console.error('Error recording match:', error)
      this.showToast('Lỗi khi ghi nhận kết quả', 'error')
    }
  }

  renderPlayers() {
    try {
      const userRole = this.user?.role
      const canDelete = userRole === 'admin'
      
      // Render old style player list (if container exists)
      const container = document.getElementById('playersList')
      if (container) {
        container.innerHTML = this.players.map(player => `
          <div class="player-card">
            <span class="player-name">${this.escapeHtml(player.name)}</span>
            ${canDelete ? `
              <button class="delete-btn" data-player-id="${player.id}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
              </button>
            ` : ''}
          </div>
        `).join('')
      }
      
      // Render Players tab table
      const tableBody = document.getElementById('playersTableBody')
      if (tableBody) {
        tableBody.innerHTML = this.players.map(player => `
          <tr>
            <td><span class="id-badge">#${player.id}</span></td>
            <td>
              <div class="player-cell">
                <span class="player-avatar-small">${this.escapeHtml(player.name.charAt(0).toUpperCase())}</span>
                <span class="player-name-text">${this.escapeHtml(player.name)}</span>
              </div>
            </td>
            <td>${player.created_at ? this.formatDate(player.created_at) : '-'}</td>
            ${canDelete ? `
              <td>
                <button class="btn btn-sm btn-danger delete-player-btn" data-player-id="${player.id}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                  </svg>
                  Xóa
                </button>
              </td>
            ` : ''}
          </tr>
        `).join('')
        
        // Event listeners handled by event delegation in setupEventListeners
      }
      
      // Update player count badge
      const countBadge = document.getElementById('playerCount')
      if (countBadge) {
        countBadge.textContent = `${this.players.length} người chơi`
      }
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
      const activeSeasons = this.seasons.filter(s => s.is_active)
      const endedSeasons = this.seasons.filter(s => !s.is_active)
      
      let html = ''
      
      // Active seasons section
      if (activeSeasons.length > 0) {
        html += `<div class="seasons-section">
          <h3 class="season-heading-active">✅ Mùa giải đang hoạt động (${activeSeasons.length})</h3>
          ${activeSeasons.length > 1 ? `<div class="info-message info-message-compact">ℹ️ Hiện có ${activeSeasons.length} mùa giải đang hoạt động cùng lúc</div>` : ''}
          <div class="seasons-grid">`
        
        activeSeasons.forEach(season => {
          const hasEndDate = season.end_date && season.end_date !== 'null' && season.end_date !== ''
          const endDateDisplay = hasEndDate 
            ? this.formatDate(season.end_date)
            : '<span class="season-text-muted">Không có ngày kết thúc</span>'
          const autoEndInfo = season.auto_end && hasEndDate ? ` <span class="season-auto-end">(Tự động kết thúc)</span>` : ''
          const descriptionInfo = season.description ? `<p class="season-description">📝 ${season.description}</p>` : ''
          const loseMoneyInfo = `<p>💰 Tiền thua: ${this.formatMoney(season.lose_money_per_loss || 20000)}/trận</p>`
          
          html += `
            <div class="season-card active-season">
              <div class="season-header">
                <h4>${season.name}</h4>
                <span class="season-status active">Đang hoạt động</span>
              </div>
              <div class="season-info">
                <p>📅 Từ: ${this.formatDate(season.start_date)}</p>
                <p>🏁 Đến: ${endDateDisplay}${autoEndInfo}</p>
                ${loseMoneyInfo}
                ${descriptionInfo}
                ${!hasEndDate ? `<p class="info-warning">⚠️ Cần kết thúc thủ công</p>` : ''}
              </div>
              ${userRole === 'admin' || userRole === 'editor' ? `
                <div class="season-actions">
                  <button data-action="end-season" data-id="${season.id}" class="btn btn-sm btn-secondary">🏁 Kết thúc</button>
                  <button data-action="edit-season" data-id="${season.id}" class="btn btn-sm btn-ghost">✏️ Sửa</button>
                  <button data-action="delete-season" data-id="${season.id}" class="btn btn-sm btn-danger">🗑️ Xóa</button>
                </div>
              ` : ''}
            </div>`
        })
        
        html += `</div></div>`
      }
      
      // Ended seasons section
      if (endedSeasons.length > 0) {
        html += `<div class="seasons-section seasons-section--spaced">
          <h3 class="season-heading-ended">⏸️ Mùa giải đã kết thúc (${endedSeasons.length})</h3>
          <div class="seasons-grid">`
        
        endedSeasons.forEach(season => {
          const hasEndDate = season.end_date && season.end_date !== 'null' && season.end_date !== ''
          const endDateDisplay = hasEndDate 
            ? this.formatDate(season.end_date)
            : '<span class="season-text-muted">Không có ngày kết thúc</span>'
          const descriptionInfo = season.description ? `<p class="season-description">📝 ${season.description}</p>` : ''
          const endedAtInfo = season.ended_at ? `<p>⏰ Kết thúc lúc: ${new Date(season.ended_at).toLocaleString('vi-VN')}</p>` : ''
          const endedByInfo = season.ended_by ? `<p>👤 Kết thúc bởi: ${season.ended_by}</p>` : ''
          const loseMoneyInfo = `<p>💰 Tiền thua: ${this.formatMoney(season.lose_money_per_loss || 20000)}/trận</p>`
          
          html += `
            <div class="season-card ended-season">
              <div class="season-header">
                <h4>${season.name}</h4>
                <span class="season-status ended">Đã kết thúc</span>
              </div>
              <div class="season-info">
                <p>📅 Từ: ${this.formatDate(season.start_date)}</p>
                <p>🏁 Đến: ${endDateDisplay}</p>
                ${loseMoneyInfo}
                ${endedAtInfo}
                ${endedByInfo}
                ${descriptionInfo}
              </div>
              ${userRole === 'admin' || userRole === 'editor' ? `
                <div class="season-actions">
                  <button data-action="reactivate-season" data-id="${season.id}" class="btn btn-sm btn-primary">✅ Kích hoạt lại</button>
                  <button data-action="delete-season" data-id="${season.id}" class="btn btn-sm btn-danger">🗑️ Xóa</button>
                </div>
              ` : ''}
            </div>`
        })
        
        html += `</div></div>`
      }
      
      // Empty state
      if (this.seasons.length === 0) {
        html = `<div class="empty-state"><p>📋 Chưa có mùa giải nào. Tạo mùa giải đầu tiên để bắt đầu!</p></div>`
      }
      
      container.innerHTML = html

      // Add event listeners for season actions
      if (userRole === 'admin' || userRole === 'editor') {
        container.querySelectorAll('[data-action]').forEach(button => {
          button.addEventListener('click', (e) => {
            const action = e.target.dataset.action
            const seasonId = parseInt(e.target.dataset.id)
            
            if (action === 'end-season') {
              this.endSeason(seasonId)
            } else if (action === 'reactivate-season') {
              this.reactivateSeason(seasonId)
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
      let cacheKey = ''
      let apiUrl = ''
      
      if (this.currentViewMode === 'daily' && this.selectedDate) {
        cacheKey = `daily:${this.selectedDate}`
        apiUrl = `${this.apiBase}/rankings/date/${this.selectedDate}`
      } else if (this.currentViewMode === 'season' && this.selectedSeason) {
        cacheKey = `season:${this.selectedSeason}`
        apiUrl = `${this.apiBase}/rankings/season/${this.selectedSeason}`
      } else if (this.currentViewMode === 'lifetime') {
        cacheKey = 'lifetime'
        apiUrl = `${this.apiBase}/rankings/lifetime`
      }
      
      if (cacheKey) {
        // Use smart cache with type-specific TTL
        rankings = this.getCache('rankings', cacheKey)
        if (!rankings && apiUrl) {
          const response = await fetch(apiUrl)
          if (response.ok) {
            rankings = await response.json()
            this.setCache('rankings', cacheKey, rankings)
          }
        }
      }
      rankings = rankings || []
    } catch (error) {
      console.error('Error loading rankings:', error)
      rankings = []
    }

    // Determine which table to use based on view mode
    let tableId = 'dailyRankingTable'
    if (this.currentViewMode === 'season') tableId = 'seasonRankingTable'
    else if (this.currentViewMode === 'lifetime') tableId = 'lifetimeRankingTable'
    
    const container = document.getElementById(tableId)
    if (!container) return

    const tbody = container.querySelector('tbody')
    if (!tbody) return
    
    tbody.innerHTML = rankings.length === 0 
      ? '<tr><td colspan="9" style="text-align: center; padding: 2rem; color: var(--text-muted);">Không có dữ liệu</td></tr>'
      : rankings.map((player, index) => {
        const balanceClass = player.money_balance > 0 ? 'positive' : (player.money_balance < 0 ? 'negative' : '')
        const balanceValue = player.money_balance || (player.money_won || 0) - (player.money_lost || 0)
        const formHtml = this.renderForm(player.form || player.recent_form || [])
        const points = player.points || 0
        const pointsClass = points > 0 ? 'positive' : (points < 0 ? 'negative' : '')
        return `
          <tr>
            <td class="col-rank">${this.getRankEmoji(index + 1)}${index + 1}</td>
            <td class="col-name">${this.escapeHtml(player.name)}</td>
            <td class="col-form"><div class="form-dots">${formHtml || '-'}</div></td>
            <td>${player.total_matches || 0}</td>
            <td>${player.wins || 0}</td>
            <td>${player.losses || 0}</td>
            <td>${player.win_percentage || 0}%</td>
            <td class="col-points ${pointsClass}">${points}</td>
            <td class="col-balance ${balanceClass}">${this.formatMoney(balanceValue)}</td>
          </tr>
        `
      }).join('')
  }
  
  getRankEmoji(rank) {
    if (rank === 1) return '🥇 '
    if (rank === 2) return '🥈 '
    if (rank === 3) return '🥉 '
    return ''
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
      // Check for filter date
      const matchHistoryDate = document.getElementById('matchHistoryDate')?.value
      let cacheKey = ''
      let apiUrl = ''
      
      if (matchHistoryDate) {
        cacheKey = `date:${matchHistoryDate}`
        apiUrl = `${this.apiBase}/matches/by-date/${matchHistoryDate}`
      } else if (this.currentViewMode === 'daily' && this.selectedDate) {
        cacheKey = `date:${this.selectedDate}`
        apiUrl = `${this.apiBase}/matches/by-date/${this.selectedDate}`
      } else if (this.currentViewMode === 'season' && this.selectedSeason) {
        cacheKey = `season:${this.selectedSeason}`
        apiUrl = `${this.apiBase}/matches/by-season/${this.selectedSeason}`
      } else {
        cacheKey = 'all'
        apiUrl = `${this.apiBase}/matches`
      }
      
      // Check cache first
      matches = this.getCache('matches', cacheKey)
      if (!matches && apiUrl) {
        const response = await fetch(apiUrl)
        if (response.ok) {
          matches = await response.json()
          this.setCache('matches', cacheKey, matches)
        }
      }
      matches = matches || []
    } catch (error) {
      console.error('Error loading matches:', error)
    }

    const container = document.querySelector('#matchHistoryTable tbody')
    if (!container) return

    const userRole = this.user?.role
    const canEdit = userRole === 'admin' || userRole === 'editor'
    
    container.innerHTML = matches.length === 0 
      ? `<tr><td colspan="${canEdit ? 6 : 5}" style="text-align: center; padding: 2rem; color: var(--text-muted);">Không có trận đấu nào</td></tr>`
      : matches.map(match => {
        const isSolo = match.match_type === 'solo'
        
        let team1Players, team2Players
        if (isSolo) {
          team1Players = match.player1_name
          team2Players = match.player3_name
        } else {
          team1Players = `${match.player1_name} & ${match.player2_name}`
          team2Players = `${match.player3_name} & ${match.player4_name}`
        }
        
        const team1Class = match.winning_team === 1 ? 'winner-cell' : ''
        const team2Class = match.winning_team === 2 ? 'winner-cell' : ''
        const matchMoney = match.lose_money_per_loss ?? 0
        const winnerBadge = `<svg class="winner-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg>`
        
        return `
          <tr>
            <td>${this.formatDate(match.play_date)}</td>
            <td class="${team1Class}">${this.escapeHtml(team1Players)} ${match.winning_team === 1 ? winnerBadge : ''}</td>
            <td style="text-align: center; font-weight: 600;">${match.team1_score} - ${match.team2_score}</td>
            <td class="${team2Class}">${this.escapeHtml(team2Players)} ${match.winning_team === 2 ? winnerBadge : ''}</td>
            <td>${this.formatMoney(matchMoney)}</td>
            ${canEdit ? `
              <td>
                <div class="action-btns">
                  <button class="btn btn-sm btn-icon edit-match-btn" data-match-id="${match.id}" title="Sửa">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                  </button>
                  <button class="btn btn-sm btn-icon btn-danger delete-match-btn" data-match-id="${match.id}" title="Xóa">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                  </button>
                </div>
              </td>
            ` : ''}
          </tr>
        `
      }).join('')
    
    // Add event listeners for edit/delete buttons
    if (container) {
      container.querySelectorAll('.edit-match-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const matchId = parseInt(btn.dataset.matchId)
          this.editMatch(matchId)
        })
      })
      container.querySelectorAll('.delete-match-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const matchId = parseInt(btn.dataset.matchId)
          this.deleteMatch(matchId)
        })
      })
    }
  }

  updatePlayerSelects() {
    try {
      // Filter players by selected season if a season is selected
      let availablePlayers = this.players
      
      if (this.selectedMatchSeason && this.seasonPlayers.length > 0) {
        // Only show players who are allowed in this season
        const allowedPlayerIds = this.seasonPlayers.map(p => p.player_id || p.id)
        availablePlayers = this.players.filter(player => 
          allowedPlayerIds.includes(player.id)
        )
      }
      
      const playerOptions = availablePlayers.map(player => 
        `<option value="${player.id}">${this.escapeHtml(player.name)}</option>`
      ).join('')

      // For duo mode
      const duoSelects = ['player1', 'player2', 'player3', 'player4']
      duoSelects.forEach(selectId => {
        const select = document.getElementById(selectId)
        if (select) {
          const currentValue = select.value
          select.innerHTML = `<option value="">Chọn người chơi...</option>${playerOptions}`
          // Restore previous selection if still valid
          if (currentValue && availablePlayers.some(p => p.id == currentValue)) {
            select.value = currentValue
          }
        }
      })
      
      // For solo mode
      const soloSelects = ['soloPlayer1', 'soloPlayer2']
      soloSelects.forEach(selectId => {
        const select = document.getElementById(selectId)
        if (select) {
          const currentValue = select.value
          select.innerHTML = `<option value="">Chọn người chơi...</option>${playerOptions}`
          // Restore previous selection if still valid
          if (currentValue && availablePlayers.some(p => p.id == currentValue)) {
            select.value = currentValue
          }
        }
      })
    } catch (error) {
      console.error('Error updating player selects:', error)
    }
  }

  updateSeasonSelect() {
    try {
      const matchSeasonSelect = document.getElementById('matchSeasonSelect')
      if (!matchSeasonSelect) return

      // Get only active seasons
      const activeSeasons = this.seasons.filter(s => s.is_active)
      
      const seasonOptions = activeSeasons.map(season => {
        const endDateStr = season.end_date ? ` (Kết thúc: ${this.formatDate(season.end_date)})` : ''
        const loseMoneyStr = season.lose_money_per_loss ? ` - ${this.formatMoney(season.lose_money_per_loss)}/thua` : ''
        return `<option value="${season.id}">${this.escapeHtml(season.name)}${endDateStr}${loseMoneyStr}</option>`
      }).join('')

      matchSeasonSelect.innerHTML = `<option value="">-- Chọn mùa giải trước --</option>${seasonOptions}`
      
      // Auto-select if only one active season
      if (activeSeasons.length === 1) {
        matchSeasonSelect.value = activeSeasons[0].id
        // Trigger the season change to load players
        this.onMatchSeasonChange(activeSeasons[0].id)
      }
    } catch (error) {
      console.error('Error updating season select:', error)
    }
  }

  async handleMatchSeasonChange(seasonId) {
    this.selectedMatchSeason = seasonId ? parseInt(seasonId) : null
    
    const playerSelectionArea = document.getElementById('playerSelectionArea')
    
    if (!seasonId) {
      // No season selected - hide player selection
      this.seasonPlayers = []
      if (playerSelectionArea) {
        playerSelectionArea.style.display = 'none'
      }
      return
    }
    
    // Fetch players allowed in this season
    try {
      const response = await fetch(`${this.apiBase}/seasons/${seasonId}/players`)
      if (response.ok) {
        this.seasonPlayers = await response.json()
      } else {
        // If no specific players, allow all players
        this.seasonPlayers = []
      }
    } catch (error) {
      console.error('Error loading season players:', error)
      this.seasonPlayers = []
    }
    
    // Show player selection area
    if (playerSelectionArea) {
      playerSelectionArea.style.display = 'block'
    }
    
    // Update player dropdowns with filtered list
    this.updatePlayerSelects()
    
    // Also update the season info display
    const selectedSeason = this.seasons.find(s => s.id == seasonId)
    if (selectedSeason) {
      const seasonInfoEl = document.getElementById('selectedSeasonInfo')
      if (seasonInfoEl) {
        const playerCount = this.seasonPlayers.length > 0 
          ? `${this.seasonPlayers.length} người chơi được phép` 
          : 'Tất cả người chơi'
        seasonInfoEl.innerHTML = `
          <div class="season-info-badge">
            <span>💰 ${this.formatMoney(selectedSeason.lose_money_per_loss || 20000)}/trận thua</span>
            <span>👥 ${playerCount}</span>
          </div>
        `
        seasonInfoEl.style.display = 'block'
      }
    }
  }

  updateDateSelector() {
    const selector = document.getElementById('rankingDateSelect')
    if (!selector) return

    // Keep the placeholder option and add dates
    const placeholder = '<option value="">-- Chọn ngày --</option>'
    selector.innerHTML = placeholder + this.playDates.map(dateObj => {
      // Convert to date-only format (YYYY-MM-DD) to avoid timezone issues
      const dateOnly = dateObj.play_date.split('T')[0]
      return `<option value="${dateOnly}">${this.formatDate(dateObj.play_date)}</option>`
    }).join('')

    if (this.selectedDate) {
      // Also ensure selectedDate is in date-only format
      const selectedDateOnly = this.selectedDate.split('T')[0]
      selector.value = selectedDateOnly
    }
    
    // Also update match history date selector
    this.updateMatchHistoryDateSelector()
  }
  
  updateMatchHistoryDateSelector() {
    const selector = document.getElementById('matchHistoryDate')
    if (!selector) return
    
    const placeholder = '<option value="">Tất cả ngày</option>'
    selector.innerHTML = placeholder + this.playDates.map(dateObj => {
      const dateOnly = dateObj.play_date.split('T')[0]
      return `<option value="${dateOnly}">${this.formatDate(dateObj.play_date)}</option>`
    }).join('')
  }

  updateSeasonSelector() {
    const selector = document.getElementById('seasonSelect')
    if (!selector) return

    selector.innerHTML = this.seasons.map(season => 
      `<option value="${season.id}">${this.escapeHtml(season.name)}${season.is_active ? ' (Đang hoạt động)' : ''}</option>`
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
    
    // Update modal title
    const titleEl = document.getElementById('seasonModalTitle')
    if (titleEl) {
      titleEl.textContent = isEdit ? 'Chỉnh Sửa Mùa Giải' : 'Tạo Mùa Giải Mới'
    }
    
    // Build player checkboxes
    const checkboxContainer = document.getElementById('seasonPlayersCheckboxes')
    if (checkboxContainer) {
      checkboxContainer.innerHTML = this.players.map(player => `
        <label class="player-checkbox">
          <input type="checkbox" name="seasonPlayers" value="${player.id}" data-player-name="${this.escapeHtml(player.name)}">
          <span>${this.escapeHtml(player.name)}</span>
        </label>
      `).join('')
    }
    
    // Set form values
    document.getElementById('seasonId').value = seasonId || ''
    document.getElementById('seasonName').value = season ? season.name : ''
    document.getElementById('seasonLoseMoney').value = season ? (season.lose_money_per_loss || 20000) : 20000
    document.getElementById('seasonStartDate').value = season ? season.start_date : ''
    document.getElementById('seasonEndDate').value = season ? (season.end_date || '') : ''
    document.getElementById('seasonDescription').value = season ? (season.description || '') : ''
    document.getElementById('seasonAutoEnd').checked = season ? season.auto_end : false
    
    // Clear error
    const errorDiv = document.getElementById('seasonError')
    if (errorDiv) errorDiv.textContent = ''
    
    // Update submit button text
    const submitBtn = document.getElementById('seasonSubmitBtn')
    if (submitBtn) {
      submitBtn.textContent = isEdit ? 'Cập nhật' : 'Tạo mùa giải'
    }
    
    // If editing, load season players
    if (isEdit) {
      this.loadSeasonPlayersForEdit(seasonId)
    }
    
    // Setup select/deselect all buttons
    const selectAllBtn = document.getElementById('selectAllPlayers')
    const deselectAllBtn = document.getElementById('deselectAllPlayers')
    
    if (selectAllBtn) {
      selectAllBtn.onclick = () => {
        document.querySelectorAll('input[name="seasonPlayers"]').forEach(cb => cb.checked = true)
      }
    }
    
    if (deselectAllBtn) {
      deselectAllBtn.onclick = () => {
        document.querySelectorAll('input[name="seasonPlayers"]').forEach(cb => cb.checked = false)
      }
    }
    
    // Setup form submission
    const form = document.getElementById('seasonForm')
    if (form) {
      // Remove old listener and add new one
      const newForm = form.cloneNode(true)
      form.parentNode.replaceChild(newForm, form)
      
      // Re-bind checkbox listeners after form clone
      const newSelectAll = document.getElementById('selectAllPlayers')
      const newDeselectAll = document.getElementById('deselectAllPlayers')
      if (newSelectAll) {
        newSelectAll.onclick = () => {
          document.querySelectorAll('input[name="seasonPlayers"]').forEach(cb => cb.checked = true)
        }
      }
      if (newDeselectAll) {
        newDeselectAll.onclick = () => {
          document.querySelectorAll('input[name="seasonPlayers"]').forEach(cb => cb.checked = false)
        }
      }
      
      newForm.addEventListener('submit', async (e) => {
        e.preventDefault()
        await this.handleSeasonFormSubmit(isEdit, seasonId)
      })
    }
    
    // Show the modal
    this.showModal('seasonModal')
  }
  
  async handleSeasonFormSubmit(isEdit, seasonId) {
    const name = document.getElementById('seasonName').value.trim()
    const description = document.getElementById('seasonDescription').value.trim()
    const startDate = document.getElementById('seasonStartDate').value
    const endDate = document.getElementById('seasonEndDate').value || null
    const autoEnd = document.getElementById('seasonAutoEnd').checked
    const loseMoneyPerLoss = parseInt(document.getElementById('seasonLoseMoney').value) || 20000
    const errorDiv = document.getElementById('seasonError')
    
    // Get selected players
    const selectedPlayers = Array.from(document.querySelectorAll('input[name="seasonPlayers"]:checked'))
      .map(cb => parseInt(cb.value))
    
    if (!name || !startDate) {
      if (errorDiv) errorDiv.textContent = 'Vui lòng điền đầy đủ thông tin'
      return
    }
    
    // Validate end date is after start date
    if (endDate && endDate <= startDate) {
      if (errorDiv) errorDiv.textContent = 'Ngày kết thúc phải sau ngày bắt đầu'
      return
    }
    
    // Auto-end requires end date
    if (autoEnd && !endDate) {
      if (errorDiv) errorDiv.textContent = 'Cần chọn ngày kết thúc để bật tự động kết thúc'
      return
    }
    
    const result = isEdit ? 
      await this.updateSeason(seasonId, name, description, startDate, endDate, autoEnd, loseMoneyPerLoss, selectedPlayers) :
      await this.createSeason(name, description, startDate, endDate, autoEnd, loseMoneyPerLoss, selectedPlayers)
    
    if (result.success) {
      this.hideModal('seasonModal')
      this.showToast(result.message, 'success')
    } else {
      if (errorDiv) errorDiv.textContent = result.message
    }
  }

  async loadSeasonPlayersForEdit(seasonId) {
    try {
      const response = await fetch(`${this.apiBase}/seasons/${seasonId}/players`)
      if (response.ok) {
        const seasonPlayers = await response.json()
        const seasonPlayerIds = seasonPlayers.map(p => p.id)
        
        // Check the checkboxes for players in this season
        document.querySelectorAll('input[name="seasonPlayers"]').forEach(cb => {
          cb.checked = seasonPlayerIds.includes(parseInt(cb.value))
        })
      }
    } catch (error) {
      console.error('Error loading season players for edit:', error)
    }
  }

  async createSeason(name, description, startDate, endDate, autoEnd, loseMoneyPerLoss = 20000, playerIds = []) {
    try {
      const response = await this.makeAuthenticatedRequest(`${this.apiBase}/seasons`, {
        method: 'POST',
        body: JSON.stringify({ 
          name, 
          description,
          startDate,
          endDate,
          autoEnd,
          loseMoneyPerLoss,
          playerIds
        })
      })

      const data = await response.json()
      
      if (response.ok) {
        this.invalidateCache(['seasons', 'rankings']) // Season changes affect rankings
        await this.loadSeasons()
        this.renderSeasons()
        this.updateSeasonSelector()
        return { success: true, message: 'Đã tạo mùa giải mới thành công' }
      } else {
        return { success: false, message: data.error }
      }
    } catch (error) {
      console.error('Error creating season:', error)
      return { success: false, message: 'Lỗi khi tạo mùa giải' }
    }
  }

  async updateSeason(seasonId, name, description, startDate, endDate, autoEnd, loseMoneyPerLoss = null, playerIds = null) {
    try {
      // Update season details
      const response = await this.makeAuthenticatedRequest(`${this.apiBase}/seasons/${seasonId}`, {
        method: 'PUT',
        body: JSON.stringify({ name, description, startDate, endDate, autoEnd, loseMoneyPerLoss })
      })

      const data = await response.json()
      
      if (!response.ok) {
        return { success: false, message: data.error }
      }
      
      // Update season players if provided
      if (playerIds !== null) {
        const playersResponse = await this.makeAuthenticatedRequest(`${this.apiBase}/seasons/${seasonId}/players`, {
          method: 'POST',
          body: JSON.stringify({ playerIds })
        })
        
        if (!playersResponse.ok) {
          const playersData = await playersResponse.json()
          return { success: false, message: playersData.error || 'Lỗi khi cập nhật người chơi' }
        }
      }
      
      this.invalidateCache(['seasons', 'rankings']) // Season update affects rankings
      await this.loadSeasons()
      this.renderSeasons()
      this.updateSeasonSelector()
      return { success: true, message: 'Đã cập nhật mùa giải thành công' }
    } catch (error) {
      console.error('Error updating season:', error)
      return { success: false, message: 'Lỗi khi cập nhật mùa giải' }
    }
  }

  async endSeason(seasonId) {
    if (!this.isAuthenticated) {
      this.updateFileStatus('❌ Cần đăng nhập để kết thúc mùa giải', 'error')
      return
    }

    const season = this.seasons.find(s => s.id === seasonId)
    if (!season) {
      this.updateFileStatus('❌ Không tìm thấy mùa giải', 'error')
      return
    }

    const hasEndDate = season.end_date && season.end_date !== 'null' && season.end_date !== ''
    const confirmMessage = hasEndDate
      ? `Bạn có chắc chắn muốn kết thúc mùa giải "${season.name}"?\n\nNgày kết thúc: ${this.formatDate(season.end_date)}`
      : `Mùa giải "${season.name}" không có ngày kết thúc được đặt trước.\n\nBạn có chắc chắn muốn kết thúc mùa giải này ngay bây giờ?`

    if (!confirm(confirmMessage)) {
      return
    }

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
        this.updateSeasonSelector()
        this.updateFileStatus('✅ Đã kết thúc mùa giải', 'success')
      } else {
        this.updateFileStatus(`❌ ${data.error}`, 'error')
      }
    } catch (error) {
      console.error('Error ending season:', error)
      this.updateFileStatus('❌ Lỗi khi kết thúc mùa giải', 'error')
    }
  }

  async reactivateSeason(seasonId) {
    if (!this.isAuthenticated) {
      this.updateFileStatus('❌ Cần đăng nhập để kích hoạt lại mùa giải', 'error')
      return
    }

    const season = this.seasons.find(s => s.id === seasonId)
    if (!season) {
      this.updateFileStatus('❌ Không tìm thấy mùa giải', 'error')
      return
    }

    if (!confirm(`Bạn có chắc chắn muốn kích hoạt lại mùa giải "${season.name}"?`)) {
      return
    }

    try {
      const response = await this.makeAuthenticatedRequest(`${this.apiBase}/seasons/${seasonId}/reactivate`, {
        method: 'POST'
      })

      const data = await response.json()
      
      if (response.ok) {
        await this.loadSeasons()
        this.renderSeasons()
        this.updateSeasonSelector()
        this.updateFileStatus('✅ Đã kích hoạt lại mùa giải', 'success')
      } else {
        this.updateFileStatus(`❌ ${data.error}`, 'error')
      }
    } catch (error) {
      console.error('Error reactivating season:', error)
      this.updateFileStatus('❌ Lỗi khi kích hoạt lại mùa giải', 'error')
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
        // Invalidate all related caches
        this.invalidateCache(['seasons', 'rankings', 'matches', 'playDates'])
        
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

  async exportToExcel(explicitMode = null) {
    try {
      // Use explicit mode if provided, otherwise fall back to currentViewMode
      const mode = explicitMode || this.currentViewMode
      
      // Determine the export type based on mode
      let exportUrl = `${this.apiBase}/export-excel`
      let fileName = 'tennis-rankings'
      let statusSuffix = ''
      
      if (mode === 'daily') {
        if (!this.selectedDate) {
          this.showToast('Vui lòng chọn ngày để xuất Excel', 'error')
          return
        }
        exportUrl += `/date/${this.selectedDate}`
        fileName += `-${this.selectedDate}`
        statusSuffix = ` (theo ngày: ${this.formatDate(this.selectedDate)})`
      } else if (mode === 'season') {
        if (!this.selectedSeason) {
          this.showToast('Vui lòng chọn mùa giải để xuất Excel', 'error')
          return
        }
        exportUrl += `/season/${this.selectedSeason}`
        fileName += `-season-${this.selectedSeason}`
        const season = this.seasons.find(s => s.id === this.selectedSeason)
        statusSuffix = ` (theo mùa giải: ${season ? season.name : this.selectedSeason})`
      } else if (mode === 'lifetime') {
        exportUrl += '/lifetime'
        fileName += '-lifetime'
        statusSuffix = ' (toàn thời gian)'
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
        
        this.updateFileStatus(`✅ Đã xuất dữ liệu ra Excel thành công${statusSuffix}`, 'success')
      } else {
        this.updateFileStatus('❌ Lỗi khi xuất dữ liệu ra Excel', 'error')
      }
    } catch (error) {
      console.error('Error exporting to Excel:', error)
      this.updateFileStatus('❌ Lỗi khi xuất dữ liệu ra Excel', 'error')
    }
  }
  
  // Backup entire database to JSON
  async backupToJson() {
    try {
      this.showToast('Đang tạo bản sao lưu...', 'info')
      
      const response = await this.makeAuthenticatedRequest(`${this.apiBase}/backup`, {
        method: 'GET'
      })
      
      if (!response.ok) {
        const data = await response.json()
        this.showToast(data.error || 'Lỗi khi tạo bản sao lưu', 'error')
        return
      }
      
      const backupData = await response.json()
      
      // Create download
      const jsonStr = JSON.stringify(backupData, null, 2)
      const blob = new Blob([jsonStr], { type: 'application/json' })
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `tennis-backup-${new Date().toISOString().split('T')[0]}.json`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
      
      this.showToast('Đã tạo bản sao lưu thành công!', 'success')
    } catch (error) {
      console.error('Error creating backup:', error)
      this.showToast('Lỗi khi tạo bản sao lưu', 'error')
    }
  }
  
  // Restore database from JSON backup
  async restoreFromJson(event) {
    const file = event.target.files?.[0]
    if (!file) return
    
    // Reset file input
    event.target.value = ''
    
    // Warning confirmation
    const confirmRestore = confirm(
      '⚠️ CẢNH BÁO ⚠️\n\n' +
      'Khôi phục dữ liệu sẽ XÓA TẤT CẢ dữ liệu hiện tại và thay thế bằng dữ liệu từ file backup.\n\n' +
      'Bao gồm:\n' +
      '• Tất cả người chơi\n' +
      '• Tất cả trận đấu\n' +
      '• Tất cả mùa giải\n' +
      '• Tài khoản người dùng (nếu có trong backup)\n\n' +
      'Bạn có chắc chắn muốn tiếp tục?'
    )
    
    if (!confirmRestore) return
    
    // Second confirmation
    const confirmText = prompt(
      'Để xác nhận khôi phục, vui lòng gõ: RESTORE\n\n' +
      '(Gõ chính xác "RESTORE" để xác nhận)'
    )
    
    if (confirmText !== 'RESTORE') {
      this.showToast('Đã hủy khôi phục', 'info')
      return
    }
    
    try {
      this.showToast('Đang khôi phục dữ liệu...', 'info')
      
      // Read file content
      const reader = new FileReader()
      reader.onload = async (e) => {
        try {
          const backupData = JSON.parse(e.target.result)
          
          // Validate backup structure
          if (!backupData.players || !backupData.seasons || !backupData.matches) {
            this.showToast('File backup không hợp lệ - thiếu dữ liệu players, seasons hoặc matches', 'error')
            return
          }
          
          console.log(`📤 Sending restore request with ${backupData.players.length} players, ${backupData.seasons.length} seasons, ${backupData.matches.length} matches`)
          
          // Send to server
          const response = await this.makeAuthenticatedRequest(`${this.apiBase}/restore`, {
            method: 'POST',
            body: JSON.stringify(backupData)
          })
          
          // Check if response is OK before parsing JSON
          const contentType = response.headers.get('content-type')
          if (!contentType || !contentType.includes('application/json')) {
            const textResponse = await response.text()
            console.error('Server returned non-JSON response:', textResponse)
            this.showToast(`Lỗi server: ${response.status} ${response.statusText}`, 'error')
            return
          }
          
          const result = await response.json()
          
          if (response.ok) {
            this.showToast('Khôi phục dữ liệu thành công! Đang tải lại...', 'success')
            
            // Invalidate all client cache
            this.clearCache()
            
            // Reload all data
            await this.loadPlayers()
            await this.loadSeasons()
            await this.loadMatches()
            await this.loadPlayDates()
            
            // Update UI
            this.renderRankings()
            this.renderMatchHistory()
            this.renderSeasons()
            this.updatePlayerSelects()
            this.updateSeasonSelector()
            this.updateDateSelector()
            this.updateSeasonSelect()
          } else {
            console.error('Restore failed:', result)
            this.showToast(result.error || 'Lỗi khi khôi phục dữ liệu', 'error')
          }
        } catch (parseError) {
          console.error('Error in restore process:', parseError)
          if (parseError.message?.includes('JSON')) {
            this.showToast('Lỗi đọc file JSON - kiểm tra định dạng file', 'error')
          } else {
            this.showToast(`Lỗi: ${parseError.message}`, 'error')
          }
        }
      }
      
      reader.onerror = () => {
        console.error('FileReader error')
        this.showToast('Lỗi đọc file', 'error')
      }
      
      reader.readAsText(file)
    } catch (error) {
      console.error('Error restoring backup:', error)
      this.showToast('Lỗi khi khôi phục dữ liệu', 'error')
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
          <small class="inline-warning-note">
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
      this.showToast('Cần đăng nhập để sửa trận đấu', 'error')
      return
    }

    try {
      // Fetch fresh match data from server
      const response = await fetch(`${this.apiBase}/matches/${matchId}`, {
        credentials: 'include'
      })
      
      if (!response.ok) {
        this.showToast('Không tìm thấy trận đấu', 'error')
        return
      }
      
      const match = await response.json()
      this.showMatchEditModal(match)
    } catch (error) {
      console.error('Error fetching match:', error)
      this.showToast('Lỗi khi tải thông tin trận đấu', 'error')
    }
  }

  async deleteMatch(matchId) {
    if (!this.isAuthenticated) {
      this.showToast('Cần đăng nhập để xóa trận đấu', 'error')
      return
    }

    // Get match info for confirmation
    let matchInfo = this.matches.find(m => m.id === matchId)
    
    const confirmDelete = confirm(
      `Bạn có chắc chắn muốn xóa trận đấu này?\n\n` +
      (matchInfo ? 
        `📅 ${this.formatDate(matchInfo.play_date)}\n` +
        `👥 ${matchInfo.player1_name}${matchInfo.player2_name ? ' & ' + matchInfo.player2_name : ''} vs ${matchInfo.player3_name}${matchInfo.player4_name ? ' & ' + matchInfo.player4_name : ''}\n` +
        `📊 ${matchInfo.team1_score} - ${matchInfo.team2_score}\n\n` :
        ''
      ) +
      `Hành động này không thể hoàn tác.`
    )

    if (!confirmDelete) return

    try {
      const response = await this.makeAuthenticatedRequest(`${this.apiBase}/matches/${matchId}`, {
        method: 'DELETE'
      })

      const data = await response.json()
      
      if (response.ok) {
        this.invalidateCache(['rankings', 'matches', 'playDates']) // Only match-related data
        await this.loadMatches()
        await this.loadPlayDates()
        this.renderRankings()
        this.renderMatchHistory()
        this.updateDateSelector()
        this.showToast('Đã xóa trận đấu thành công', 'success')
      } else {
        this.showToast(data.error || 'Lỗi khi xóa trận đấu', 'error')
      }
    } catch (error) {
      console.error('Error deleting match:', error)
      this.showToast('Lỗi kết nối khi xóa trận đấu', 'error')
    }
  }

  showMatchEditModal(match) {
    const isSolo = match.match_type === 'solo'
    const modal = document.createElement('div')
    modal.className = 'modal'
    modal.innerHTML = `
      <div class="modal-backdrop"></div>
      <div class="modal-content modal-match-edit">
        <div class="modal-header">
          <h2 class="modal-title">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
            Sửa trận đấu ${isSolo ? '(1v1)' : '(Đôi)'}
          </h2>
          <button type="button" class="modal-close" id="closeEditModal">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <form id="editMatchForm" class="modal-body">
          <div class="form-row">
            <div class="form-group">
              <label for="editMatchDate">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                  <line x1="16" y1="2" x2="16" y2="6"/>
                  <line x1="8" y1="2" x2="8" y2="6"/>
                  <line x1="3" y1="10" x2="21" y2="10"/>
                </svg>
                Ngày đánh
              </label>
              <input type="date" id="editMatchDate" value="${match.play_date.split('T')[0]}" required>
            </div>
            <div class="form-group">
              <label for="editSeasonId">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
                  <line x1="4" y1="22" x2="4" y2="15"/>
                </svg>
                Mùa giải
              </label>
              <select id="editSeasonId" required>
                ${this.seasons.map(season => 
                  `<option value="${season.id}" ${season.id === match.season_id ? 'selected' : ''}>${season.name}</option>`
                ).join('')}
              </select>
            </div>
          </div>

          <div class="teams-grid">
            <div class="team-card team-1">
              <div class="team-header">
                <span class="team-badge">${isSolo ? 'Người chơi' : 'Đội 1'}</span>
              </div>
              <div class="form-group">
                <label for="editPlayer1">${isSolo ? 'Người chơi' : 'Người chơi 1'}</label>
                <select id="editPlayer1" required>
                  ${this.players.map(player => 
                    `<option value="${player.id}" ${player.id === match.player1_id ? 'selected' : ''}>${player.name}</option>`
                  ).join('')}
                </select>
              </div>
              ${!isSolo ? `
              <div class="form-group">
                <label for="editPlayer2">Người chơi 2</label>
                <select id="editPlayer2" required>
                  ${this.players.map(player => 
                    `<option value="${player.id}" ${player.id === match.player2_id ? 'selected' : ''}>${player.name}</option>`
                  ).join('')}
                </select>
              </div>
              ` : ''}
              <div class="form-group score-input">
                <label for="editTeam1Score">Tỷ số</label>
                <input type="number" id="editTeam1Score" value="${match.team1_score}" min="0" required class="score-field">
              </div>
            </div>

            <div class="vs-divider">
              <span>VS</span>
            </div>

            <div class="team-card team-2">
              <div class="team-header">
                <span class="team-badge">${isSolo ? 'Đối thủ' : 'Đội 2'}</span>
              </div>
              <div class="form-group">
                <label for="editPlayer3">${isSolo ? 'Người chơi' : 'Người chơi 3'}</label>
                <select id="editPlayer3" required>
                  ${this.players.map(player => 
                    `<option value="${player.id}" ${player.id === match.player3_id ? 'selected' : ''}>${player.name}</option>`
                  ).join('')}
                </select>
              </div>
              ${!isSolo ? `
              <div class="form-group">
                <label for="editPlayer4">Người chơi 4</label>
                <select id="editPlayer4" required>
                  ${this.players.map(player => 
                    `<option value="${player.id}" ${player.id === match.player4_id ? 'selected' : ''}>${player.name}</option>`
                  ).join('')}
                </select>
              </div>
              ` : ''}
              <div class="form-group score-input">
                <label for="editTeam2Score">Tỷ số</label>
                <input type="number" id="editTeam2Score" value="${match.team2_score}" min="0" required class="score-field">
              </div>
            </div>
          </div>

          <div class="form-group winner-select">
            <label for="editWinningTeam">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/>
                <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/>
                <path d="M4 22h16"/>
                <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/>
                <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/>
                <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>
              </svg>
              Đội thắng
            </label>
            <select id="editWinningTeam" required>
              <option value="1" ${match.winning_team === 1 ? 'selected' : ''}>${isSolo ? 'Người chơi 1' : 'Đội 1'}</option>
              <option value="2" ${match.winning_team === 2 ? 'selected' : ''}>${isSolo ? 'Đối thủ' : 'Đội 2'}</option>
            </select>
          </div>

          <div id="editMatchError" class="error-message"></div>
        </form>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="cancelEditMatch">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
            Hủy
          </button>
          <button type="submit" form="editMatchForm" class="btn btn-primary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            Cập nhật
          </button>
        </div>
      </div>
    `
    
    document.body.appendChild(modal)
    
    // Show the modal with animation
    requestAnimationFrame(() => {
      modal.classList.add('show')
    })
    
    // Close button handler
    document.getElementById('closeEditModal').addEventListener('click', () => {
      modal.classList.remove('show')
      setTimeout(() => document.body.removeChild(modal), 200)
    })
    
    document.getElementById('editMatchForm').addEventListener('submit', async (e) => {
      e.preventDefault()
      
      const seasonId = parseInt(document.getElementById('editSeasonId').value)
      const playDate = document.getElementById('editMatchDate').value
      const player1Id = parseInt(document.getElementById('editPlayer1').value)
      const player2Select = document.getElementById('editPlayer2')
      const player2Id = player2Select ? parseInt(player2Select.value) : null
      const player3Id = parseInt(document.getElementById('editPlayer3').value)
      const player4Select = document.getElementById('editPlayer4')
      const player4Id = player4Select ? parseInt(player4Select.value) : null
      const team1Score = parseInt(document.getElementById('editTeam1Score').value)
      const team2Score = parseInt(document.getElementById('editTeam2Score').value)
      const winningTeam = parseInt(document.getElementById('editWinningTeam').value)
      const errorDiv = document.getElementById('editMatchError')
      
      // Validation
      if (!playDate || !seasonId || !player1Id || !player3Id || 
          isNaN(team1Score) || isNaN(team2Score) || !winningTeam) {
        errorDiv.textContent = 'Vui lòng điền đầy đủ thông tin'
        return
      }

      // Validate based on match type
      if (isSolo) {
        if (player1Id === player3Id) {
          errorDiv.textContent = 'Cần 2 người chơi khác nhau'
          return
        }
      } else {
        if (!player2Id || !player4Id) {
          errorDiv.textContent = 'Vui lòng chọn đủ 4 người chơi'
          return
        }
        const playerIds = [player1Id, player2Id, player3Id, player4Id]
        const uniquePlayerIds = [...new Set(playerIds)]
        if (uniquePlayerIds.length !== 4) {
          errorDiv.textContent = 'Cần 4 người chơi khác nhau'
          return
        }
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
            winningTeam,
            matchType: isSolo ? 'solo' : 'duo'
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
          this.showToast('Đã cập nhật trận đấu thành công', 'success')
        } else {
          errorDiv.textContent = data.error
        }
      } catch (error) {
        console.error('Error updating match:', error)
        errorDiv.textContent = 'Lỗi kết nối khi cập nhật trận đấu'
      }
    })
    
    document.getElementById('cancelEditMatch').addEventListener('click', () => {
      modal.classList.remove('show')
      setTimeout(() => document.body.removeChild(modal), 200)
    })
    
    // Close on backdrop click
    modal.querySelector('.modal-backdrop').addEventListener('click', () => {
      modal.classList.remove('show')
      setTimeout(() => document.body.removeChild(modal), 200)
    })
  }

  // Auto-winner detection based on scores - works for both duo and solo modes
  updateAutoWinner() {
    if (this.isManualWinnerMode) return // Don't auto-update if in manual mode

    // Get score inputs - same inputs used for both duo and solo modes
    const team1ScoreInput = document.getElementById('team1Score')
    const team2ScoreInput = document.getElementById('team2Score')
    const team1Score = team1ScoreInput ? parseInt(team1ScoreInput.value) || 0 : 0
    const team2Score = team2ScoreInput ? parseInt(team2ScoreInput.value) || 0 : 0
    
    const winnerSelect = document.getElementById('winner')
    if (!winnerSelect) return

    // Only auto-select winner if scores are different and at least one is > 0
    if (team1Score !== team2Score && (team1Score > 0 || team2Score > 0)) {
      const winningTeam = team1Score > team2Score ? 1 : 2
      
      // Update the select value
      winnerSelect.value = winningTeam === 1 ? 'team1' : 'team2'
      
      // Store the current winning team
      this.currentWinningTeam = winningTeam
    } else if (team1Score === team2Score && team1Score > 0) {
      // Handle tie case - need manual selection
      winnerSelect.value = ''
      this.currentWinningTeam = null
    } else {
      // No scores or both are 0
      winnerSelect.value = ''
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

  // ========== Modal Helpers ==========
  showModal(modalId) {
    const modal = document.getElementById(modalId)
    if (modal) {
      modal.classList.add('show')
      document.body.style.overflow = 'hidden'
    }
  }

  hideModal(modalId) {
    const modal = document.getElementById(modalId)
    if (modal) {
      modal.classList.remove('show')
      document.body.style.overflow = ''
    }
  }

  // ========== Toast Notifications ==========
  // Escape HTML special characters in user-supplied/content strings
  escapeHtml(str) {
    return str.replace(/[&<>"'`]/g, function (c) {
      return ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
        '`': '&#96;',
      })[c];
    });
  }

  showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer')
    if (!container) return

    const toast = document.createElement('div')
    toast.className = `toast ${type}`
    toast.innerHTML = `
      <span class="toast-message">${this.escapeHtml(message)}</span>
      <button class="toast-close">&times;</button>
    `
    
    container.appendChild(toast)
    
    // Close button
    toast.querySelector('.toast-close').addEventListener('click', () => {
      toast.remove()
    })
    
    // Auto-remove after 5 seconds
    setTimeout(() => {
      if (toast.parentElement) {
        toast.style.animation = 'toastOut 0.3s ease forwards'
        setTimeout(() => toast.remove(), 300)
      }
    }, 5000)
  }

  // ========== Account Management ==========
  showAccountModal(account = null) {
    const modal = document.getElementById('accountModal')
    const title = document.getElementById('accountModalTitle')
    const form = document.getElementById('accountForm')
    const passwordHint = document.getElementById('passwordHint')
    const passwordRequired = document.getElementById('passwordRequired')
    
    // Reset form
    form.reset()
    document.getElementById('accountId').value = ''
    document.getElementById('accountActive').checked = true
    
    if (account) {
      // Edit mode
      title.textContent = 'Chỉnh sửa Tài Khoản'
      document.getElementById('accountId').value = account.id
      document.getElementById('accountUsername').value = account.username
      document.getElementById('accountDisplayName').value = account.display_name || ''
      document.getElementById('accountEmail').value = account.email || ''
      document.getElementById('accountRole').value = account.role
      document.getElementById('accountNotes').value = account.notes || ''
      document.getElementById('accountActive').checked = account.is_active
      
      // Password is optional when editing
      passwordHint.textContent = 'Để trống nếu không muốn thay đổi mật khẩu'
      passwordRequired.style.display = 'none'
      document.getElementById('accountPassword').required = false
    } else {
      // Create mode
      title.textContent = 'Tạo Tài Khoản Mới'
      passwordHint.textContent = ''
      passwordRequired.style.display = 'inline'
      document.getElementById('accountPassword').required = true
    }
    
    this.showModal('accountModal')
  }

  async saveAccount() {
    const accountId = document.getElementById('accountId').value
    const accountData = {
      username: document.getElementById('accountUsername').value.trim(),
      displayName: document.getElementById('accountDisplayName').value.trim(),
      email: document.getElementById('accountEmail').value.trim(),
      role: document.getElementById('accountRole').value,
      notes: document.getElementById('accountNotes').value.trim(),
      isActive: document.getElementById('accountActive').checked
    }
    
    const password = document.getElementById('accountPassword').value
    
    // Validate password strength if provided
    if (password) {
      const passwordValidation = this.validatePasswordStrength(password)
      if (!passwordValidation.valid) {
        this.showToast(passwordValidation.message, 'error')
        return
      }
      accountData.password = password
    }
    
    try {
      let response
      if (accountId) {
        // Update existing account
        response = await this.makeAuthenticatedRequest(`${this.apiBase}/auth/users/${accountId}`, {
          method: 'PUT',
          body: JSON.stringify(accountData)
        })
      } else {
        // Create new account
        if (!password) {
          this.showToast('Vui lòng nhập mật khẩu', 'error')
          return
        }
        response = await this.makeAuthenticatedRequest(`${this.apiBase}/auth/users`, {
          method: 'POST',
          body: JSON.stringify(accountData)
        })
      }
      
      const data = await response.json()
      
      if (response.ok) {
        this.hideModal('accountModal')
        this.showToast(accountId ? 'Đã cập nhật tài khoản' : 'Đã tạo tài khoản mới', 'success')
        this.renderAccounts()
      } else {
        this.showToast(data.error || 'Lỗi khi lưu tài khoản', 'error')
      }
    } catch (error) {
      console.error('Error saving account:', error)
      this.showToast('Lỗi kết nối server', 'error')
    }
  }

  async deleteAccount(accountId) {
    if (!confirm('Bạn có chắc chắn muốn xóa tài khoản này?')) return
    
    try {
      const response = await this.makeAuthenticatedRequest(`${this.apiBase}/auth/users/${accountId}`, {
        method: 'DELETE'
      })
      
      if (response.ok) {
        this.showToast('Đã xóa tài khoản', 'success')
        this.renderAccounts()
      } else {
        const data = await response.json()
        this.showToast(data.error || 'Lỗi khi xóa tài khoản', 'error')
      }
    } catch (error) {
      console.error('Error deleting account:', error)
      this.showToast('Lỗi kết nối server', 'error')
    }
  }

  async renderAccounts() {
    const container = document.querySelector('#accountsTable tbody')
    if (!container) return
    
    try {
      const response = await fetch(`${this.apiBase}/auth/users`, {
        credentials: 'include'
      })
      
      if (!response.ok) {
        container.innerHTML = '<tr><td colspan="8" class="text-center">Không thể tải danh sách tài khoản</td></tr>'
        return
      }
      
      const accounts = await response.json()
      
      if (accounts.length === 0) {
        container.innerHTML = '<tr><td colspan="8" class="text-center">Chưa có tài khoản nào</td></tr>'
        return
      }
      
      container.innerHTML = accounts.map(account => {
        const roleClass = account.role === 'admin' ? 'role-admin' : (account.role === 'editor' ? 'role-editor' : 'role-viewer')
        const statusClass = account.is_active ? 'status-active' : 'status-inactive'
        const lastLogin = account.last_login ? new Date(account.last_login).toLocaleString('vi-VN') : 'Chưa đăng nhập'
        const isSelf = this.user && this.user.username === account.username
        
        return `
          <tr>
            <td>${this.escapeHtml(account.id)}</td>
            <td><strong>${this.escapeHtml(account.username)}</strong>${isSelf ? ' <span class="badge role-viewer">Bạn</span>' : ''}</td>
            <td>${this.escapeHtml(account.display_name) || '-'}</td>
            <td>${this.escapeHtml(account.email) || '-'}</td>
            <td><span class="badge ${roleClass}">${this.escapeHtml(account.role).toUpperCase()}</span></td>
            <td><span class="${statusClass}">${account.is_active ? '✅ Hoạt động' : '❌ Vô hiệu'}</span></td>
            <td>${this.escapeHtml(lastLogin)}</td>
            <td>
              <div class="action-btns">
                <button class="edit-btn" data-account-id="${this.escapeHtml(account.id)}" title="Chỉnh sửa">✏️</button>
                <button class="delete-btn" data-account-id="${this.escapeHtml(account.id)}" ${isSelf ? 'disabled title="Không thể xóa tài khoản của chính mình"' : 'title="Xóa"'}>🗑️</button>
              </div>
            </td>
          </tr>
        `
      }).join('')
      
      // Add event listeners for edit/delete buttons
      container.querySelectorAll('.edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const accountId = parseInt(btn.dataset.accountId)
          const account = accounts.find(a => a.id === accountId)
          if (account) this.showAccountModal(account)
        })
      })
      
      container.querySelectorAll('.delete-btn:not([disabled])').forEach(btn => {
        btn.addEventListener('click', () => {
          const accountId = parseInt(btn.dataset.accountId)
          this.deleteAccount(accountId)
        })
      })
    } catch (error) {
      console.error('Error rendering accounts:', error)
      container.innerHTML = '<tr><td colspan="8" class="text-center">Lỗi tải danh sách tài khoản</td></tr>'
    }
  }

  // ========== Reset Match Form ==========
  resetMatchForm() {
    const form = document.getElementById('matchForm')
    if (form) {
      form.reset()
      document.getElementById('matchType').value = 'duo'
      this.currentMatchType = 'duo'
      this.currentWinningTeam = null
      
      // Reset match type UI
      document.querySelectorAll('.type-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.type === 'duo')
      })
      
      // Show duo, hide solo
      document.querySelectorAll('.duo-only').forEach(el => el.style.display = '')
      document.querySelectorAll('.solo-only').forEach(el => el.style.display = 'none')
      
      // Reset match season selector
      const matchSeasonSelect = document.getElementById('matchSeasonSelect')
      if (matchSeasonSelect) matchSeasonSelect.value = ''
      
      // Disable player selects until season is chosen
      const playerSelects = ['player1', 'player2', 'player3', 'player4']
      playerSelects.forEach(id => {
        const select = document.getElementById(id)
        if (select) {
          select.disabled = true
          select.innerHTML = '<option value="">Chọn mùa giải trước...</option>'
        }
      })
      
      // Set today's date
      this.setTodaysDate()
      
      // Reset team labels
      this.updateTeamLabelsForMatchType()
    }
  }
  
  // ========== Password Validation ==========
  validatePasswordStrength(password) {
    if (!password || password.length < 6) {
      return { valid: false, message: 'Mật khẩu phải có ít nhất 6 ký tự' }
    }
    
    // Check for common weak passwords
    const weakPasswords = ['123456', 'password', 'abc123', '111111', '123123', 'admin', 'qwerty', '12345678', 'password123']
    if (weakPasswords.includes(password.toLowerCase())) {
      return { valid: false, message: 'Mật khẩu quá đơn giản, vui lòng chọn mật khẩu khác' }
    }
    
    // Check for at least one letter and one number
    const hasLetter = /[a-zA-Z]/.test(password)
    const hasNumber = /[0-9]/.test(password)
    
    if (!hasLetter || !hasNumber) {
      return { valid: false, message: 'Mật khẩu phải chứa ít nhất 1 chữ cái và 1 số' }
    }
    
    return { valid: true, message: '' }
  }

  // ========== Update Login Modal ==========
  showLoginModal() {
    this.showModal('loginModal')
  }

  // ========== Update File Status (for backward compatibility) ==========
  updateFileStatus(message, type) {
    this.showToast(message.replace(/^[✅❌⚠️]/g, '').trim(), type === 'success' ? 'success' : (type === 'error' ? 'error' : 'warning'))
  }
}

// Initialize the application
const app = new TennisRankingSystem()

// Expose app to global scope for event handlers
window.app = app
