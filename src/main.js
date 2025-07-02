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
    this.apiBase = window.location.origin + '/api'
    this.isAuthenticated = false
    this.user = null
    this.authToken = localStorage.getItem('authToken')
    this.init()
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
      
      // System is ready - no popup notification needed
    } catch (error) {
      console.error('Error during initialization:', error)
      this.updateFileStatus('❌ Lỗi khởi tạo hệ thống. Vui lòng tải lại trang.', 'error')
    }
  }

  hideAllViewModeSections() {
    try {
      // Hide any view mode sections that might be visible outside their proper containers
      const viewModeSections = document.querySelectorAll('.view-mode-section')
      viewModeSections.forEach(section => {
        section.style.display = 'none'
      })
    } catch (error) {
      console.error('Error hiding view mode sections:', error)
    }
  }

  async detectServerMode() {
    try {
      const response = await fetch(`${this.apiBase}/players`)
      this.serverMode = response.ok
    } catch (error) {
      this.serverMode = false
    }
  }

  async checkAuthStatus() {
    if (!this.serverMode) return
    
    try {
      const response = await fetch(`${this.apiBase}/auth/status`, {
        method: 'GET',
        headers: {
          'Authorization': this.authToken ? `Bearer ${this.authToken}` : '',
          'Content-Type': 'application/json'
        },
        credentials: 'include'
      })
      
      if (response.ok) {
        const data = await response.json()
        this.isAuthenticated = data.authenticated
        this.user = data.user
      }
    } catch (error) {
      console.log('Auth status check failed:', error)
      this.isAuthenticated = false
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
        this.authToken = data.token
        localStorage.setItem('authToken', data.token)
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
      await fetch(`${this.apiBase}/auth/logout`, {
        method: 'POST',
        headers: {
          'Authorization': this.authToken ? `Bearer ${this.authToken}` : '',
          'Content-Type': 'application/json'
        },
        credentials: 'include'
      })
    } catch (error) {
      console.log('Logout request failed:', error)
    }
    
    this.isAuthenticated = false
    this.user = null
    this.authToken = null
    localStorage.removeItem('authToken')
    this.updateUIForAuthStatus()
  }

  updateUIForAuthStatus() {
    this.updateAuthHeader()
    
    const editElements = document.querySelectorAll('.edit-only')
    editElements.forEach(element => {
      element.style.display = this.isAuthenticated ? '' : 'none'
    })
    
    const guestInfo = document.querySelector('.guest-info')
    if (guestInfo) {
      guestInfo.style.display = this.isAuthenticated ? 'none' : 'block'
    }
    
    // Hide/show auth-required tabs
    const authTabs = document.querySelectorAll('[data-tab="players"], [data-tab="matches"], [data-tab="seasons"]')
    authTabs.forEach(tab => {
      if (this.isAuthenticated) {
        tab.style.display = ''
      } else {
        tab.style.display = 'none'
        if (tab.classList.contains('active')) {
          this.switchTab('rankings')
        }
      }
    })
    
    this.renderPlayers()
    this.renderSeasons()
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
      authDiv.innerHTML = `
        <div class="user-info">
          <span>👤 ${this.user.username}</span>
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
        viewModeSection.style.display = 'block'
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
    document.getElementById('dateSelectContainer').style.display = mode === 'daily' ? 'block' : 'none'
    document.getElementById('seasonSelectContainer').style.display = mode === 'season' ? 'block' : 'none'
    
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
        dateContainer.style.display = this.currentViewMode === 'daily' ? 'block' : 'none'
      }
      
      if (seasonContainer) {
        seasonContainer.style.display = this.currentViewMode === 'season' ? 'block' : 'none'
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
      const response = await fetch(`${this.apiBase}/players`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.authToken}`,
          'Content-Type': 'application/json'
        },
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
      const response = await fetch(`${this.apiBase}/players/${playerId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this.authToken}`,
          'Content-Type': 'application/json'
        }
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

    if (winningTeam !== 1 && winningTeam !== 2) {
      this.updateFileStatus('❌ Vui lòng chọn đội thắng', 'error')
      return
    }

    try {
      const response = await fetch(`${this.apiBase}/matches`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.authToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          seasonId: activeSeason.id,
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
        await this.loadMatches()
        await this.loadPlayDates()
        
        // Reset form
        document.getElementById('matchDate').value = ''
        document.getElementById('team1Score').value = ''
        document.getElementById('team2Score').value = ''
        document.getElementById('winningTeam').value = ''
        
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

      container.innerHTML = this.players.map(player => `
        <div class="player-card">
          <span class="player-name">${player.name}</span>
          ${this.isAuthenticated ? `
            <button class="delete-btn edit-only" onclick="app.removePlayer(${player.id})">❌</button>
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

      container.innerHTML = this.seasons.map(season => `
        <div class="season-card ${season.is_active ? 'active' : ''}">
          <div class="season-info">
            <h3>${season.name} ${season.is_active ? '(Đang hoạt động)' : ''}</h3>
            <p>📅 Từ: ${this.formatDate(season.start_date)}</p>
            ${season.end_date ? `<p>📅 Đến: ${this.formatDate(season.end_date)}</p>` : ''}
          </div>
          ${this.isAuthenticated ? `
            <div class="season-actions edit-only">
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
      if (this.isAuthenticated) {
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
      const color = match.result === 'win' ? '#4CAF50' : '#f44336'
      return `<span class="form-dot" style="background-color: ${color};" title="${match.result === 'win' ? 'Thắng' : 'Thua'} - ${this.formatDate(match.play_date)}"></span>`
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
      
      const editDeleteButtons = this.isAuthenticated ? `
        <div class="match-actions edit-only">
          <button data-action="edit-match" data-id="${match.id}" class="edit-btn" title="Sửa trận đấu">✏️</button>
          <button data-action="delete-match" data-id="${match.id}" class="delete-btn" title="Xóa trận đấu">🗑️</button>
        </div>
      ` : ''
      
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

      const response = await fetch(`${this.apiBase}/seasons`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.authToken}`,
          'Content-Type': 'application/json'
        },
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
      const response = await fetch(`${this.apiBase}/seasons/${seasonId}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.authToken}`,
          'Content-Type': 'application/json'
        },
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
      const response = await fetch(`${this.apiBase}/seasons/${seasonId}/end`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.authToken}`,
          'Content-Type': 'application/json'
        },
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
      const response = await fetch(`${this.apiBase}/seasons/${seasonId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this.authToken}`,
          'Content-Type': 'application/json'
        }
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
        a.style.display = 'none'
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

  formatDate(dateString) {
    if (!dateString) return ''
    const date = new Date(dateString)
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

      const response = await fetch(`${this.apiBase}/clear-all-data`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this.authToken}`,
          'Content-Type': 'application/json'
        }
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

  async createSampleDataManually() {
    if (!this.isAuthenticated) {
      this.updateFileStatus('❌ Cần đăng nhập để tạo dữ liệu mẫu', 'error')
      return
    }

    const confirm = window.confirm(
      'Bạn có chắc muốn tạo dữ liệu mẫu?\n\n' +
      'Điều này sẽ tạo:\n' +
      '• 6 người chơi mẫu\n' +
      '• 1 mùa giải mặc định\n\n' +
      'Dữ liệu hiện tại sẽ không bị xóa.'
    )

    if (!confirm) return

    try {
      // Create sample players
      const samplePlayers = ['Nguyễn Văn A', 'Trần Thị B', 'Lê Văn C', 'Phạm Thị D', 'Hoàng Văn E', 'Vũ Thị F']
      
      for (const name of samplePlayers) {
        // Check if player already exists
        const existingPlayer = this.players.find(p => p.name === name)
        if (!existingPlayer) {
          await this.addPlayerToDatabase(name)
        }
      }

      // Create default season if none exists
      if (this.seasons.length === 0) {
        const currentDate = new Date().toISOString().split('T')[0]
        await this.createSeason('Mùa giải đầu tiên', currentDate)
      }

      // Reload all data
      await this.loadPlayers()
      await this.loadSeasons()
      this.updatePlayerSelects()
      this.updateSeasonSelector()
      this.renderPlayers()
      this.renderSeasons()

      this.updateFileStatus('✅ Đã tạo dữ liệu mẫu thành công!', 'success')
      
    } catch (error) {
      console.error('Error creating sample data:', error)
      this.updateFileStatus('❌ Lỗi khi tạo dữ liệu mẫu', 'error')
    }
  }

  // ...existing methods...

  async editMatch(matchId) {
    if (!this.isAuthenticated) {
      this.updateFileStatus('❌ Cần đăng nhập để sửa trận đấu', 'error')
      return
    }

    try {
      // Get match data
      const response = await fetch(`${this.apiBase}/matches/${matchId}`, {
        headers: {
          'Authorization': `Bearer ${this.authToken}`,
          'Content-Type': 'application/json'
        }
      })

      if (!response.ok) {
        this.updateFileStatus('❌ Không tìm thấy trận đấu', 'error')
        return
      }

      const match = await response.json()
      this.showMatchModal(match)
    } catch (error) {
      console.error('Error getting match:', error)
      this.updateFileStatus('❌ Lỗi khi tải thông tin trận đấu', 'error')
    }
  }

  async deleteMatch(matchId) {
    if (!this.isAuthenticated) {
      this.updateFileStatus('❌ Cần đăng nhập để xóa trận đấu', 'error')
      return
    }

    const confirmDelete = confirm(
      '⚠️ CẢNH BÁO ⚠️\n\n' +
      'Bạn có chắc chắn muốn xóa trận đấu này?\n\n' +
      'Hành động này sẽ:\n' +
      '• Xóa vĩnh viễn trận đấu\n' +
      '• Cập nhật lại tất cả thống kê\n' +
      '• Không thể hoàn tác\n\n' +
      'Bạn có muốn tiếp tục?'
    )

    if (!confirmDelete) return

    try {
      const response = await fetch(`${this.apiBase}/matches/${matchId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this.authToken}`,
          'Content-Type': 'application/json'
        }
      })

      const data = await response.json()

      if (response.ok) {
        // Reload all data since deleting a match affects rankings and statistics
        await Promise.all([
          this.loadMatches(),
          this.loadPlayDates()
        ])

        this.renderRankings()
        this.renderMatchHistory()
        this.updateDateSelector()
        
        this.updateFileStatus('✅ Đã xóa trận đấu thành công', 'success')
      } else {
        this.updateFileStatus(`❌ ${data.error || 'Lỗi khi xóa trận đấu'}`, 'error')
      }
    } catch (error) {
      console.error('Error deleting match:', error)
      this.updateFileStatus('❌ Lỗi kết nối khi xóa trận đấu', 'error')
    }
  }

  showMatchModal(match = null) {
    const isEdit = match !== null
    const modal = document.createElement('div')
    modal.className = 'modal'
    modal.innerHTML = `
      <div class="modal-content">
        <h2>${isEdit ? 'Sửa trận đấu' : 'Ghi nhận trận đấu mới'}</h2>
        <form id="matchForm">
          <div class="form-row">
            <div class="form-group">
              <label for="modalMatchDate">Ngày đánh:</label>
              <input type="date" id="modalMatchDate" value="${match ? match.play_date : ''}" required>
            </div>
            <div class="form-group">
              <label for="modalSeasonId">Mùa giải:</label>
              <select id="modalSeasonId" required>
                <option value="">Chọn mùa giải...</option>
              </select>
            </div>
          </div>
          
          <div class="teams-container">
            <div class="team-selection">
              <h3>Đội 1</h3>
              <select id="modalPlayer1" required>
                <option value="">Chọn người chơi 1</option>
              </select>
              <select id="modalPlayer2" required>
                <option value="">Chọn người chơi 2</option>
              </select>
            </div>
            
            <div class="vs">VS</div>
            
            <div class="team-selection">
              <h3>Đội 2</h3>
              <select id="modalPlayer3" required>
                <option value="">Chọn người chơi 1</option>
              </select>
              <select id="modalPlayer4" required>
                <option value="">Chọn người chơi 2</option>
              </select>
            </div>
          </div>

          <div class="score-section">
            <h3>Kết quả trận đấu</h3>
            <div class="score-input">
              <div class="score-group">
                <label>Điểm đội 1:</label>
                <input type="number" id="modalTeam1Score" min="0" value="${match ? match.team1_score : ''}" required>
              </div>
              <div class="score-group">
                <label>Điểm đội 2:</label>
                <input type="number" id="modalTeam2Score" min="0" value="${match ? match.team2_score : ''}" required>
              </div>
            </div>
            <div class="winner-selection">
              <label>Đội thắng:</label>
              <select id="modalWinningTeam" required>
                <option value="">Chọn đội thắng</option>
                <option value="1" ${match && match.winning_team === 1 ? 'selected' : ''}>Đội 1</option>
                <option value="2" ${match && match.winning_team === 2 ? 'selected' : ''}>Đội 2</option>
              </select>
            </div>
          </div>

          <div class="form-actions">
            <button type="submit">${isEdit ? 'Cập nhật' : 'Ghi nhận'}</button>
            <button type="button" id="cancelMatch">Hủy</button>
          </div>
        </form>
        <div id="matchError" class="error-message"></div>
      </div>
    `
    
    document.body.appendChild(modal)
    
    // Populate player dropdowns
    const playerOptions = this.players.map(player => 
      `<option value="${player.id}">${player.name}</option>`
    ).join('')
    
    const modalSelects = ['modalPlayer1', 'modalPlayer2', 'modalPlayer3', 'modalPlayer4']
    modalSelects.forEach(selectId => {
      const select = document.getElementById(selectId)
      if (select) {
        select.innerHTML = `<option value="">Chọn người chơi...</option>${playerOptions}`
      }
    })

    // Populate seasons dropdown
    const seasonOptions = this.seasons.map(season => 
      `<option value="${season.id}">${season.name}</option>`
    ).join('')
    
    const seasonSelect = document.getElementById('modalSeasonId')
    if (seasonSelect) {
      seasonSelect.innerHTML = `<option value="">Chọn mùa giải...</option>${seasonOptions}`
    }
    
    // Set selected values if editing
    if (match) {
      document.getElementById('modalPlayer1').value = match.player1_id
      document.getElementById('modalPlayer2').value = match.player2_id
      document.getElementById('modalPlayer3').value = match.player3_id
      document.getElementById('modalPlayer4').value = match.player4_id
      document.getElementById('modalSeasonId').value = match.season_id
    }
    
    // Form submission handler
    document.getElementById('matchForm').addEventListener('submit', async (e) => {
      e.preventDefault()
      
      const seasonId = parseInt(document.getElementById('modalSeasonId').value)
      const playDate = document.getElementById('modalMatchDate').value
      const player1Id = parseInt(document.getElementById('modalPlayer1').value)
      const player2Id = parseInt(document.getElementById('modalPlayer2').value)
      const player3Id = parseInt(document.getElementById('modalPlayer3').value)
      const player4Id = parseInt(document.getElementById('modalPlayer4').value)
      const team1Score = parseInt(document.getElementById('modalTeam1Score').value)
      const team2Score = parseInt(document.getElementById('modalTeam2Score').value)
      const winningTeam = parseInt(document.getElementById('modalWinningTeam').value)
      const errorDiv = document.getElementById('matchError')
      
      // Validation
      if (isNaN(seasonId) || !playDate || isNaN(player1Id) || isNaN(player2Id) || isNaN(player3Id) || isNaN(player4Id) || 
          isNaN(team1Score) || isNaN(team2Score) || isNaN(winningTeam)) {
        errorDiv.textContent = 'Vui lòng điền đầy đủ thông tin'
        return
      }
      
      const playerIds = [player1Id, player2Id, player3Id, player4Id]
      const uniquePlayerIds = [...new Set(playerIds)]
      if (uniquePlayerIds.length !== 4) {
        errorDiv.textContent = 'Cần 4 người chơi khác nhau'
        return
      }
      
      try {
        const url = isEdit ? `${this.apiBase}/matches/${match.id}` : `${this.apiBase}/matches`
        const method = isEdit ? 'PUT' : 'POST'
        
        const response = await fetch(url, {
          method,
          headers: {
            'Authorization': `Bearer ${this.authToken}`,
            'Content-Type': 'application/json'
          },
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
          // Reload data
          await Promise.all([
            this.loadMatches(),
            this.loadPlayDates()
          ])

          this.renderRankings()
          this.renderMatchHistory()
          this.updateDateSelector()
          
          document.body.removeChild(modal)
          this.updateFileStatus(`✅ ${isEdit ? 'Cập nhật' : 'Ghi nhận'} trận đấu thành công`, 'success')
        } else {
          errorDiv.textContent = data.error || `Lỗi khi ${isEdit ? 'cập nhật' : 'ghi nhận'} trận đấu`
        }
      } catch (error) {
        console.error('Error saving match:', error)
        errorDiv.textContent = `Lỗi kết nối khi ${isEdit ? 'cập nhật' : 'ghi nhận'} trận đấu`
      }
    })
    
    // Cancel button handler
    document.getElementById('cancelMatch').addEventListener('click', () => {
      document.body.removeChild(modal)
    })
    
    // Close modal when clicking outside
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        document.body.removeChild(modal)
      }
    })
  }
}

// Initialize the application
const app = new TennisRankingSystem()

// Expose app to global scope for event handlers
window.app = app
