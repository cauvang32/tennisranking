/**
 * Screenshot feature — AI screenshot upload, parsed match preview,
 * and bulk confirmation via /matches/bulk-create.
 *
 * Extracted from src/main.js (lines ~1900–2700, ~431–438).
 */

export function createScreenshotModule(ctx) {
  const {
    apiBase,
    escapeHtml,
    showToast,
    makeAuthenticatedRequest,
    invalidateCache,
    loadMatches,
    loadPlayDates,
    renderRankings,
    renderMatchHistory,
    updateDateSelector,
  } = ctx

  // NOTE: ctx.user, ctx.players, ctx.seasons, ctx.playDates are mutable — read from ctx, not closure

  /** Read a file as base64 string (without data URI prefix) */
  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const base64 = reader.result?.split?.(',')[1] || reader.result
        resolve(base64)
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  /** Handle file selection from screenshot upload */
  async function handleScreenshotUpload(event) {
    const file = event.target.files?.[0]
    if (!file) return

    const fileNameEl = document.getElementById('screenshotFileName')
    const statusEl = document.getElementById('screenshotStatus')
    const clearBtn = document.getElementById('clearScreenshotBtn')
    const resultsSection = document.getElementById('parsedResultsSection')

    if (fileNameEl) fileNameEl.textContent = file.name
    if (clearBtn) clearBtn.style.display = ''
    if (statusEl) {
      statusEl.textContent = 'Đang phân tích...'
      statusEl.style.color = 'var(--text-secondary)'
    }
    if (resultsSection) resultsSection.style.display = 'none'

    try {
      const base64 = await readFileAsBase64(file)

      const response = await makeAuthenticatedRequest(`${apiBase}/matches/parse-image`, {
        method: 'POST',
        body: JSON.stringify({ imageBase64: base64, mimeType: file.type })
      })

      if (!response.ok) {
        const error = await response.json()
        if (statusEl) {
          statusEl.textContent = `❌ ${error.error || 'Phân tích thất bại'}`
          statusEl.style.color = 'var(--error-color)'
        }
        return
      }

      const data = await response.json()
      ctx.parsedMatchesBuffer = data.matches || []

      if (statusEl) {
        statusEl.textContent = `✅ Đã trích xuất ${ctx.parsedMatchesBuffer.length} trận đấu. Vui lòng kiểm tra và xác nhận.`
        statusEl.style.color = 'var(--success-color)'
      }

      if (ctx.parsedMatchesBuffer.length > 0) {
        renderParsedMatchesTable()
        if (resultsSection) resultsSection.style.display = ''
      } else {
        if (statusEl) statusEl.textContent = '⚠️ Không tìm thấy trận đấu nào trong hình ảnh.'
      }
    } catch (error) {
      console.error('Screenshot upload error:', error)
      if (statusEl) {
        statusEl.textContent = 'Lỗi khi tải lên hình ảnh.'
        statusEl.style.color = 'var(--error-color)'
      }
    } finally {
      if (event.target) event.target.value = ''
    }
  }

  /** Clear the screenshot upload UI and buffer */
  function clearScreenshot() {
    const fileInput = document.getElementById('screenshotFile')
    const fileNameEl = document.getElementById('screenshotFileName')
    const statusEl = document.getElementById('screenshotStatus')
    const resultsSection = document.getElementById('parsedResultsSection')
    const clearBtn = document.getElementById('clearScreenshotBtn')

    if (fileInput) fileInput.value = ''
    if (fileNameEl) fileNameEl.textContent = ''
    if (statusEl) {
      statusEl.textContent = ''
      statusEl.style.color = ''
    }
    if (resultsSection) resultsSection.style.display = 'none'
    if (clearBtn) clearBtn.style.display = 'none'
    ctx.parsedMatchesBuffer = []

    // Also clear batch state
    ctx.batchMatches = []
    ctx.batchMatchId = 0
    const batchSection = document.getElementById('batchSection')
    if (batchSection) batchSection.style.display = 'none'
  }

  /** Cancel and hide the parsed results section */
  function cancelParsedMatches() {
    clearScreenshot()
  }

  /** Render parsed matches into preview cards with player dropdowns pre-filled
   *  via fuzzy matching. Each card has its own season/date selectors. */
  function renderParsedMatchesTable() {
    const container = document.getElementById('parsedCardsContainer')
    if (!container) return

    const activeSeasons = (ctx.seasons || []).filter(s => s.is_active)
    const today = new Date().toISOString().split('T')[0]
    const latestPlayDate = ctx.playDates?.[0]?.play_date?.split('T')[0] || today
    const latestSeasonId = activeSeasons.length > 0 ? activeSeasons[0].id : null
    const seasonOptions = activeSeasons.map(s => {
      const sel = s.id === latestSeasonId ? ' selected' : ''
      return `<option value="${s.id}"${sel}>${escapeHtml(s.name)}</option>`
    }).join('')

    const buildOptions = (selectedId) => {
      const options = ctx.players.map(p => {
        const sel = p.id === selectedId ? ' selected' : ''
        return `<option value="${p.id}"${sel}>${escapeHtml(p.name)}</option>`
      }).join('')
      return `<option value="">-- Chọn --</option>${options}`
    }

    container.innerHTML = ctx.parsedMatchesBuffer.map((match, index) => {
      const isSolo = match.matchType === 'solo'
      const typeLabel = isSolo ? '1v1' : '2v2'

      if (isSolo) {
        const player1Id = ctx.fuzzyMatchPlayer(match.player1Name, ctx.players)
        const player3Id = ctx.fuzzyMatchPlayer(match.player3Name, ctx.players)

        return `
          <div class="match-card parsed-match-card" data-index="${index}" data-match-type="solo">
            <div class="match-card-header">
              <span class="match-type-badge">${typeLabel}</span>
              <button class="match-delete-btn" data-parsed-remove="${index}" title="Xoá trận đấu">✕</button>
            </div>
            <div class="match-teams">
              <div class="match-team match-team-1">
                <span class="match-team-label">Đội 1</span>
                <div class="match-player-selects">
                  <select class="select-field" data-field="player1Id">${buildOptions(player1Id)}</select>
                </div>
              </div>
              <div class="match-score">
                <input type="number" class="input-field score-field" data-field="team1Score" value="${match.team1Score}" min="0" placeholder="0">
                <span class="score-separator">:</span>
                <input type="number" class="input-field score-field" data-field="team2Score" value="${match.team2Score}" min="0" placeholder="0">
              </div>
              <div class="match-team match-team-2">
                <span class="match-team-label">Đội 2</span>
                <div class="match-player-selects">
                  <select class="select-field" data-field="player3Id">${buildOptions(player3Id)}</select>
                </div>
              </div>
            </div>
            <div class="match-footer">
              <select class="select-field match-winner-select" data-field="winningTeam">
                <option value="">Chọn đội thắng</option>
                <option value="1" ${match.winningTeam === 1 ? 'selected' : ''}>Đội 1</option>
                <option value="2" ${match.winningTeam === 2 ? 'selected' : ''}>Đội 2</option>
              </select>
              <select class="select-field match-season-select" data-field="seasonId">
                <option value="">-- Chọn --</option>
                ${seasonOptions}
              </select>
              <input type="date" class="input-field match-date-input" data-field="playDate" value="${latestPlayDate}">
            </div>
          </div>
        `
      }

      // ── Duo match ──
      const team1Pair = ctx.mapTeamToPlayerPair(
        [match.player1Name, match.player2Name].filter(Boolean).join(' '),
        ctx.players
      )
      const team2Pair = ctx.mapTeamToPlayerPair(
        [match.player3Name, match.player4Name].filter(Boolean).join(' '),
        ctx.players
      )

      const team1P1 = team1Pair?.player1Id || null
      const team1P2 = team1Pair?.player2Id || null
      const team2P1 = team2Pair?.player1Id || null
      const team2P2 = team2Pair?.player2Id || null

      const buildTeamLabel = (pair) => {
        if (!pair) return ''
        const names = [pair.player1Id, pair.player2Id]
          .filter(id => id)
          .map(id => {
            const p = ctx.players.find(pl => pl.id === id)
            return p ? p.name : ''
          })
          .filter(Boolean)
        return names.join(' + ')
      }

      const team1Label = escapeHtml(buildTeamLabel(team1Pair))
      const team2Label = escapeHtml(buildTeamLabel(team2Pair))

      const player2Html = team1P2 ? `<select class="select-field" data-field="player2Id">${buildOptions(team1P2)}</select>` : ''
      const player4Html = team2P2 ? `<select class="select-field" data-field="player4Id">${buildOptions(team2P2)}</select>` : ''
      const label1Html = team1Label ? `<span class="match-player-label">${team1Label}</span>` : ''
      const label2Html = team2Label ? `<span class="match-player-label">${team2Label}</span>` : ''

      return `
        <div class="match-card parsed-match-card" data-index="${index}" data-match-type="duo">
          <div class="match-card-header">
            <span class="match-type-badge">${typeLabel}</span>
            <button class="match-delete-btn" data-parsed-remove="${index}" title="Xoá trận đấu">✕</button>
          </div>
          <div class="match-teams">
            <div class="match-team match-team-1">
              <span class="match-team-label">Đội 1</span>
              <div class="match-player-selects">
                <select class="select-field" data-field="player1Id">${buildOptions(team1P1)}</select>
                ${player2Html}
                ${label1Html}
              </div>
            </div>
            <div class="match-score">
              <input type="number" class="input-field score-field" data-field="team1Score" value="${match.team1Score}" min="0" placeholder="0">
              <span class="score-separator">:</span>
              <input type="number" class="input-field score-field" data-field="team2Score" value="${match.team2Score}" min="0" placeholder="0">
            </div>
            <div class="match-team match-team-2">
              <span class="match-team-label">Đội 2</span>
              <div class="match-player-selects">
                <select class="select-field" data-field="player3Id">${buildOptions(team2P1)}</select>
                ${player4Html}
                ${label2Html}
              </div>
            </div>
          </div>
          <div class="match-footer">
            <select class="select-field match-winner-select" data-field="winningTeam">
              <option value="">Chọn đội thắng</option>
              <option value="1" ${match.winningTeam === 1 ? 'selected' : ''}>Đội 1</option>
              <option value="2" ${match.winningTeam === 2 ? 'selected' : ''}>Đội 2</option>
            </select>
            <select class="select-field match-season-select" data-field="seasonId">
              <option value="">-- Chọn --</option>
              ${seasonOptions}
            </select>
            <input type="date" class="input-field match-date-input" data-field="playDate" value="${latestPlayDate}">
          </div>
        </div>
      `
    }).join('')

    // Wire up remove buttons
    container.querySelectorAll('[data-parsed-remove]').forEach(btn => {
      const idx = parseInt(btn.dataset.parsedRemove, 10)
      btn.addEventListener('click', () => removeParsedMatchRow(idx))
    })

    // Sync all field changes back to ctx.parsedMatchesBuffer in real time
    container.querySelectorAll('.match-card').forEach(card => {
      const matchIndex = parseInt(card.dataset.index, 10)
      card.querySelectorAll('.select-field, .input-field').forEach(field => {
        field.addEventListener('input', () => {
          const fieldName = field.dataset.field
          if (!fieldName || !ctx.parsedMatchesBuffer[matchIndex]) return
          const match = ctx.parsedMatchesBuffer[matchIndex]
          if (['player1Id', 'player2Id', 'player3Id', 'player4Id'].includes(fieldName)) {
            match[fieldName] = field.value ? parseInt(field.value, 10) : null
          } else if (['team1Score', 'team2Score'].includes(fieldName)) {
            match[fieldName] = parseInt(field.value) || 0
          } else if (fieldName === 'winningTeam') {
            match.winningTeam = field.value ? parseInt(field.value, 10) : null
          } else if (fieldName === 'seasonId') {
            match.seasonId = field.value ? parseInt(field.value, 10) : null
          } else if (fieldName === 'playDate') {
            match.playDate = field.value || null
          }
        })
      })
    })
  }

  /** Remove a parsed match row by index */
  function removeParsedMatchRow(index) {
    ctx.parsedMatchesBuffer.splice(index, 1)
    renderParsedMatchesTable()
  }

  /** Bulk confirm all parsed matches and create them in the database */
  async function confirmParsedMatches() {
    const container = document.getElementById('parsedCardsContainer')
    if (!container || !ctx.parsedMatchesBuffer.length) {
      showToast('Không có dữ liệu để xác nhận', 'error')
      return
    }

    const cards = container.querySelectorAll('.match-card')
    const matches = []

    for (const card of cards) {
      // Read matchType from DOM (dataset) to avoid stale indices after removal
      const isSolo = card.dataset.matchType === 'solo'

      const player1Id = parseInt(card.querySelector('[data-field="player1Id"]')?.value)
      const player2Id = parseInt(card.querySelector('[data-field="player2Id"]')?.value)
      const player3Id = parseInt(card.querySelector('[data-field="player3Id"]')?.value)
      const player4Id = parseInt(card.querySelector('[data-field="player4Id"]')?.value)
      const team1Score = parseInt(card.querySelector('[data-field="team1Score"]')?.value) || 0
      const team2Score = parseInt(card.querySelector('[data-field="team2Score"]')?.value) || 0
      const winningTeam = parseInt(card.querySelector('[data-field="winningTeam"]')?.value)
      const seasonId = parseInt(card.querySelector('[data-field="seasonId"]')?.value)
      const playDate = card.querySelector('[data-field="playDate"]')?.value

      if (!seasonId || !playDate) {
        showToast('Vui lòng chọn mùa giải và ngày cho tất cả trận', 'error')
        return
      }

      if (winningTeam !== 1 && winningTeam !== 2) {
        showToast('Vui lòng chọn đội thắng cho tất cả trận', 'error')
        return
      }

      if (isSolo) {
        if (isNaN(player1Id) || isNaN(player3Id) || player1Id === player3Id) {
          showToast('Vui lòng chọn 2 người chơi khác nhau', 'error')
          return
        }
        matches.push({
          seasonId, playDate, player1Id, player2Id: null, player3Id, player4Id: null,
          team1Score, team2Score, winningTeam, matchType: 'solo'
        })
      } else {
        if ([player1Id, player2Id, player3Id, player4Id].some(id => isNaN(id))) {
          showToast('Vui lòng chọn đủ 4 người chơi', 'error')
          return
        }
        if (new Set([player1Id, player2Id, player3Id, player4Id]).size !== 4) {
          showToast('Cần 4 người chơi khác nhau', 'error')
          return
        }
        matches.push({
          seasonId, playDate, player1Id, player2Id, player3Id, player4Id,
          team1Score, team2Score, winningTeam, matchType: 'duo'
        })
      }
    }

    // Send bulk create request
    try {
      const response = await makeAuthenticatedRequest(`${apiBase}/matches/bulk-create`, {
        method: 'POST',
        body: JSON.stringify({ matches })
      })

      const data = await response.json()

      if (response.ok) {
        invalidateCache(['rankings', 'matches', 'playDates'])
        await loadMatches()
        await loadPlayDates()
        renderRankings()
        const activeTabId = document.querySelector('.tab-content.active')?.id
        if (activeTabId === 'matches-tab') {
          renderMatchHistory()
        }
        updateDateSelector()

        clearScreenshot()

        const created = data.created || matches.length
        showToast(`Đã ghi nhận ${created} trận đấu từ ảnh`, 'success')
      } else {
        showToast(data.error || 'Lỗi khi ghi nhận kết quả', 'error')
      }
    } catch (error) {
      console.error('Bulk create error:', error)
      showToast('Lỗi kết nối khi ghi nhận kết quả', 'error')
    }
  }

  /** Show/hide the screenshot upload section based on user role */
  function updateScreenshotSectionVisibility() {
    const section = document.getElementById('screenshotSection')
    if (!section) return
    const canUse = ctx.user?.role === 'admin' || ctx.user?.role === 'editor'
    section.style.display = canUse ? '' : 'none'
    if (!canUse) clearScreenshot()
  }

  return {
    handleScreenshotUpload,
    readFileAsBase64,
    clearScreenshot,
    cancelParsedMatches,
    renderParsedMatchesTable,
    removeParsedMatchRow,
    confirmParsedMatches,
    updateScreenshotSectionVisibility,
  }
}
