import './style.css'
import * as XLSX from 'xlsx'

// Tennis Ranking System with Excel File Storage
class TennisRankingSystem {
  constructor() {
    this.players = []
    this.matches = []
    this.currentFileName = 'tennis-data.xlsx'
    this.autoSaveEnabled = true
    this.serverMode = true // Will be set based on server availability
    this.apiBase = 'http://localhost:3001/api'
    this.init()
  }

  async init() {
    await this.detectServerMode()
    this.setupEventListeners()
    await this.loadInitialData()
    this.renderPlayers()
    this.renderRankings()
    this.renderMatchHistory()
    this.updatePlayerSelects()
    
    const modeText = this.serverMode ? 'Server Mode - Shared Data' : 'Local Mode'
    this.updateFileStatus(`📂 Hệ thống sẵn sàng (${modeText}). ${this.serverMode ? 'Tất cả người dùng có thể truy cập cùng dữ liệu!' : 'Dùng nút "Lưu dữ liệu ra Excel" để xuất file.'}`, 'info')
  }

  async detectServerMode() {
    try {
      const response = await fetch(`${this.apiBase}/files`)
      this.serverMode = response.ok
    } catch (error) {
      this.serverMode = false
    }
  }

  async loadInitialData() {
    if (this.serverMode) {
      await this.loadFromServer()
    } else {
      this.loadFromLocalStorage()
    }
  }

  setupEventListeners() {
    // Tab switching
    document.querySelectorAll('.tab-button').forEach(button => {
      button.addEventListener('click', (e) => {
        this.switchTab(e.target.dataset.tab)
      })
    })

    // Add player
    document.getElementById('addPlayer').addEventListener('click', async () => {
      await this.addPlayer()
    })

    document.getElementById('playerName').addEventListener('keypress', async (e) => {
      if (e.key === 'Enter') {
        await this.addPlayer()
      }
    })

    // Record match
    document.getElementById('recordMatch').addEventListener('click', async () => {
      await this.recordMatch()
    })

    // Export rankings
    document.getElementById('exportRankings').addEventListener('click', () => {
      this.exportToExcel()
    })

    // Reset database
    document.getElementById('resetDatabase').addEventListener('click', () => {
      this.resetDatabase()
    })

    // Database info
    document.getElementById('databaseInfo').addEventListener('click', () => {
      this.showDatabaseInfo()
    })

    // File management
    document.getElementById('loadDataFile').addEventListener('change', (e) => {
      this.loadFromExcel(e.target.files[0])
    })

    document.getElementById('saveDataFile').addEventListener('click', () => {
      this.saveToExcel()
    })
  }

  switchTab(tabName) {
    // Remove active class from all tabs and content
    document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'))
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'))

    // Add active class to clicked tab and corresponding content
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active')
    document.getElementById(`${tabName}-tab`).classList.add('active')

    // Update content when switching to certain tabs
    if (tabName === 'rankings') {
      this.renderRankings()
    } else if (tabName === 'history') {
      this.renderMatchHistory()
    } else if (tabName === 'matches') {
      this.updatePlayerSelects()
    }
  }

  async addPlayer() {
    const playerNameInput = document.getElementById('playerName')
    const name = playerNameInput.value.trim()

    if (!name) {
      this.showMessage('Vui lòng nhập tên người chơi', 'error')
      return
    }

    if (this.players.find(p => p.name === name)) {
      this.showMessage('Người chơi đã tồn tại', 'error')
      return
    }

    const player = {
      id: Date.now(),
      name: name,
      points: 0,
      wins: 0,
      losses: 0,
      moneyLost: 0
    }

    this.players.push(player)
    await this.saveData()
    this.renderPlayers()
    this.updatePlayerSelects()
    playerNameInput.value = ''
    this.showMessage('Đã thêm người chơi thành công', 'success')
  }

  async removePlayer(playerId) {
    if (confirm('Bạn có chắc chắn muốn xóa người chơi này?')) {
      this.players = this.players.filter(p => p.id !== playerId)
      await this.saveData()
      this.renderPlayers()
      this.updatePlayerSelects()
      this.showMessage('Đã xóa người chơi', 'success')
    }
  }

