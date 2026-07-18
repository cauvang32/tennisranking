/**
 * Match edit modal — creates a modal DOM for editing a match,
 * populates form fields from match data, wires up submit/close handlers.
 * Handles both solo (1v1) and duo (2v2) match types.
 */

export function createMatchModalModule(ctx) {
  const {
    apiBase,
    players,
    seasons,
    makeAuthenticatedRequest,
    escapeHtml,
    showToast,
    invalidateCache,
    loadMatches,
    loadPlayDates,
    renderRankings,
    renderMatchHistory,
    updateDateSelector,
  } = ctx

  // NOTE: ctx.isAuthenticated is mutable — read from ctx, not closure

  /**
   * Show the match edit modal.
   * @param {Object} match - The match object fetched from the server.
   */
  function showMatchEditModal(match) {
    if (!ctx.isAuthenticated) {
      showToast('Cần đăng nhập để sửa trận đấu', 'error')
      return
    }

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
                ${seasons.map(season =>
                  `<option value="${season.id}" ${season.id === match.season_id ? 'selected' : ''}>${escapeHtml(season.name)}</option>`
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
                  ${players.map(player =>
                    `<option value="${player.id}" ${player.id === match.player1_id ? 'selected' : ''}>${escapeHtml(player.name)}</option>`
                  ).join('')}
                </select>
              </div>
              ${!isSolo ? `
              <div class="form-group">
                <label for="editPlayer2">Người chơi 2</label>
                <select id="editPlayer2" required>
                  ${players.map(player =>
                    `<option value="${player.id}" ${player.id === match.player2_id ? 'selected' : ''}>${escapeHtml(player.name)}</option>`
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
                  ${players.map(player =>
                    `<option value="${player.id}" ${player.id === match.player3_id ? 'selected' : ''}>${escapeHtml(player.name)}</option>`
                  ).join('')}
                </select>
              </div>
              ${!isSolo ? `
              <div class="form-group">
                <label for="editPlayer4">Người chơi 4</label>
                <select id="editPlayer4" required>
                  ${players.map(player =>
                    `<option value="${player.id}" ${player.id === match.player4_id ? 'selected' : ''}>${escapeHtml(player.name)}</option>`
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

    // Close on backdrop click
    modal.querySelector('.modal-backdrop').addEventListener('click', () => {
      closeModal()
    })

    // Close button handler
    document.getElementById('closeEditModal').addEventListener('click', () => {
      closeModal()
    })

    // Cancel button handler
    document.getElementById('cancelEditMatch').addEventListener('click', () => {
      closeModal()
    })

    // Form submit handler
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

      // Validate required fields
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
        const uniquePlayerIds = Array.from(new Set(playerIds))
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
        const response = await makeAuthenticatedRequest(`${apiBase}/matches/${match.id}`, {
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
          showToast('Đã cập nhật trận đấu thành công', 'success')
        } else {
          errorDiv.textContent = data.error
        }
      } catch (error) {
        console.error('Error updating match:', error)
        errorDiv.textContent = 'Lỗi kết nối khi cập nhật trận đấu'
      }
    })
  }

  /** Remove the modal from the DOM with fade-out animation */
  function closeModal() {
    modal.classList.remove('show')
    setTimeout(() => {
      if (modal.parentNode) {
        document.body.removeChild(modal)
      }
    }, 200)
  }

  return { showMatchEditModal }
}
