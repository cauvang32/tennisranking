/**
 * Seasons feature — CRUD operations, rendering, and season selector management.
 *
 * Extracted from src/main.js (lines ~2760–3680).
 * Factory: createSeasonsModule(ctx) where ctx is the main app class instance.
 */

import { createSeasonResultsModule } from './season-results.js'

export function createSeasonsModule(ctx) {

  // Lazily initialise the sibling season-results module so we can delegate
  // the view-results action without a circular dependency.
  let seasonResults
  function getSeasonResults() {
    if (!seasonResults) seasonResults = createSeasonResultsModule(ctx)
    return seasonResults
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function renderSeasons() {
    try {
      const container = document.getElementById('seasonsList')
      if (!container) {
        console.warn('Seasons list container not found')
        return
      }

      const userRole = ctx.user?.role
      const activeSeasons = ctx.seasons.filter(s => s.is_active)
      const endedSeasons = ctx.seasons.filter(s => !s.is_active)

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
            ? ctx.formatDate(season.end_date)
            : '<span class="season-text-muted">Không có ngày kết thúc</span>'
          const autoEndInfo = season.auto_end && hasEndDate ? ` <span class="season-auto-end">(Tự động kết thúc)</span>` : ''
          const descriptionInfo = season.description ? `<p class="season-description">📝 ${ctx.escapeHtml(season.description)}</p>` : ''
          const loseMoneyInfo = `<p>💰 Tiền thua: ${ctx.formatMoney(season.lose_money_per_loss ?? 20000)}/trận</p>`

          html += `
            <div class="season-card active-season">
              <div class="season-header">
                <h4>${ctx.escapeHtml(season.name)}</h4>
                <span class="season-status active">Đang hoạt động</span>
              </div>
              <div class="season-info">
                <p>📅 Từ: ${ctx.formatDate(season.start_date)}</p>
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
            ? ctx.formatDate(season.end_date)
            : '<span class="season-text-muted">Không có ngày kết thúc</span>'
          const descriptionInfo = season.description ? `<p class="season-description">📝 ${ctx.escapeHtml(season.description)}</p>` : ''
          const endedAtInfo = season.ended_at ? `<p>⏰ Kết thúc lúc: ${new Date(season.ended_at).toLocaleString('vi-VN')}</p>` : ''
          const endedByInfo = season.ended_by ? `<p>👤 Kết thúc bởi: ${ctx.escapeHtml(season.ended_by)}</p>` : ''
          const loseMoneyInfo = `<p>💰 Tiền thua: ${ctx.formatMoney(season.lose_money_per_loss ?? 20000)}/trận</p>`

          html += `
            <div class="season-card ended-season">
              <div class="season-header">
                <h4>${ctx.escapeHtml(season.name)}</h4>
                <span class="season-status ended">Đã kết thúc</span>
              </div>
              <div class="season-info">
                <p>📅 Từ: ${ctx.formatDate(season.start_date)}</p>
                <p>🏁 Đến: ${endDateDisplay}</p>
                ${loseMoneyInfo}
                ${endedAtInfo}
                ${endedByInfo}
                ${descriptionInfo}
                ${season.final_results ? `<div class="season-final-results"><strong>🏆 Kết quả cuối cùng:</strong><p class="season-results-text">${ctx.escapeHtml(season.final_results).replace(/\n/g, '<br>')}</p></div>` : ''}
                ${season.conclusion_image_path ? `<div class="season-conclusion-image"><img src="${ctx.apiBase}/images/season/${season.id}/conclusion/file" alt="Ảnh tổng kết" style="max-width:100%;max-height:120px;object-fit:contain;border-radius:8px;margin-top:8px;"></div>` : ''}
              </div>
              ${userRole === 'admin' || userRole === 'editor' ? `
                <div class="season-actions">
                  <button data-action="view-results" data-id="${season.id}" class="btn btn-sm btn-secondary">📋 Xem kết quả</button>
                  <button data-action="reactivate-season" data-id="${season.id}" class="btn btn-sm btn-primary">✅ Kích hoạt lại</button>
                  <button data-action="delete-season" data-id="${season.id}" class="btn btn-sm btn-danger">🗑️ Xóa</button>
                </div>
              ` : (season.final_results || season.conclusion_image_path) ? `
                <div class="season-actions">
                  <button data-action="view-results" data-id="${season.id}" class="btn btn-sm btn-secondary">📋 Xem kết quả</button>
                </div>
              ` : ''}
            </div>`
        })

        html += `</div></div>`
      }

      // Empty state
      if (ctx.seasons.length === 0) {
        html = `<div class="empty-state"><p>📋 Chưa có mùa giải nào. Tạo mùa giải đầu tiên để bắt đầu!</p></div>`
      }

      container.innerHTML = html

      // Add event listeners for season actions
      container.querySelectorAll('[data-action]').forEach(button => {
        button.addEventListener('click', (e) => {
          const action = e.target.dataset.action
          const seasonId = parseInt(e.target.dataset.id)

          if (action === 'view-results') {
            getSeasonResults().showSeasonResultsModal(seasonId)
          } else if (userRole === 'admin' || userRole === 'editor') {
            if (action === 'end-season') {
              endSeason(seasonId)
            } else if (action === 'reactivate-season') {
              reactivateSeason(seasonId)
            } else if (action === 'edit-season') {
              editSeason(seasonId)
            } else if (action === 'delete-season') {
              deleteSeason(seasonId)
            }
          }
        })
      })
    } catch (error) {
      console.error('Error rendering seasons:', error)
    }
  }

  // ---------------------------------------------------------------------------
  // Modal: create / edit
  // ---------------------------------------------------------------------------

  function showSeasonModal(seasonId = null) {
    const isEdit = seasonId !== null
    const season = isEdit ? ctx.seasons.find(s => s.id === seasonId) : null

    // Update modal title
    const titleEl = document.getElementById('seasonModalTitle')
    if (titleEl) {
      titleEl.textContent = isEdit ? 'Chỉnh Sửa Mùa Giải' : 'Tạo Mùa Giải Mới'
    }

    // Build player checkboxes
    const checkboxContainer = document.getElementById('seasonPlayersCheckboxes')
    if (checkboxContainer) {
      checkboxContainer.innerHTML = ctx.players.map(player => `
        <label class="player-checkbox">
          <input type="checkbox" name="seasonPlayers" value="${player.id}" data-player-name="${ctx.escapeHtml(player.name)}">
          <span>${ctx.escapeHtml(player.name)}</span>
        </label>
      `).join('')
    }

    // Set form values
    document.getElementById('seasonId').value = seasonId || ''
    document.getElementById('seasonName').value = season ? season.name : ''
    document.getElementById('seasonLoseMoney').value = season ? (season.lose_money_per_loss ?? 20000) : 20000
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

    // If editing, load season players for pre-selection
    if (isEdit) {
      loadSeasonPlayersForEdit(seasonId)
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

    // Setup form submission (clone to remove old listener)
    const form = document.getElementById('seasonForm')
    if (form) {
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
        await handleSeasonFormSubmit(isEdit, seasonId)
      })
    }

    // Show the modal
    ctx.showModal('seasonModal')
  }

  async function handleSeasonFormSubmit(isEdit, seasonId) {
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

    const result = isEdit
      ? await updateSeason(seasonId, name, description, startDate, endDate, autoEnd, loseMoneyPerLoss, selectedPlayers)
      : await createSeason(name, description, startDate, endDate, autoEnd, loseMoneyPerLoss, selectedPlayers)

    if (result.success) {
      ctx.hideModal('seasonModal')
      ctx.showToast(result.message, 'success')
    } else {
      if (errorDiv) errorDiv.textContent = result.message
    }
  }

  async function loadSeasonPlayersForEdit(seasonId) {
    try {
      const response = await fetch(`${ctx.apiBase}/seasons/${seasonId}/players`)
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

  // ---------------------------------------------------------------------------
  // CRUD operations
  // ---------------------------------------------------------------------------

  async function createSeason(name, description, startDate, endDate, autoEnd, loseMoneyPerLoss = 20000, playerIds = []) {
    try {
      const response = await ctx.makeAuthenticatedRequest(`${ctx.apiBase}/seasons`, {
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
        ctx.invalidateCache(['seasons', 'rankings']) // Season changes affect rankings
        await ctx.loadSeasons()
        renderSeasons()
        updateSeasonSelector()
        return { success: true, message: 'Đã tạo mùa giải mới thành công' }
      } else {
        return { success: false, message: data.error }
      }
    } catch (error) {
      console.error('Error creating season:', error)
      return { success: false, message: 'Lỗi khi tạo mùa giải' }
    }
  }

  async function updateSeason(seasonId, name, description, startDate, endDate, autoEnd, loseMoneyPerLoss = null, playerIds = null) {
    try {
      // Update season details
      const response = await ctx.makeAuthenticatedRequest(`${ctx.apiBase}/seasons/${seasonId}`, {
        method: 'PUT',
        body: JSON.stringify({ name, description, startDate, endDate, autoEnd, loseMoneyPerLoss })
      })

      const data = await response.json()

      if (!response.ok) {
        return { success: false, message: data.error }
      }

      // Update season players if provided
      if (playerIds !== null) {
        const playersResponse = await ctx.makeAuthenticatedRequest(`${ctx.apiBase}/seasons/${seasonId}/players`, {
          method: 'POST',
          body: JSON.stringify({ playerIds })
        })

        if (!playersResponse.ok) {
          const playersData = await playersResponse.json()
          return { success: false, message: playersData.error || 'Lỗi khi cập nhật người chơi' }
        }
      }

      ctx.invalidateCache(['seasons', 'rankings']) // Season update affects rankings
      await ctx.loadSeasons()
      renderSeasons()
      updateSeasonSelector()
      return { success: true, message: 'Đã cập nhật mùa giải thành công' }
    } catch (error) {
      console.error('Error updating season:', error)
      return { success: false, message: 'Lỗi khi cập nhật mùa giải' }
    }
  }

  async function endSeason(seasonId) {
    if (!ctx.isAuthenticated) {
      ctx.updateFileStatus('❌ Cần đăng nhập để kết thúc mùa giải', 'error')
      return
    }

    const season = ctx.seasons.find(s => s.id === seasonId)
    if (!season) {
      ctx.updateFileStatus('❌ Không tìm thấy mùa giải', 'error')
      return
    }

    const hasEndDate = season.end_date && season.end_date !== 'null' && season.end_date !== ''
    const confirmMessage = hasEndDate
      ? `Bạn có chắc chắn muốn kết thúc mùa giải "${season.name}"?\n\nNgày kết thúc: ${ctx.formatDate(season.end_date)}`
      : `Mùa giải "${season.name}" không có ngày kết thúc được đặt trước.\n\nBạn có chắc chắn muốn kết thúc mùa giải này ngay bây giờ?`

    if (!confirm(confirmMessage)) {
      return
    }

    const endDate = new Date().toISOString().split('T')[0]

    try {
      const response = await ctx.makeAuthenticatedRequest(`${ctx.apiBase}/seasons/${seasonId}/end`, {
        method: 'POST',
        body: JSON.stringify({ endDate })
      })

      const data = await response.json()

      if (response.ok) {
        await ctx.loadSeasons()
        renderSeasons()
        updateSeasonSelector()
        ctx.updateFileStatus('✅ Đã kết thúc mùa giải', 'success')
      } else {
        ctx.updateFileStatus(`❌ ${data.error}`, 'error')
      }
    } catch (error) {
      console.error('Error ending season:', error)
      ctx.updateFileStatus('❌ Lỗi khi kết thúc mùa giải', 'error')
    }
  }

  async function reactivateSeason(seasonId) {
    if (!ctx.isAuthenticated) {
      ctx.updateFileStatus('❌ Cần đăng nhập để kích hoạt lại mùa giải', 'error')
      return
    }

    const season = ctx.seasons.find(s => s.id === seasonId)
    if (!season) {
      ctx.updateFileStatus('❌ Không tìm thấy mùa giải', 'error')
      return
    }

    if (!confirm(`Bạn có chắc chắn muốn kích hoạt lại mùa giải "${season.name}"?`)) {
      return
    }

    try {
      const response = await ctx.makeAuthenticatedRequest(`${ctx.apiBase}/seasons/${seasonId}/reactivate`, {
        method: 'POST'
      })

      const data = await response.json()

      if (response.ok) {
        await ctx.loadSeasons()
        renderSeasons()
        updateSeasonSelector()
        ctx.updateFileStatus('✅ Đã kích hoạt lại mùa giải', 'success')
      } else {
        ctx.updateFileStatus(`❌ ${data.error}`, 'error')
      }
    } catch (error) {
      console.error('Error reactivating season:', error)
      ctx.updateFileStatus('❌ Lỗi khi kích hoạt lại mùa giải', 'error')
    }
  }

  function editSeason(seasonId) {
    showSeasonModal(seasonId)
  }

  async function deleteSeason(seasonId) {
    if (!ctx.isAuthenticated) {
      ctx.updateFileStatus('❌ Cần đăng nhập để xóa mùa giải', 'error')
      return
    }

    const season = ctx.seasons.find(s => s.id === seasonId)
    if (!season) {
      ctx.updateFileStatus('❌ Không tìm thấy mùa giải', 'error')
      return
    }

    // Check if this is an active season
    if (season.is_active) {
      ctx.updateFileStatus('❌ Không thể xóa mùa giải đang hoạt động. Vui lòng kết thúc mùa giải trước khi xóa.', 'error')
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
      const response = await ctx.makeAuthenticatedRequest(`${ctx.apiBase}/seasons/${seasonId}`, {
        method: 'DELETE'
      })

      const data = await response.json()

      if (response.ok) {
        // Invalidate all related caches
        ctx.invalidateCache(['seasons', 'rankings', 'matches', 'playDates'])

        // Reload all data since deleting a season affects matches and rankings
        await Promise.all([
          ctx.loadSeasons(),
          ctx.loadMatches(),
          ctx.loadPlayDates()
        ])

        renderSeasons()
        updateSeasonSelector()

        // If we're in season view mode and this was the selected season, switch to lifetime view
        if (ctx.currentViewMode === 'season' && ctx.selectedSeason === seasonId) {
          await ctx.switchViewMode('lifetime')
        }

        ctx.updateFileStatus(`✅ Đã xóa mùa giải "${season.name}" thành công`, 'success')
      } else {
        ctx.updateFileStatus(`❌ ${data.error || 'Lỗi khi xóa mùa giải'}`, 'error')
      }
    } catch (error) {
      console.error('Error deleting season:', error)
      ctx.updateFileStatus('❌ Lỗi kết nối khi xóa mùa giải', 'error')
    }
  }

  // ---------------------------------------------------------------------------
  // Season selector (rankings dropdown)
  // ---------------------------------------------------------------------------

  function updateSeasonSelector() {
    const selector = document.getElementById('seasonSelect')
    if (!selector) return

    selector.innerHTML = ctx.seasons.map(season =>
      `<option value="${season.id}">${ctx.escapeHtml(season.name)}${season.is_active ? ' (Đang hoạt động)' : ''}</option>`
    ).join('')

    if (ctx.selectedSeason) {
      selector.value = ctx.selectedSeason
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    renderSeasons,
    showSeasonModal,
    handleSeasonFormSubmit,
    loadSeasonPlayersForEdit,
    createSeason,
    updateSeason,
    endSeason,
    reactivateSeason,
    editSeason,
    deleteSeason,
    updateSeasonSelector
  }
}