  async recordMatch() {
    const team1Player1 = document.getElementById('team1Player1').value
    const team1Player2 = document.getElementById('team1Player2').value
    const team2Player1 = document.getElementById('team2Player1').value
    const team2Player2 = document.getElementById('team2Player2').value
    const team1Score = document.getElementById('team1Score').value.trim()
    const team2Score = document.getElementById('team2Score').value.trim()
    const winner = document.querySelector('input[name="winner"]:checked')?.value

    // Validation
    if (!team1Player1 || !team1Player2 || !team2Player1 || !team2Player2) {
      this.showMessage('Vui lòng chọn đủ 4 người chơi', 'error')
      return
    }

    const allPlayers = [team1Player1, team1Player2, team2Player1, team2Player2]
    if (new Set(allPlayers).size !== 4) {
      this.showMessage('Mỗi người chỉ được chơi một lần trong trận đấu', 'error')
      return
    }

    if (!winner) {
      this.showMessage('Vui lòng chọn đội thắng', 'error')
      return
    }

    // Create match record
    const match = {
      id: Date.now(),
      date: new Date().toLocaleString('vi-VN'),
      team1: {
        player1: this.getPlayerById(team1Player1),
        player2: this.getPlayerById(team1Player2),
        score: team1Score
      },
      team2: {
        player1: this.getPlayerById(team2Player1),
        player2: this.getPlayerById(team2Player2),
        score: team2Score
      },
      winner: winner
    }

    // Update player stats
    const winnerPlayers = winner === 'team1' 
      ? [team1Player1, team1Player2] 
      : [team2Player1, team2Player2]
    
    const loserPlayers = winner === 'team1' 
      ? [team2Player1, team2Player2] 
      : [team1Player1, team1Player2]

    // Update winners
    winnerPlayers.forEach(playerId => {
      const player = this.getPlayerById(playerId)
      player.points += 4
      player.wins += 1
    })

    // Update losers
    loserPlayers.forEach(playerId => {
      const player = this.getPlayerById(playerId)
      player.points += 1
      player.losses += 1
      player.moneyLost += 20000
    })

    this.matches.push(match)
    await this.saveData()
    this.clearMatchForm()
    this.showMessage('Đã ghi nhận trận đấu thành công', 'success')
  }

  clearMatchForm() {
    document.getElementById('team1Player1').value = ''
    document.getElementById('team1Player2').value = ''
    document.getElementById('team2Player1').value = ''
    document.getElementById('team2Player2').value = ''
    document.getElementById('team1Score').value = ''
    document.getElementById('team2Score').value = ''
    document.querySelectorAll('input[name="winner"]').forEach(radio => radio.checked = false)
  }

  getPlayerById(id) {
    return this.players.find(p => p.id == id)
  }

  renderPlayers() {
    const container = document.getElementById('playersList')
    
    if (this.players.length === 0) {
      container.innerHTML = '<p>Chưa có người chơi nào. Hãy thêm người chơi đầu tiên!</p>'
      return
    }

    container.innerHTML = this.players.map(player => `
      <div class="player-card">
        <span class="player-name">${player.name}</span>
        <button class="delete-player" onclick="tennisSystem.removePlayer(${player.id})">
          Xóa
        </button>
      </div>
    `).join('')
  }

  updatePlayerSelects() {
    const selects = [
      'team1Player1', 'team1Player2', 'team2Player1', 'team2Player2'
    ]

    selects.forEach(selectId => {
      const select = document.getElementById(selectId)
      select.innerHTML = '<option value="">Chọn người chơi</option>' +
        this.players.map(player => 
          `<option value="${player.id}">${player.name}</option>`
        ).join('')
    })
  }

  renderRankings() {
    const container = document.getElementById('rankingsTable')
    
    if (this.players.length === 0) {
      container.innerHTML = '<p>Chưa có dữ liệu để xếp hạng</p>'
      return
    }

    // Sort players by points (descending)
    const sortedPlayers = [...this.players].sort((a, b) => b.points - a.points)

    const tableHTML = `
      <table class="rankings-table">
        <thead>
          <tr>
            <th>Hạng</th>
            <th>Tên</th>
            <th>Điểm</th>
            <th>Thắng</th>
            <th>Thua</th>
            <th>Tỷ lệ thắng</th>
            <th>Tiền mất (VND)</th>
          </tr>
        </thead>
        <tbody>
          ${sortedPlayers.map((player, index) => {
            const winRate = player.wins + player.losses > 0 
              ? ((player.wins / (player.wins + player.losses)) * 100).toFixed(1)
              : '0.0'
            const rankClass = index < 3 ? `rank-${index + 1}` : ''
            
            return `
              <tr>
                <td class="rank-position ${rankClass}">${index + 1}</td>
                <td>${player.name}</td>
                <td><strong>${player.points}</strong></td>
                <td>${player.wins}</td>
                <td>${player.losses}</td>
                <td>${winRate}%</td>
                <td>${player.moneyLost.toLocaleString()}</td>
              </tr>
            `
          }).join('')}
        </tbody>
      </table>
    `

    container.innerHTML = tableHTML
  }

