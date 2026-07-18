/**
 * Matches feature — record/edit/delete matches, render match history,
 * update selectors, form reset, winner auto-detection, match type switching.
 */
import { normalizeText } from '../../lib/vietnamese-normalize.js'

export function createMatchesModule(ctx) {
  const {
    apiBase, isAuthenticated, seasons, players, matches, currentMatchType,
    currentWinningTeam, isManualWinnerMode, user,
    escapeHtml, formatDate, formatMoney, showToast,
    invalidateCache, loadMatches, loadPlayDates, renderRankings, getCache, setCache,
    setTodaysDate, updateTeamLabelsForMatchType,
  } = ctx

  /** Render match history table (only if matches tab is active) */
  async function renderMatchHistory() {
    const matchesTab = document.getElementById('matches-tab')
    if (!matchesTab || !matchesTab.classList.contains('active')) return

    const tableBody = document.querySelector('#matchHistoryTable tbody')
    if (!tableBody) return

    let matchList = []
    try {
      const matchHistoryDate = document.getElementById('matchHistoryDate')?.value
      let cacheKey = ''
      let apiUrl = ''

      if (matchHistoryDate) {
        cacheKey = `date:${matchHistoryDate}`
        apiUrl = `${apiBase}/matches/by-date/${matchHistoryDate}`
      } else if (ctx.selectedDate) {
        cacheKey = `date:${ctx.selectedDate}`
        apiUrl = `${apiBase}/matches/by-date/${ctx.selectedDate}`
      } else if (ctx.selectedSeason) {
        cacheKey = `season:${ctx.selectedSeason}`
        apiUrl = `${apiBase}/matches/by-season/${ctx.selectedSeason}`
      } else {
        cacheKey = 'all'
        apiUrl = `${apiBase}/matches`
      }

      matchList = getCache('matches', cacheKey)
      if (!matchList && apiUrl) {
        const response = await fetch(apiUrl)
        if (response.ok) {
          matchList = await response.json()
          setCache('matches', cacheKey, matchList)
        }
      }
      matchList = matchList || []
    } catch (error) {
      console.error('Error loading matches:', error)
    }

    const canEdit = isAuthenticated && (user?.role === 'admin' || user?.role === 'editor')
    const winnerBadge = `<svg class="winner-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg>`

    tableBody.innerHTML = matchList.length === 0
      ? `<tr><td colspan="${canEdit ? 6 : 5}" style="text-align: center; padding: 2rem; color: var(--text-muted);">Không có trận đấu nào</td></tr>`
      : matchList.map(match => {
        const isSolo = match.match_type === 'solo'
        const team1Players = isSolo
          ? match.player1_name
          : `${match.player1_name} & ${match.player2_name}`
        const team2Players = isSolo
          ? match.player3_name
          : `${match.player3_name} & ${match.player4_name}`
        const team1Class = match.winning_team === 1 ? 'winner-cell' : ''
        const team2Class = match.winning_team === 2 ? 'winner-cell' : ''
        const matchMoney = match.lose_money_per_loss ?? 0

        return `
          <tr>
            <td>${formatDate(match.play_date)}</td>
            <td class="${team1Class}">${escapeHtml(team1Players)} ${match.winning_team === 1 ? winnerBadge : ''}</td>
            <td style="text-align: center; font-weight: 600;">${match.team1_score} - ${match.team2_score}</td>
            <td class="${team2Class}">${escapeHtml(team2Players)} ${match.winning_team === 2 ? winnerBadge : ''}</td>
            <td>${formatMoney(matchMoney)}</td>
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

    // Wire up edit/delete buttons
    if (tableBody) {
      tableBody.querySelectorAll('.edit-match-btn').forEach(btn => {
        btn.addEventListener('click', () => ctx.editMatch(parseInt(btn.dataset.matchId)))
      })
      tableBody.querySelectorAll('.delete-match-btn').forEach(btn => {
        btn.addEventListener('click', () => ctx.deleteMatch(parseInt(btn.dataset.matchId)))
      })
    }
  }

  /** Record a single match via the form */
  async function recordMatch() {
    if (!isAuthenticated) { showToast('Cần đăng nhập để ghi nhận kết quả', 'error'); return }

    const playDate = document.getElementById('matchDate')?.value
    const matchType = currentMatchType || 'duo'
    const seasonId = parseInt(document.getElementById('matchSeasonSelect')?.value)
    if (!seasonId) { showToast('Vui lòng chọn mùa giải', 'error'); return }

    const team1Score = parseInt(document.getElementById('team1Score')?.value) || 0
    const team2Score = parseInt(document.getElementById('team2Score')?.value) || 0

    let player1Id, player2Id, player3Id, player4Id
    if (matchType === 'solo') {
      player1Id = parseInt(document.getElementById('player1')?.value)
      player2Id = null
      player3Id = parseInt(document.getElementById('player3')?.value)
      player4Id = null
    } else {
      player1Id = parseInt(document.getElementById('player1')?.value)
      player2Id = parseInt(document.getElementById('player2')?.value)
      player3Id = parseInt(document.getElementById('player3')?.value)
      player4Id = parseInt(document.getElementById('player4')?.value)
    }

    const winnerValue = document.getElementById('winner')?.value
    let winningTeam = winnerValue === 'team1' ? 1 : (winnerValue === 'team2' ? 2 : null)

    // Validation
    if (!playDate) { showToast('Vui lòng chọn ngày đánh', 'error'); return }

    if (matchType === 'solo') {
      if (isNaN(player1Id) || isNaN(player3Id)) { showToast('Vui lòng chọn đủ 2 người chơi', 'error'); return }
      if (player1Id === player3Id) { showToast('Cần 2 người chơi khác nhau', 'error'); return }
    } else {
      if ([player1Id, player2Id, player3Id, player4Id].some(id => isNaN(id))) {
        showToast('Vui lòng chọn đủ 4 người chơi', 'error'); return
      }
      if (Array.from(new Set([player1Id, player2Id, player3Id, player4Id])).length !== 4) {
        showToast('Cần 4 người chơi khác nhau', 'error'); return
      }
    }

    if (team1Score < 0 || team2Score < 0) { showToast('Vui lòng nhập tỷ số hợp lệ', 'error'); return }
    if (!winningTeam && currentWinningTeam) winningTeam = currentWinningTeam
    if (winningTeam !== 1 && winningTeam !== 2) { showToast('Vui lòng chọn đội thắng', 'error'); return }

    try {
      const response = await ctx.makeAuthenticatedRequest(`${apiBase}/matches`, {
        method: 'POST',
        body: JSON.stringify({ seasonId, playDate, player1Id, player2Id, player3Id, player4Id, team1Score, team2Score, winningTeam, matchType })
      })
      const data = await response.json()

      if (response.ok) {
        invalidateCache(['rankings', 'matches', 'playDates'])
        await loadMatches()
        await loadPlayDates()
        ctx.resetMatchForm()
        renderRankings()
        const activeTabId = document.querySelector('.tab-content.active')?.id
        if (activeTabId === 'matches-tab') renderMatchHistory()
        ctx.updateDateSelector()
        showToast('Đã ghi nhận kết quả trận đấu', 'success')
      } else {
        showToast(data.error || 'Lỗi khi ghi nhận kết quả', 'error')
      }
    } catch (error) {
      console.error('Error recording match:', error)
      showToast('Lỗi khi ghi nhận kết quả', 'error')
    }
  }

  /** Edit match — fetch data and show modal */
  async function editMatch(matchId) {
    if (!isAuthenticated) { showToast('Cần đăng nhập để sửa trận đấu', 'error'); return }
    try {
      const response = await fetch(`${apiBase}/matches/${matchId}`, { credentials: 'include' })
      if (!response.ok) { showToast('Không tìm thấy trận đấu', 'error'); return }
      const match = await response.json()
      ctx.showMatchEditModal(match)
    } catch (error) {
      console.error('Error fetching match:', error)
      showToast('Lỗi khi tải thông tin trận đấu', 'error')
    }
  }

  /** Delete match with confirmation */
  async function deleteMatch(matchId) {
    if (!isAuthenticated) { showToast('Cần đăng nhập để xóa trận đấu', 'error'); return }

    const matchInfo = matches.find(m => m.id === matchId)
    const confirmMsg = `Bạn có chắc chắn muốn xóa trận đấu này?\n\n` +
      (matchInfo ?
        `📅 ${formatDate(matchInfo.play_date)}\n` +
        `👥 ${matchInfo.player1_name}${matchInfo.player2_name ? ' & ' + matchInfo.player2_name : ''} vs ${matchInfo.player3_name}${matchInfo.player4_name ? ' & ' + matchInfo.player4_name : ''}\n` +
        `📊 ${matchInfo.team1_score} - ${matchInfo.team2_score}\n\n` : '') +
      `Hành động này không thể hoàn tác.`
    if (!confirm(confirmMsg)) return

    try {
      const response = await ctx.makeAuthenticatedRequest(`${apiBase}/matches/${matchId}`, { method: 'DELETE' })
      const data = await response.json()

      if (response.ok) {
        invalidateCache(['rankings', 'matches', 'playDates'])
        await loadMatches()
        await loadPlayDates()
        renderRankings()
        const activeTabId = document.querySelector('.tab-content.active')?.id
        if (activeTabId === 'matches-tab') renderMatchHistory()
        ctx.updateDateSelector()
        showToast('Đã xóa trận đấu thành công', 'success')
      } else {
        showToast(data.error || 'Lỗi khi xóa trận đấu', 'error')
      }
    } catch (error) {
      console.error('Error deleting match:', error)
      showToast('Lỗi kết nối khi xóa trận đấu', 'error')
    }
  }

  /** Update player dropdowns, optionally filtered by season */
  function updatePlayerSelects() {
    let availablePlayers = players

    if (ctx.selectedMatchSeason && ctx.seasonPlayers?.length > 0) {
      const allowedIds = ctx.seasonPlayers.map(p => p.player_id || p.id)
      availablePlayers = players.filter(p => allowedIds.includes(p.id))
    }

    const options = availablePlayers.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')
    const duoSelects = ['player1', 'player2', 'player3', 'player4']
    const soloSelects = ['soloPlayer1', 'soloPlayer2']

    duoSelects.concat(soloSelects).forEach(id => {
      const select = document.getElementById(id)
      if (select) {
        const currentValue = select.value
        select.innerHTML = `<option value="">Chọn người chơi...</option>${options}`
        if (currentValue && availablePlayers.some(p => p.id === currentValue)) select.value = currentValue
      }
    })
  }

  /** Update match season selector dropdown */
  function updateSeasonSelect() {
    const select = document.getElementById('matchSeasonSelect')
    if (!select) return

    const activeSeasons = seasons.filter(s => s.is_active)
    const options = activeSeasons.map(s => {
      const endStr = s.end_date ? ` (Kết thúc: ${formatDate(s.end_date)})` : ''
      const moneyStr = s.lose_money_per_loss ? ` - ${formatMoney(s.lose_money_per_loss)}/thua` : ''
      return `<option value="${s.id}">${escapeHtml(s.name)}${endStr}${moneyStr}</option>`
    }).join('')

    select.innerHTML = `<option value="">-- Chọn mùa giải trước --</option>${options}`

    if (activeSeasons.length === 1) {
      select.value = activeSeasons[0].id
      onMatchSeasonChange(activeSeasons[0].id)
    }
  }

  /** Handle season change in match form — load eligible players */
  async function onMatchSeasonChange(seasonId) {
    const allSelects = ['player1', 'player2', 'player3', 'player4', 'soloPlayer1', 'soloPlayer2']

    if (!seasonId) {
      allSelects.forEach(id => {
        const select = document.getElementById(id)
        if (select) { select.disabled = true; select.innerHTML = '<option value="">Chọn mùa giải trước...</option>' }
      })
      const infoEl = document.getElementById('selectedSeasonInfo')
      if (infoEl) infoEl.style.display = 'none'
      return
    }

    try {
      const response = await fetch(`${apiBase}/seasons/${seasonId}/players`)
      let seasonPlayers = []
      if (response.ok) seasonPlayers = await response.json()
      if (seasonPlayers.length === 0) seasonPlayers = players

      ctx.currentSeasonPlayers = seasonPlayers
      ctx.selectedMatchSeason = seasonId
      ctx.seasonPlayers = seasonPlayers

      const options = seasonPlayers.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')
      allSelects.forEach(id => {
        const select = document.getElementById(id)
        if (select) { select.disabled = false; select.innerHTML = `<option value="">Chọn người chơi...</option>${options}` }
      })

      const selectedSeason = seasons.find(s => s.id === seasonId)
      if (selectedSeason) {
        const infoEl = document.getElementById('selectedSeasonInfo')
        if (infoEl) {
          const count = seasonPlayers.length !== players.length
            ? `${seasonPlayers.length} người chơi được phép`
            : 'Tất cả người chơi'
          const money = selectedSeason.lose_money_per_loss ?? 20000
          infoEl.innerHTML = `<div class="season-info-badge"><span class="badge-item">💰 ${formatMoney(money)}/trận thua</span><span class="badge-item">👥 ${count}</span></div>`
          infoEl.style.display = 'block'
        }
      }
    } catch (error) {
      console.error('Error loading season players:', error)
      updatePlayerSelects()
    }
  }

  /** Update match history date selector */
  function updateMatchHistoryDateSelector() {
    const selector = document.getElementById('matchHistoryDate')
    if (!selector) return
    const dates = ctx.playDates || []
    selector.innerHTML = '<option value="">Tất cả ngày</option>' + dates.map(d => {
      const dateOnly = d.play_date.split('T')[0]
      return `<option value="${dateOnly}">${formatDate(d.play_date)}</option>`
    }).join('')
  }

  /** Reset match form to initial state */
  function resetMatchForm() {
    const form = document.getElementById('matchForm')
    if (!form) return
    form.reset()
    document.getElementById('matchType').value = 'duo'
    ctx.currentMatchType = 'duo'
    ctx.currentWinningTeam = null

    document.querySelectorAll('.type-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.type === 'duo'))
    document.querySelectorAll('.duo-only').forEach(el => el.style.display = '')
    document.querySelectorAll('.solo-only').forEach(el => el.style.display = 'none')

    const matchSeasonSelect = document.getElementById('matchSeasonSelect')
    if (matchSeasonSelect) matchSeasonSelect.value = ''

    ['player1', 'player2', 'player3', 'player4'].forEach(id => {
      const select = document.getElementById(id)
      if (select) { select.disabled = true; select.innerHTML = '<option value="">Chọn mùa giải trước...</option>' }
    })

    setTodaysDate()
    updateTeamLabelsForMatchType()
  }

  /** Auto-winner detection based on scores */
  function updateAutoWinner() {
    if (isManualWinnerMode) return

    const team1Score = parseInt(document.getElementById('team1Score')?.value) || 0
    const team2Score = parseInt(document.getElementById('team2Score')?.value) || 0
    const winnerSelect = document.getElementById('winner')
    if (!winnerSelect) return

    if (team1Score !== team2Score && (team1Score > 0 || team2Score > 0)) {
      winnerSelect.value = team1Score > team2Score ? 'team1' : 'team2'
      ctx.currentWinningTeam = team1Score > team2Score ? 1 : 2
    } else {
      winnerSelect.value = ''
      ctx.currentWinningTeam = null
    }
  }

  /** Toggle between auto and manual winner selection */
  function toggleWinnerMode(isManual) {
    ctx.isManualWinnerMode = isManual

    const autoDiv = document.querySelector('.auto-winner')
    const manualDiv = document.querySelector('.manual-winner')
    const manualBtn = document.getElementById('useManualWinner')
    const autoBtn = document.getElementById('useAutoWinner')
    const winningTeamSelect = document.getElementById('winningTeam')

    if (isManual) {
      if (autoDiv) autoDiv.classList.add('hidden')
      if (manualDiv) { manualDiv.classList.remove('hidden'); manualDiv.classList.add('flex') }
      if (manualBtn) manualBtn.classList.add('hidden')
      if (autoBtn) { autoBtn.classList.remove('hidden'); autoBtn.classList.add('inline-block') }
    } else {
      if (autoDiv) autoDiv.classList.remove('hidden')
      if (manualDiv) manualDiv.classList.add('hidden')
      if (manualBtn) { manualBtn.classList.remove('hidden'); manualBtn.classList.add('inline-block') }
      if (autoBtn) autoBtn.classList.add('hidden')
      if (winningTeamSelect) winningTeamSelect.value = ''
      updateAutoWinner()
    }
  }

  /** Show match modal (scroll to form) */
  function showMatchModal() {
    ctx.switchTab('matches')
    const matchForm = document.querySelector('#matches-tab .match-form')
    if (matchForm) matchForm.scrollIntoView({ behavior: 'smooth' })
  }

  /** Fuzzy match a name against players — used by screenshot parsing */
  function fuzzyMatchPlayer(name, playerList) {
    if (!name || !playerList?.length) return null
    const normalized = normalizeText(name).toLowerCase().trim()
    if (!normalized) return null

    const index = ctx.normalizedPlayers || playerList.map(p => ({
      normalized: normalizeText(p.name).toLowerCase(), id: p.id, name: p.name
    }))

    const exact = index.find(e => e.normalized === normalized)
    if (exact) return exact.id

    const substring = index.find(e => e.normalized.includes(normalized) || normalized.includes(e.normalized))
    if (substring) return substring.id

    const words = normalized.split(/\s+/)
    if (words.length >= 2) {
      const lastWord = words[words.length - 1]
      const nickMatch = index.find(e => {
        const dbWords = e.normalized.split(/\s+/)
        return dbWords.some(w => w === lastWord || lastWord.startsWith(w) || w.startsWith(lastWord))
      })
      if (nickMatch) return nickMatch.id
    }

    const firstWord = words[0]
    const firstMatch = index.find(e => {
      const dbWords = e.normalized.split(/\s+/)
      return dbWords.some(w => w === firstWord || firstWord.startsWith(w) || w.startsWith(firstWord))
    })
    if (firstMatch) return firstMatch.id

    if (words.length > 3 || normalized.length <= 20) {
      let bestScore = Infinity
      let bestPlayer = null
      for (const entry of index) {
        const score = levenshteinDistance(normalized, entry.normalized)
        if (score < bestScore && score <= 3) { bestScore = score; bestPlayer = entry.id }
      }
      if (bestPlayer) return bestPlayer
    }

    return null
  }

  function levenshteinDistance(a, b) {
    const matrix = Array.from({ length: b.length + 1 }, (_, i) =>
      Array.from({ length: a.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
    )
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1]
        } else {
          matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
        }
      }
    }
    return matrix[b.length][a.length]
  }

  /** Score a word against a player name (0-10) */
  function _scoreWordAgainstPlayer(word, playerNorm) {
    if (word === playerNorm) return 10
    const playerWords = playerNorm.split(/\s+/)
    if (playerWords.length > 0 && word === playerWords[playerWords.length - 1]) return 10
    if (playerWords.length > 0 && word === playerWords[0]) return 7
    if (playerNorm.includes(word)) return 7
    if (playerWords.length > 0 && playerWords[playerWords.length - 1].startsWith(word)) return 5
    if (playerWords.length > 0 && word.startsWith(playerWords[playerWords.length - 1])) return 5
    return 0
  }

  /** Map team nickname to player pair */
  function mapTeamToPlayerPair(teamName, playerList) {
    if (!teamName || !playerList?.length) return null
    const normalized = normalizeText(teamName).toLowerCase().trim()
    if (!normalized) return null

    const words = normalized.split(/\s+/)
    if (words.length === 0) return null

    const index = ctx.normalizedPlayers || playerList.map(p => ({
      normalized: normalizeText(p.name).toLowerCase(), id: p.id, name: p.name
    }))

    const candidates = index.map(entry => {
      let totalScore = 0
      for (const word of words) totalScore += _scoreWordAgainstPlayer(word, entry.normalized)
      return { id: entry.id, name: entry.name, score: totalScore }
    }).filter(p => p.score > 0)

    if (candidates.length === 0) return null

    // Single perfect match
    const singlePerfect = candidates.find(p => {
      if (words.length > 1) return false
      let coverage = 0
      for (const word of words) {
        if (_scoreWordAgainstPlayer(word, normalizeText(p.name).toLowerCase()) > 0) coverage++
      }
      return coverage === words.length && candidates.length <= 2
    })
    if (singlePerfect && candidates.length <= 2) return { player1Id: singlePerfect.id, player2Id: null }

    // Best pair
    let bestPair = null
    let bestTotal = -1
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i], b = candidates[j]
        let covered = 0
        for (const word of words) {
          const aS = _scoreWordAgainstPlayer(word, normalizeText(a.name).toLowerCase())
          const bS = _scoreWordAgainstPlayer(word, normalizeText(b.name).toLowerCase())
          if (aS > 0 || bS > 0) covered++
        }
        const total = a.score + b.score + (covered === words.length ? 20 : 0)
        if (total > bestTotal) { bestTotal = total; bestPair = { player1Id: a.id, player2Id: b.id } }
      }
    }

    if (bestPair && bestTotal >= words.length * 3) return bestPair
    if (candidates.length > 0) {
      const best = candidates.reduce((a, b) => (a.score > b.score ? a : b))
      return { player1Id: best.id, player2Id: null }
    }
    return null
  }

  return {
    renderMatchHistory, recordMatch, editMatch, deleteMatch,
    updatePlayerSelects, updateSeasonSelect, onMatchSeasonChange,
    updateMatchHistoryDateSelector, resetMatchForm,
    updateAutoWinner, toggleWinnerMode, showMatchModal,
    fuzzyMatchPlayer, levenshteinDistance, _scoreWordAgainstPlayer, mapTeamToPlayerPair,
  }
}
