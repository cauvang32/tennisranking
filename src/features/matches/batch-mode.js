/**
 * Batch-mode feature — batch match creation UI: mode switching,
 * batch section show/hide, player dropdowns, match cards table,
 * add/remove rows, and bulk-create submission.
 */

export function createBatchModeModule(ctx) {
  const {
    apiBase,
    escapeHtml,
    showToast,
    invalidateCache,
    loadMatches,
    loadPlayDates,
    renderRankings,
    renderMatchHistory,
    updateDateSelector,
    makeAuthenticatedRequest,
  } = ctx

  /** Switch UI to single-match mode (hide batch, show form) */
  function switchToSingleMode() {
    ctx.currentViewMode = 'single'
    const singleBtn = document.getElementById('modeSingleBtn')
    const batchBtn = document.getElementById('modeBatchBtn')
    const matchTypeArea = document.getElementById('matchTypeToggleArea')
    const batchSection = document.getElementById('batchSection')
    const matchForm = document.getElementById('matchForm')
    const screenshotSection = document.getElementById('screenshotSection')

    if (singleBtn) singleBtn.classList.add('active')
    if (batchBtn) batchBtn.classList.remove('active')
    if (matchTypeArea) matchTypeArea.style.display = ''
    if (batchSection) batchSection.style.display = 'none'
    if (matchForm) matchForm.style.display = ''
    if (screenshotSection) screenshotSection.style.display = ''

    // Reset batch state
    ctx.batchMatches = []
    ctx.batchMatchId = 0
  }

  /** Switch UI to batch-match mode (hide form, show batch) */
  function switchToBatchMode() {
    ctx.currentViewMode = 'batch'
    const singleBtn = document.getElementById('modeSingleBtn')
    const batchBtn = document.getElementById('modeBatchBtn')
    const matchTypeArea = document.getElementById('matchTypeToggleArea')
    const batchSection = document.getElementById('batchSection')
    const matchForm = document.getElementById('matchForm')
    const screenshotSection = document.getElementById('screenshotSection')

    if (singleBtn) singleBtn.classList.remove('active')
    if (batchBtn) batchBtn.classList.add('active')
    if (matchTypeArea) matchTypeArea.style.display = 'none'
    if (batchSection) showBatchSection()
    if (matchForm) matchForm.style.display = 'none'
    if (screenshotSection) screenshotSection.style.display = 'none'
  }

  /** Show and initialise the batch match creation section */
  function showBatchSection() {
    const section = document.getElementById('batchSection')
    if (!section) return
    section.style.display = ''

    // Populate shared season selector — use `selected` on the option, not `value` on select
    const batchSeasonSelect = document.getElementById('batchSeasonSelect')
    const batchDateInput = document.getElementById('batchDateInput')
    if (batchSeasonSelect) {
      const activeSeasons = (ctx.seasons || []).filter(s => s.is_active)
      const latestSeasonId = activeSeasons.length > 0 ? activeSeasons[0].id : null
      const options = activeSeasons.map(s => {
        const sel = s.id === latestSeasonId ? ' selected' : ''
        return `<option value="${s.id}"${sel}>${escapeHtml(s.name)}</option>`
      }).join('')
      batchSeasonSelect.innerHTML = `<option value="">-- Chọn --</option>${options}`
    }
    if (batchDateInput) {
      const latestPlayDate = ctx.playDates?.[0]?.play_date?.split('T')[0] || new Date().toISOString().split('T')[0]
      batchDateInput.value = latestPlayDate
    }

    renderBatchMatchesTable()
  }

  /** Hide the batch match creation section */
  function hideBatchSection() {
    const section = document.getElementById('batchSection')
    if (section) section.style.display = 'none'
    ctx.batchMatches = []
    ctx.batchMatchId = 0
    // Switch back to single mode
    switchToSingleMode()
  }

  /** Build <option> strings for a player dropdown, pre-selecting selectedId */
  function _buildPlayerOptions(selectedId) {
    const options = (ctx.players || []).map(p => {
      const sel = p.id === selectedId ? ' selected' : ''
      return `<option value="${p.id}"${sel}>${escapeHtml(p.name)}</option>`
    }).join('')
    return `<option value="">-- Chọn --</option>${options}`
  }

  /** Render the batch matches table */
  function renderBatchMatchesTable() {
    const container = document.getElementById('batchCardsContainer')
    if (!container) return

    container.innerHTML = ctx.batchMatches.map((match, index) => {
      const isSolo = match.matchType === 'solo'
      const typeLabel = isSolo ? '1v1' : '4v4'
      const player2Options = isSolo ? '' : `<select class="select-field" data-field="player2Id">${_buildPlayerOptions(match.player2Id)}</select>`
      const player4Options = isSolo ? '' : `<select class="select-field" data-field="player4Id">${_buildPlayerOptions(match.player4Id)}</select>`

      return `
        <div class="match-card" data-batch-index="${index}" data-match-type="${isSolo ? 'solo' : 'duo'}">
          <div class="match-card-header">
            <span class="match-type-badge">${typeLabel}</span>
            <button class="match-delete-btn" data-batch-remove="${index}" title="Xoá trận đấu">✕</button>
          </div>
          <div class="match-teams">
            <!-- Team 1 -->
            <div class="match-team match-team-1">
              <span class="match-team-label">Đội 1</span>
              <div class="match-player-selects">
                <select class="select-field" data-field="player1Id">${_buildPlayerOptions(match.player1Id)}</select>
                ${player2Options}
              </div>
            </div>
            <!-- Score -->
            <div class="match-score">
              <input type="number" class="input-field score-field" data-field="team1Score" value="${match.team1Score}" min="0" placeholder="0">
              <span class="score-separator">:</span>
              <input type="number" class="input-field score-field" data-field="team2Score" value="${match.team2Score}" min="0" placeholder="0">
            </div>
            <!-- Team 2 -->
            <div class="match-team match-team-2">
              <span class="match-team-label">Đội 2</span>
              <div class="match-player-selects">
                <select class="select-field" data-field="player3Id">${_buildPlayerOptions(match.player3Id)}</select>
                ${player4Options}
              </div>
            </div>
          </div>
          <div class="match-footer">
            <select class="select-field match-winner-select" data-field="winningTeam">
              <option value="">Chọn đội thắng</option>
              <option value="1" ${match.winningTeam === 1 ? 'selected' : ''}>Đội 1</option>
              <option value="2" ${match.winningTeam === 2 ? 'selected' : ''}>Đội 2</option>
            </select>
          </div>
        </div>
      `
    }).join('')

    // Wire up remove buttons
    container.querySelectorAll('[data-batch-remove]').forEach(btn => {
      const idx = parseInt(btn.dataset.batchRemove, 10)
      btn.addEventListener('click', () => removeBatchMatchRow(idx))
    })

    // Wire up auto-winner on score input
    container.querySelectorAll('.match-card').forEach(card => {
      const team1ScoreInput = card.querySelector('[data-field="team1Score"]')
      const team2ScoreInput = card.querySelector('[data-field="team2Score"]')
      const winningTeamSelect = card.querySelector('[data-field="winningTeam"]')
      const matchIndex = parseInt(card.dataset.batchIndex, 10)

      const updateBatchRowWinner = () => {
        if (!winningTeamSelect) return
        const team1Score = parseInt(team1ScoreInput?.value) || 0
        const team2Score = parseInt(team2ScoreInput?.value) || 0

        if (team1Score !== team2Score && (team1Score > 0 || team2Score > 0)) {
          const winningTeam = team1Score > team2Score ? 1 : 2
          winningTeamSelect.value = winningTeam
          ctx.batchMatches[matchIndex].winningTeam = winningTeam
        } else {
          winningTeamSelect.value = ''
        }
      }

      team1ScoreInput?.addEventListener('input', updateBatchRowWinner)
      team2ScoreInput?.addEventListener('input', updateBatchRowWinner)
    })
  }

  /** Add a new batch match row with default values (uses batchMatchType) */
  function addBatchMatchRow() {
    ctx.batchMatches.push({
      matchType: ctx.batchMatchType,
      player1Id: null,
      player2Id: null,
      player3Id: null,
      player4Id: null,
      team1Score: 0,
      team2Score: 0,
      winningTeam: 1
    })
    renderBatchMatchesTable()
  }

  /** Remove a batch match row by index */
  function removeBatchMatchRow(index) {
    ctx.batchMatches.splice(index, 1)
    renderBatchMatchesTable()
  }

  /** Validate and send all batch matches to the server */
  async function confirmBatchMatches() {
    const container = document.getElementById('batchCardsContainer')
    if (!container || !ctx.batchMatches.length) {
      showToast('Vui lòng thêm ít nhất một trận đấu', 'error')
      return
    }

    // Read shared season and date
    const batchSeasonSelect = document.getElementById('batchSeasonSelect')
    const batchDateInput = document.getElementById('batchDateInput')
    const seasonId = parseInt(batchSeasonSelect?.value)
    const playDate = batchDateInput?.value

    if (!seasonId || !playDate) {
      showToast('Vui lòng chọn mùa giải và ngày', 'error')
      return
    }

    const cards = container.querySelectorAll('.match-card')
    const matches = []

    for (const card of cards) {
      const index = parseInt(card.dataset.batchIndex, 10)
      const match = ctx.batchMatches[index]

      const player1Id = parseInt(card.querySelector('[data-field="player1Id"]')?.value)
      const player2Id = parseInt(card.querySelector('[data-field="player2Id"]')?.value)
      const player3Id = parseInt(card.querySelector('[data-field="player3Id"]')?.value)
      const player4Id = parseInt(card.querySelector('[data-field="player4Id"]')?.value)
      const team1Score = parseInt(card.querySelector('[data-field="team1Score"]')?.value) || 0
      const team2Score = parseInt(card.querySelector('[data-field="team2Score"]')?.value) || 0
      let winningTeam = parseInt(card.querySelector('[data-field="winningTeam"]')?.value)

      const isSolo = match.matchType === 'solo'

      // If winner not manually selected, derive from scores (same as single match)
      if (winningTeam !== 1 && winningTeam !== 2) {
        if (team1Score > team2Score) {
          winningTeam = 1
        } else if (team2Score > team1Score) {
          winningTeam = 2
        } else {
          // Tied scores — can't determine winner, require manual selection
          showToast(`Vui lòng chọn đội thắng cho trận ${index + 1} (hòa — chưa xác định được người thắng)`, 'error')
          return
        }
        // Update the batch match data so the dropdown reflects the derived value
        ctx.batchMatches[index].winningTeam = winningTeam
      }

      if (isSolo) {
        if (isNaN(player1Id) || isNaN(player3Id) || player1Id === player3Id) {
          showToast(`Vui lòng chọn 2 người chơi khác nhau cho trận ${index + 1}`, 'error')
          return
        }
        matches.push({
          seasonId, playDate, player1Id, player2Id: null, player3Id, player4Id: null,
          team1Score, team2Score, winningTeam, matchType: 'solo'
        })
      } else {
        if ([player1Id, player2Id, player3Id, player4Id].some(id => isNaN(id))) {
          showToast(`Vui lòng chọn đủ 4 người chơi cho trận ${index + 1}`, 'error')
          return
        }
        if (new Set([player1Id, player2Id, player3Id, player4Id]).size !== 4) {
          showToast(`Cần 4 người chơi khác nhau cho trận ${index + 1}`, 'error')
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
        // Only refresh match history if user is on the matches tab
        const activeTabId = document.querySelector('.tab-content.active')?.id
        if (activeTabId === 'matches-tab') {
          renderMatchHistory()
        }
        updateDateSelector()

        hideBatchSection()

        const created = data.created || matches.length
        showToast(`Đã ghi nhận ${created} trận đấu`, 'success')
      } else {
        showToast(data.error || 'Lỗi khi ghi nhận kết quả', 'error')
      }
    } catch (error) {
      console.error('Batch create error:', error)
      showToast('Lỗi kết nối khi ghi nhận kết quả', 'error')
    }
  }

  return {
    switchToSingleMode,
    switchToBatchMode,
    showBatchSection,
    hideBatchSection,
    _buildPlayerOptions,
    renderBatchMatchesTable,
    addBatchMatchRow,
    removeBatchMatchRow,
    confirmBatchMatches,
  }
}