  renderMatchHistory() {
    const container = document.getElementById('matchHistory')
    
    if (this.matches.length === 0) {
      container.innerHTML = '<p>Chưa có trận đấu nào được ghi nhận</p>'
      return
    }

    const historyHTML = [...this.matches].reverse().map(match => {
      const team1Names = `${match.team1.player1.name} & ${match.team1.player2.name}`
      const team2Names = `${match.team2.player1.name} & ${match.team2.player2.name}`
      const team1Class = match.winner === 'team1' ? 'winner' : 'loser'
      const team2Class = match.winner === 'team2' ? 'winner' : 'loser'

      return `
        <div class="match-item">
          <div class="match-header">
            <div class="match-date">${match.date}</div>
            <div class="match-actions">
              <button class="edit-match" onclick="tennisSystem.editMatch(${match.id})">✏️ Sửa</button>
              <button class="delete-match" onclick="tennisSystem.deleteMatch(${match.id})">🗑️ Xóa</button>
            </div>
          </div>
          <div class="match-teams">
            <span class="team ${team1Class}">${team1Names}</span>
            <span class="vs">VS</span>
            <span class="team ${team2Class}">${team2Names}</span>
          </div>
          <div class="match-score">
            ${match.team1.score || 'N/A'} - ${match.team2.score || 'N/A'}
          </div>
        </div>
      `
    }).join('')

    container.innerHTML = historyHTML
  }

  exportToExcel() {
    if (this.players.length === 0) {
      this.showMessage('Không có dữ liệu để xuất', 'error')
      return
    }

    // Prepare rankings data
    const sortedPlayers = [...this.players].sort((a, b) => b.points - a.points)
    const rankingsData = sortedPlayers.map((player, index) => ({
      'Hạng': index + 1,
      'Tên': player.name,
      'Điểm': player.points,
      'Thắng': player.wins,
      'Thua': player.losses,
      'Tỷ lệ thắng (%)': player.wins + player.losses > 0 
        ? ((player.wins / (player.wins + player.losses)) * 100).toFixed(1)
        : '0.0',
      'Tiền mất (VND)': player.moneyLost
    }))

    // Prepare match history data
    const matchData = this.matches.map(match => ({
      'Ngày': match.date,
      'Đội 1': `${match.team1.player1.name} & ${match.team1.player2.name}`,
      'Tỷ số đội 1': match.team1.score || 'N/A',
      'Đội 2': `${match.team2.player1.name} & ${match.team2.player2.name}`,
      'Tỷ số đội 2': match.team2.score || 'N/A',
      'Đội thắng': match.winner === 'team1' ? 'Đội 1' : 'Đội 2'
    }))

    // Create workbook
    const workbook = XLSX.utils.book_new()
    
    // Add rankings sheet
    const rankingsSheet = XLSX.utils.json_to_sheet(rankingsData)
    XLSX.utils.book_append_sheet(workbook, rankingsSheet, 'Bảng xếp hạng')
    
    // Add match history sheet
    const matchSheet = XLSX.utils.json_to_sheet(matchData)
    XLSX.utils.book_append_sheet(workbook, matchSheet, 'Lịch sử trận đấu')

    // Download file
    const fileName = `tennis-ranking-${new Date().toISOString().split('T')[0]}.xlsx`
    XLSX.writeFile(workbook, fileName)
    
    this.showMessage('Đã xuất file Excel thành công', 'success')
  }

  resetDatabase() {
    const confirmation = confirm(
      'CẢNH BÁO: Thao tác này sẽ xóa TOÀN BỘ dữ liệu!\n\n' +
      '• Tất cả người chơi sẽ bị xóa\n' +
      '• Tất cả trận đấu sẽ bị xóa\n' +
      '• Bảng xếp hạng sẽ bị reset\n' +
      '• Lịch sử trận đấu sẽ bị xóa\n\n' +
      'Bạn có CHẮC CHẮN muốn tiếp tục?\n\n' +
      '💡 Lời khuyên: Hãy lưu Excel trước khi reset!'
    )

    if (confirmation) {
      const doubleConfirm = confirm(
        '🚨 XÁC NHẬN LẦN CUỐI!\n\n' +
        'Dữ liệu sẽ BỊ MẤT VĨNH VIỄN!\n\n' +
        '⚠️ Lưu ý: Chỉ xóa dữ liệu trong app, file Excel đã lưu vẫn an toàn\n\n' +
        'Nhấn OK để XÓA TOÀN BỘ dữ liệu'
      )

      if (doubleConfirm) {
        // Clear all data
        this.players = []
        this.matches = []
        
        // Clear localStorage backup
        localStorage.removeItem('tennis-players')
        localStorage.removeItem('tennis-matches')
        
        // Reset filename
        this.currentFileName = 'tennis-data.xlsx'
        
        // Refresh all displays
        this.refreshAllDisplays()
        
        this.updateFileStatus('✅ Đã reset toàn bộ dữ liệu! File Excel cũ vẫn an toàn.', 'success')
      }
    }
  }

  showDatabaseInfo() {
    const message = `
📍 THÔNG TIN LUU TRỮ:
• Dữ liệu chính: Excel Files (.xlsx)
• File hiện tại: ${this.currentFileName}
• Backup: Browser LocalStorage
• Số người chơi: ${this.players.length}
• Số trận đấu: ${this.matches.length}
• Kích thước dữ liệu: ${this.getDatabaseSize()}

💾 Tự động lưu: ${this.autoSaveEnabled ? 'BẬT' : 'TẮT'}
📂 Tải dữ liệu: Dùng nút "Tải dữ liệu từ Excel"
� Lưu thủ công: Dùng nút "Lưu dữ liệu ra Excel"
    `.trim()
    
    alert(message)
  }

  getDatabaseSize() {
    const playersSize = JSON.stringify(this.players).length
    const matchesSize = JSON.stringify(this.matches).length
    const totalBytes = playersSize + matchesSize
    
    if (totalBytes < 1024) return `${totalBytes} bytes`
    if (totalBytes < 1048576) return `${(totalBytes / 1024).toFixed(1)} KB`
    return `${(totalBytes / 1048576).toFixed(1)} MB`
  }

  async saveData() {
    // Always save to localStorage as backup
    localStorage.setItem('tennis-players', JSON.stringify(this.players))
    localStorage.setItem('tennis-matches', JSON.stringify(this.matches))
    
    if (this.serverMode) {
      await this.saveToServer()
    } else {
      this.updateFileStatus('📝 Dữ liệu đã được lưu local', 'success')
    }
  }

  async saveToServer() {
    try {
      // Create Excel data
      const excelData = await this.createExcelData()
      
      // Generate filename with timestamp
      const now = new Date()
      const timestamp = now.toISOString().slice(0, 10) + '_' + 
                       now.toTimeString().slice(0, 5).replace(':', '-')
      const fileName = `tennis-data_${timestamp}.xlsx`
      
      const response = await fetch(`${this.apiBase}/save-excel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fileName,
          data: excelData
        })
      })

      const result = await response.json()
      
      if (result.success) {
        this.currentFileName = result.fileName
        this.updateFileStatus(`💾 Đã lưu dữ liệu lên server: ${result.fileName}`, 'success')
      } else {
        throw new Error(result.error || 'Failed to save to server')
      }
    } catch (error) {
      console.error('Error saving to server:', error)
      this.updateFileStatus(`❌ Lỗi khi lưu lên server: ${error.message}. Dữ liệu vẫn được lưu local.`, 'warning')
    }
  }

  async createExcelData() {
    // Prepare players data
    const playersData = this.players.map(player => ({
      'ID': player.id,
      'Tên': player.name,
      'Điểm': player.points,
      'Thắng': player.wins,
      'Thua': player.losses,
      'Tiền mất (VND)': player.moneyLost
    }))

    // Prepare matches data
    const matchesData = this.matches.map(match => ({
      'ID': match.id,
      'Ngày': match.date,
      'Đội 1 - Người 1': match.team1.player1?.name || '',
      'Đội 1 - Người 2': match.team1.player2?.name || '',
      'Tỷ số đội 1': match.team1.score,
      'Đội 2 - Người 1': match.team2.player1?.name || '',
      'Đội 2 - Người 2': match.team2.player2?.name || '',
      'Tỷ số đội 2': match.team2.score,
      'Đội thắng': match.winner === 'team1' ? 'Đội 1' : 'Đội 2'
    }))

    // Create workbook
    const workbook = XLSX.utils.book_new()
    
    // Add players sheet
    const playersSheet = XLSX.utils.json_to_sheet(playersData)
    XLSX.utils.book_append_sheet(workbook, playersSheet, 'Players')
    
    // Add matches sheet
    const matchesSheet = XLSX.utils.json_to_sheet(matchesData)
    XLSX.utils.book_append_sheet(workbook, matchesSheet, 'Matches')

    // Add rankings sheet
    const rankingsData = [...this.players].sort((a, b) => b.points - a.points)
      .map((player, index) => ({
        'Hạng': index + 1,
        'Tên': player.name,
        'Điểm': player.points,
        'Thắng': player.wins,
        'Thua': player.losses,
        'Tỷ lệ thắng (%)': player.wins + player.losses > 0 
          ? ((player.wins / (player.wins + player.losses)) * 100).toFixed(1)
          : '0.0',
        'Tiền mất (VND)': player.moneyLost
      }))

    const rankingsSheet = XLSX.utils.json_to_sheet(rankingsData)
    XLSX.utils.book_append_sheet(workbook, rankingsSheet, 'Rankings')

    // Convert to base64
    const excelBuffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })
    const base64Data = btoa(String.fromCharCode(...new Uint8Array(excelBuffer)))
    
    return base64Data
  }

  showMessage(message, type = 'success') {
    // Remove existing messages
    document.querySelectorAll('.success-message, .error-message').forEach(el => el.remove())

    const messageDiv = document.createElement('div')
    messageDiv.className = type === 'success' ? 'success-message' : 'error-message'
    messageDiv.textContent = message

    // Insert at the top of main
    const main = document.querySelector('main')
    main.insertBefore(messageDiv, main.firstChild)

    // Auto remove after 3 seconds
    setTimeout(() => {
      messageDiv.remove()
    }, 3000)
  }

  // File Management Methods
  async loadFromExcel(file) {
    if (!file) return

    try {
      const arrayBuffer = await file.arrayBuffer()
      const workbook = XLSX.read(arrayBuffer, { type: 'array' })
      
      // Load players data
      if (workbook.SheetNames.includes('Players')) {
        const playersSheet = workbook.Sheets['Players']
        const playersData = XLSX.utils.sheet_to_json(playersSheet)
        
        this.players = playersData.map(row => ({
          id: row['ID'] || Date.now() + Math.random(),
          name: row['Tên'] || row['Name'] || '',
          points: parseInt(row['Điểm'] || row['Points'] || 0),
          wins: parseInt(row['Thắng'] || row['Wins'] || 0),
          losses: parseInt(row['Thua'] || row['Losses'] || 0),
          moneyLost: parseInt(row['Tiền mất (VND)'] || row['Money Lost'] || 0)
        })).filter(player => player.name) // Remove empty names
      }

      // Load matches data
      if (workbook.SheetNames.includes('Matches')) {
        const matchesSheet = workbook.Sheets['Matches']
        const matchesData = XLSX.utils.sheet_to_json(matchesSheet)
        
        this.matches = matchesData.map(row => ({
          id: row['ID'] || Date.now() + Math.random(),
          date: row['Ngày'] || row['Date'] || new Date().toLocaleString('vi-VN'),
          team1: {
            player1: this.findPlayerByName(row['Đội 1 - Người 1'] || row['Team 1 - Player 1']),
            player2: this.findPlayerByName(row['Đội 1 - Người 2'] || row['Team 1 - Player 2']),
            score: row['Tỷ số đội 1'] || row['Team 1 Score'] || ''
          },
          team2: {
            player1: this.findPlayerByName(row['Đội 2 - Người 1'] || row['Team 2 - Player 1']),
            player2: this.findPlayerByName(row['Đội 2 - Người 2'] || row['Team 2 - Player 2']),
            score: row['Tỷ số đội 2'] || row['Team 2 Score'] || ''
          },
          winner: (row['Đội thắng'] || row['Winner']) === 'Đội 1' || row['Winner'] === 'Team 1' ? 'team1' : 'team2'
        })).filter(match => match.team1.player1 && match.team2.player1) // Remove invalid matches
      }

      this.currentFileName = file.name
      this.refreshAllDisplays()
      this.updateFileStatus(`✅ Đã tải dữ liệu từ file: ${file.name}`, 'success')
      
    } catch (error) {
      console.error('Error loading Excel file:', error)
      this.updateFileStatus(`❌ Lỗi khi tải file: ${error.message}`, 'error')
    }
  }

  async loadFromServer() {
    try {
      const response = await fetch(`${this.apiBase}/current-data`)
      const result = await response.json()
      
      if (result.success && result.data) {
        await this.parseExcelData(result.data)
        this.currentFileName = result.fileName
        this.updateFileStatus(`✅ Đã tải dữ liệu từ server: ${result.fileName}`, 'success')
      } else {
        // No data on server, start fresh
        this.updateFileStatus('📋 Chưa có dữ liệu trên server. Bắt đầu tạo dữ liệu mới!', 'info')
      }
    } catch (error) {
      console.error('Error loading from server:', error)
      this.updateFileStatus('⚠️ Không thể tải dữ liệu từ server. Sử dụng dữ liệu local.', 'warning')
      this.loadFromLocalStorage()
    }
  }

  async parseExcelData(base64Data) {
    try {
      // Convert base64 to array buffer
      const binaryString = atob(base64Data)
      const bytes = new Uint8Array(binaryString.length)
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i)
      }
      
      const workbook = XLSX.read(bytes, { type: 'array' })
      
      // Load players data
      if (workbook.SheetNames.includes('Players')) {
        const playersSheet = workbook.Sheets['Players']
        const playersData = XLSX.utils.sheet_to_json(playersSheet)
        
        this.players = playersData.map(row => ({
          id: row['ID'] || Date.now() + Math.random(),
          name: row['Tên'] || row['Name'] || '',
          points: parseInt(row['Điểm'] || row['Points'] || 0),
          wins: parseInt(row['Thắng'] || row['Wins'] || 0),
          losses: parseInt(row['Thua'] || row['Losses'] || 0),
          moneyLost: parseInt(row['Tiền mất (VND)'] || row['Money Lost'] || 0)
        })).filter(player => player.name)
      }

      // Load matches data
      if (workbook.SheetNames.includes('Matches')) {
        const matchesSheet = workbook.Sheets['Matches']
        const matchesData = XLSX.utils.sheet_to_json(matchesSheet)
        
        this.matches = matchesData.map(row => ({
          id: row['ID'] || Date.now() + Math.random(),
          date: row['Ngày'] || row['Date'] || new Date().toLocaleString('vi-VN'),
          team1: {
            player1: this.findPlayerByName(row['Đội 1 - Người 1'] || row['Team 1 - Player 1']),
            player2: this.findPlayerByName(row['Đội 1 - Người 2'] || row['Team 1 - Player 2']),
            score: row['Tỷ số đội 1'] || row['Team 1 Score'] || ''
          },
          team2: {
            player1: this.findPlayerByName(row['Đội 2 - Người 1'] || row['Team 2 - Player 1']),
            player2: this.findPlayerByName(row['Đội 2 - Người 2'] || row['Team 2 - Player 2']),
            score: row['Tỷ số đội 2'] || row['Team 2 Score'] || ''
          },
          winner: (row['Đội thắng'] || row['Winner']) === 'Đội 1' || row['Winner'] === 'Team 1' ? 'team1' : 'team2'
        })).filter(match => match.team1.player1 && match.team2.player1)
      }
    } catch (error) {
      console.error('Error parsing Excel data:', error)
      throw error
    }
  }

  findPlayerByName(name) {
    if (!name) return null
    const player = this.players.find(p => p.name === name)
    return player || { id: Date.now() + Math.random(), name: name }
  }

  saveToExcel() {
    try {
      // Prepare players data
      const playersData = this.players.map(player => ({
        'ID': player.id,
        'Tên': player.name,
        'Điểm': player.points,
        'Thắng': player.wins,
        'Thua': player.losses,
        'Tiền mất (VND)': player.moneyLost
      }))

      // Prepare matches data
      const matchesData = this.matches.map(match => ({
        'ID': match.id,
        'Ngày': match.date,
        'Đội 1 - Người 1': match.team1.player1?.name || '',
        'Đội 1 - Người 2': match.team1.player2?.name || '',
        'Tỷ số đội 1': match.team1.score,
        'Đội 2 - Người 1': match.team2.player1?.name || '',
        'Đội 2 - Người 2': match.team2.player2?.name || '',
        'Tỷ số đội 2': match.team2.score,
        'Đội thắng': match.winner === 'team1' ? 'Đội 1' : 'Đội 2'
      }))

      // Create workbook
      const workbook = XLSX.utils.book_new()
      
      // Add players sheet
      const playersSheet = XLSX.utils.json_to_sheet(playersData)
      XLSX.utils.book_append_sheet(workbook, playersSheet, 'Players')
      
      // Add matches sheet
      const matchesSheet = XLSX.utils.json_to_sheet(matchesData)
      XLSX.utils.book_append_sheet(workbook, matchesSheet, 'Matches')

      // Add rankings sheet for viewing
      const rankingsData = [...this.players].sort((a, b) => b.points - a.points)
        .map((player, index) => ({
          'Hạng': index + 1,
          'Tên': player.name,
          'Điểm': player.points,
          'Thắng': player.wins,
          'Thua': player.losses,
          'Tỷ lệ thắng (%)': player.wins + player.losses > 0 
            ? ((player.wins / (player.wins + player.losses)) * 100).toFixed(1)
            : '0.0',
          'Tiền mất (VND)': player.moneyLost
        }))

      const rankingsSheet = XLSX.utils.json_to_sheet(rankingsData)
      XLSX.utils.book_append_sheet(workbook, rankingsSheet, 'Rankings')

      // Download file with better naming
      const now = new Date()
      const timestamp = now.toISOString().slice(0, 10) + '_' + 
                       now.toTimeString().slice(0, 5).replace(':', '-')
      const fileName = `tennis-data_${timestamp}.xlsx`
      
      XLSX.writeFile(workbook, fileName)
      
      this.currentFileName = fileName
      this.updateFileStatus(`💾 Đã lưu file: ${fileName}. 
📁 Vui lòng di chuyển file từ thư mục Downloads vào thư mục dự án nếu cần.`, 'success')
      
    } catch (error) {
      console.error('Error saving Excel file:', error)
      this.updateFileStatus(`❌ Lỗi khi lưu file: ${error.message}`, 'error')
    }
  }

  autoSave() {
    if (this.autoSaveEnabled && (this.players.length > 0 || this.matches.length > 0)) {
      // Only auto-save to localStorage, not Excel files
      // Excel files should be saved manually by user
      localStorage.setItem('tennis-players', JSON.stringify(this.players))
      localStorage.setItem('tennis-matches', JSON.stringify(this.matches))
      
      this.updateFileStatus('💾 Dữ liệu đã được lưu tự động', 'info')
    }
  }

  loadFromLocalStorage() {
    // Fallback for existing users - migrate their data
    const localPlayers = localStorage.getItem('tennis-players')
    const localMatches = localStorage.getItem('tennis-matches')
    
    if (localPlayers) {
      this.players = JSON.parse(localPlayers)
      this.updateFileStatus('📋 Đã tải dữ liệu cũ từ browser. Khuyến nghị lưu ra Excel!', 'info')
    }
    
    if (localMatches) {
      this.matches = JSON.parse(localMatches)
    }
  }

  updateFileStatus(message, type = 'info') {
    const statusDiv = document.getElementById('fileStatus')
    if (statusDiv) {
      statusDiv.textContent = message
      statusDiv.className = `file-status ${type}`
      
      // Auto-hide after 5 seconds
      setTimeout(() => {
        statusDiv.textContent = ''
        statusDiv.className = 'file-status'
      }, 5000)
    }
  }

  refreshAllDisplays() {
    this.renderPlayers()
    this.renderRankings()
    this.renderMatchHistory()
    this.updatePlayerSelects()
  }

  // Match Management Methods
  async editMatch(matchId) {
    const match = this.matches.find(m => m.id === matchId)
    if (!match) return

    const newTeam1Score = prompt('Nhập tỷ số mới cho Đội 1:', match.team1.score || '')
    if (newTeam1Score === null) return // User cancelled

    const newTeam2Score = prompt('Nhập tỷ số mới cho Đội 2:', match.team2.score || '')
    if (newTeam2Score === null) return // User cancelled

    const winnerOptions = `Chọn đội thắng:\n1. ${match.team1.player1.name} & ${match.team1.player2.name}\n2. ${match.team2.player1.name} & ${match.team2.player2.name}`
    const winnerChoice = prompt(winnerOptions + '\n\nNhập 1 hoặc 2:', match.winner === 'team1' ? '1' : '2')
    
    if (winnerChoice !== '1' && winnerChoice !== '2') {
      alert('Lựa chọn không hợp lệ. Hủy chỉnh sửa.')
      return
    }

    // Reverse the old match effects
    this.reverseMatchEffects(match)

    // Update match data
    match.team1.score = newTeam1Score.trim()
    match.team2.score = newTeam2Score.trim()
    match.winner = winnerChoice === '1' ? 'team1' : 'team2'
    match.date = new Date().toLocaleString('vi-VN') + ' (Đã sửa)'

    // Apply new match effects
    this.applyMatchEffects(match)

    await this.saveData()
    this.renderMatchHistory()
    this.renderRankings()
    this.showMessage('✅ Đã cập nhật trận đấu thành công', 'success')
  }

  async deleteMatch(matchId) {
    const match = this.matches.find(m => m.id === matchId)
    if (!match) return

    const confirmMessage = `Bạn có chắc chắn muốn xóa trận đấu này?\n\n` +
      `${match.team1.player1.name} & ${match.team1.player2.name} VS ${match.team2.player1.name} & ${match.team2.player2.name}\n` +
      `Ngày: ${match.date}\n\n` +
      `⚠️ Lưu ý: Điểm và tiền của người chơi sẽ được hoàn lại`

    if (confirm(confirmMessage)) {
      // Reverse match effects before deleting
      this.reverseMatchEffects(match)

      // Remove match from array
      this.matches = this.matches.filter(m => m.id !== matchId)

      await this.saveData()
      this.renderMatchHistory()
      this.renderRankings()
      this.showMessage('✅ Đã xóa trận đấu và hoàn lại điểm', 'success')
    }
  }

  reverseMatchEffects(match) {
    // Get players involved
    const team1Players = [match.team1.player1, match.team1.player2]
    const team2Players = [match.team2.player1, match.team2.player2]
    
    // Determine original winners and losers
    const originalWinners = match.winner === 'team1' ? team1Players : team2Players
    const originalLosers = match.winner === 'team1' ? team2Players : team1Players

    // Reverse winner effects
    originalWinners.forEach(player => {
      const actualPlayer = this.getPlayerById(player.id)
      if (actualPlayer) {
        actualPlayer.points -= 4
        actualPlayer.wins -= 1
      }
    })

    // Reverse loser effects
    originalLosers.forEach(player => {
      const actualPlayer = this.getPlayerById(player.id)
      if (actualPlayer) {
        actualPlayer.points -= 1
        actualPlayer.losses -= 1
        actualPlayer.moneyLost -= 20000
      }
    })
  }

  applyMatchEffects(match) {
    // Get players involved
    const team1Players = [match.team1.player1, match.team1.player2]
    const team2Players = [match.team2.player1, match.team2.player2]
    
    // Determine new winners and losers
    const newWinners = match.winner === 'team1' ? team1Players : team2Players
    const newLosers = match.winner === 'team1' ? team2Players : team1Players

    // Apply winner effects
    newWinners.forEach(player => {
      const actualPlayer = this.getPlayerById(player.id)
      if (actualPlayer) {
        actualPlayer.points += 4
        actualPlayer.wins += 1
      }
    })

    // Apply loser effects
    newLosers.forEach(player => {
      const actualPlayer = this.getPlayerById(player.id)
      if (actualPlayer) {
        actualPlayer.points += 1
        actualPlayer.losses += 1
        actualPlayer.moneyLost += 20000
      }
    })
  }
}

// Initialize the system
window.tennisSystem = new TennisRankingSystem()
