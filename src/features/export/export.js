/**
 * Export feature — Excel export, JSON backup/restore, and clear-all-data.
 *
 * Extracted from src/main.js (lines ~3680–4260).
 * Factory: createExportModule(ctx) where ctx is the main app class instance.
 */

export function createExportModule(ctx) {

  // ---------------------------------------------------------------------------
  // Excel export
  // ---------------------------------------------------------------------------

  async function exportToExcel(explicitMode) {
    // Use explicit mode if provided, otherwise fall back to currentViewMode
    const mode = explicitMode || ctx.currentViewMode

    // Determine the export type based on mode
    let exportUrl = `${ctx.apiBase}/export-excel`
    let fileName = 'tennis-rankings'
    let statusSuffix = ''

    if (mode === 'daily') {
      if (!ctx.selectedDate) {
        ctx.showToast('Vui lòng chọn ngày để xuất Excel', 'error')
        return
      }
      exportUrl += `/date/${ctx.selectedDate}`
      fileName += `-${ctx.selectedDate}`
      statusSuffix = ` (theo ngày: ${ctx.formatDate(ctx.selectedDate)})`
    } else if (mode === 'season') {
      if (!ctx.selectedSeason) {
        ctx.showToast('Vui lòng chọn mùa giải để xuất Excel', 'error')
        return
      }
      exportUrl += `/season/${ctx.selectedSeason}`
      fileName += `-season-${ctx.selectedSeason}`
      const season = ctx.seasons.find(s => s.id === ctx.selectedSeason)
      statusSuffix = ` (theo mùa giải: ${season ? season.name : ctx.selectedSeason})`
    } else if (mode === 'lifetime') {
      exportUrl += '/lifetime'
      fileName += '-lifetime'
      statusSuffix = ' (toàn thời gian)'
    }

    fileName += `-${new Date().toISOString().split('T')[0]}.xlsx`

    try {
      const response = await fetch(exportUrl, { credentials: 'include' })

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

        ctx.updateFileStatus(`✅ Đã xuất dữ liệu ra Excel thành công${statusSuffix}`, 'success')
      } else {
        ctx.updateFileStatus('❌ Lỗi khi xuất dữ liệu ra Excel', 'error')
      }
    } catch (error) {
      console.error('Error exporting to Excel:', error)
      ctx.updateFileStatus('❌ Lỗi khi xuất dữ liệu ra Excel', 'error')
    }
  }

  // ---------------------------------------------------------------------------
  // JSON backup (legacy /backup endpoint)
  // ---------------------------------------------------------------------------

  async function backupToJson() {
    try {
      ctx.showToast('Đang tạo bản sao lưu...', 'info')

      const response = await ctx.makeAuthenticatedRequest(`${ctx.apiBase}/backup`, {
        method: 'GET'
      })

      if (!response.ok) {
        const data = await response.json()
        ctx.showToast(data.error || 'Lỗi khi tạo bản sao lưu', 'error')
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

      ctx.showToast('Đã tạo bản sao lưu thành công!', 'success')
    } catch (error) {
      console.error('Error creating backup:', error)
      ctx.showToast('Lỗi khi tạo bản sao lưu', 'error')
    }
  }

  // ---------------------------------------------------------------------------
  // JSON restore (legacy /restore endpoint — destructive, replaces all data)
  // ---------------------------------------------------------------------------

  async function restoreFromJson(event) {
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
      ctx.showToast('Đã hủy khôi phục', 'info')
      return
    }

    try {
      ctx.showToast('Đang khôi phục dữ liệu...', 'info')

      // Read file content
      const reader = new FileReader()
      reader.onload = async (e) => {
        try {
          const backupData = JSON.parse(e.target.result)

          // Validate backup structure
          if (!backupData.players || !backupData.seasons || !backupData.matches) {
            ctx.showToast('File backup không hợp lệ - thiếu dữ liệu players, seasons hoặc matches', 'error')
            return
          }

          console.log(`📤 Sending restore request with ${backupData.players.length} players, ${backupData.seasons.length} seasons, ${backupData.matches.length} matches`)

          // Send to server with confirmRestore flag (server requires explicit confirmation)
          const response = await ctx.makeAuthenticatedRequest(`${ctx.apiBase}/restore`, {
            method: 'POST',
            body: JSON.stringify({ ...backupData, confirmRestore: true })
          })

          // Check if response is OK before parsing JSON
          const contentType = response.headers.get('content-type')
          if (!contentType || !contentType.includes('application/json')) {
            const textResponse = await response.text()
            console.error('Server returned non-JSON response:', textResponse)
            ctx.showToast(`Lỗi server: ${response.status} ${response.statusText}`, 'error')
            return
          }

          const result = await response.json()

          if (response.ok) {
            ctx.showToast('Khôi phục dữ liệu thành công! Đang tải lại...', 'success')

            // Invalidate all client cache
            ctx.clearCache()

            // Reload all data
            await ctx.loadPlayers()
            await ctx.loadSeasons()
            await ctx.loadMatches()
            await ctx.loadPlayDates()

            // Update UI
            ctx.renderRankings()
            ctx.renderSeasons()
            ctx.renderPlayers()
            ctx.updatePlayerSelects()
            ctx.updateDateSelector()
            ctx.updateSeasonSelector()
            ctx.updateSeasonSelect()
          } else {
            console.error('Restore failed:', result)
            ctx.showToast(result.error || 'Lỗi khi khôi phục dữ liệu', 'error')
          }
        } catch (parseError) {
          console.error('Error in restore process:', parseError)
          if (parseError.message?.includes('JSON')) {
            ctx.showToast('Lỗi đọc file JSON - kiểm tra định dạng file', 'error')
          } else {
            ctx.showToast(`Lỗi: ${parseError.message}`, 'error')
          }
        }
      }

      reader.onerror = () => {
        console.error('FileReader error')
        ctx.showToast('Lỗi đọc file', 'error')
      }

      reader.readAsText(file)
    } catch (error) {
      console.error('Error restoring backup:', error)
      ctx.showToast('Lỗi khi khôi phục dữ liệu', 'error')
    }
  }

  // ---------------------------------------------------------------------------
  // Structured backup (backup-data endpoint — metadata-rich, non-destructive)
  // ---------------------------------------------------------------------------

  async function backupData() {
    if (!ctx.isAuthenticated) {
      ctx.updateFileStatus('❌ Cần đăng nhập để sao lưu dữ liệu', 'error')
      return
    }

    try {
      ctx.updateFileStatus('📦 Đang tạo bản sao lưu...', 'info')

      const response = await ctx.makeAuthenticatedRequest(`${ctx.apiBase}/backup-data`, {
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

        ctx.updateFileStatus('✅ Đã tạo bản sao lưu thành công', 'success')
      } else {
        const errorData = await response.json()
        ctx.updateFileStatus(`❌ ${errorData.error || 'Lỗi khi tạo bản sao lưu'}`, 'error')
      }
    } catch (error) {
      console.error('Error creating backup:', error)
      ctx.updateFileStatus('❌ Lỗi kết nối khi tạo bản sao lưu', 'error')
    }
  }

  // ---------------------------------------------------------------------------
  // Structured restore (restore-data endpoint — modal dialog, optional clear)
  // ---------------------------------------------------------------------------

  async function restoreData() {
    if (!ctx.isAuthenticated) {
      ctx.updateFileStatus('❌ Cần đăng nhập để khôi phục dữ liệu', 'error')
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
          ctx.updateFileStatus('❌ Vui lòng chọn file JSON (.json)', 'error')
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
          ctx.updateFileStatus('❌ File không phải là JSON hợp lệ', 'error')
          return
        }

        // Validate backup structure (requires version + data wrapper)
        if (!backupData.version || !backupData.data) {
          ctx.updateFileStatus('❌ File sao lưu không đúng định dạng', 'error')
          return
        }

        // Show restore options dialog
        showRestoreDialog(backupData)

      } catch (error) {
        console.error('Error reading backup file:', error)
        ctx.updateFileStatus('❌ Lỗi khi đọc file sao lưu', 'error')
      }
    }

    document.body.appendChild(input)
    input.click()
    document.body.removeChild(input)
  }

  function showRestoreDialog(backupData) {
    const modal = document.createElement('div')
    modal.className = 'modal'
    modal.innerHTML = `
      <div class="modal-content">
        <h2>Khôi Phục Dữ Liệu</h2>
        <div class="backup-info">
          <p><strong>Thông tin bản sao lưu:</strong></p>
          <ul>
            <li>Phiên bản: ${ctx.escapeHtml(String(backupData.version || ''))}</li>
            <li>Ngày tạo: ${ctx.escapeHtml(new Date(backupData.timestamp).toLocaleString('vi-VN'))}</li>
            <li>Người tạo: ${ctx.escapeHtml(backupData.exportedBy || 'Không rõ')}</li>
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
      performRestore(backupData, clearExisting)
    }

    cancelBtn.onclick = () => {
      document.body.removeChild(modal)
      ctx.updateFileStatus('❌ Đã hủy khôi phục dữ liệu', 'info')
    }

    // Close modal when clicking outside
    modal.onclick = (e) => {
      if (e.target === modal) {
        document.body.removeChild(modal)
        ctx.updateFileStatus('❌ Đã hủy khôi phục dữ liệu', 'info')
      }
    }
  }

  async function performRestore(backupData, clearExisting) {
    try {
      ctx.updateFileStatus('🔄 Đang khôi phục dữ liệu...', 'info')

      const response = await ctx.makeAuthenticatedRequest(`${ctx.apiBase}/restore-data`, {
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
          ctx.loadPlayers(),
          ctx.loadSeasons(),
          ctx.loadMatches(),
          ctx.loadPlayDates()
        ])

        ctx.renderPlayers()
        ctx.renderSeasons()
        ctx.renderRankings()
        ctx.updatePlayerSelects()
        ctx.updateDateSelector()
        ctx.updateSeasonSelector()

        let statusMessage = '✅ Đã khôi phục dữ liệu thành công!'
        statusMessage += `\n📊 Kết quả: ${data.results.playersImported} người chơi, ${data.results.seasonsImported} mùa giải, ${data.results.matchesImported} trận đấu`

        if (data.results.errors && data.results.errors.length > 0) {
          statusMessage += `\n⚠️ ${data.results.errors.length} lỗi nhỏ (có thể do dữ liệu trùng lặp)`
        }

        ctx.updateFileStatus(statusMessage, 'success')
      } else {
        ctx.updateFileStatus(`❌ ${data.error || 'Lỗi khi khôi phục dữ liệu'}`, 'error')
      }
    } catch (error) {
      console.error('Error restoring data:', error)
      ctx.updateFileStatus('❌ Lỗi kết nối khi khôi phục dữ liệu', 'error')
    }
  }

  // ---------------------------------------------------------------------------
  // Clear all data (triple confirmation: confirm + prompt + confirm)
  // ---------------------------------------------------------------------------

  async function clearAllData() {
    if (!ctx.isAuthenticated) {
      ctx.updateFileStatus('❌ Cần đăng nhập để xóa dữ liệu', 'error')
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
      ctx.updateFileStatus('❌ Đã hủy xóa dữ liệu (từ xác nhận không đúng)', 'info')
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
      ctx.updateFileStatus('❌ Đã hủy xóa dữ liệu (xác nhận cuối cùng)', 'info')
      return
    }

    try {
      ctx.updateFileStatus('🔄 Đang xóa tất cả dữ liệu...', 'info')

      const response = await ctx.makeAuthenticatedRequest(`${ctx.apiBase}/clear-all-data`, {
        method: 'DELETE'
      })

      const data = await response.json()

      if (response.ok) {
        // Clear local data
        ctx.players = []
        ctx.matches = []
        ctx.seasons = []
        ctx.playDates = []
        ctx.selectedDate = null
        ctx.selectedSeason = null

        // Refresh all UI
        ctx.renderPlayers()
        ctx.renderSeasons()
        ctx.renderRankings()
        ctx.updatePlayerSelects()
        ctx.updateDateSelector()
        ctx.updateSeasonSelector()

        ctx.updateFileStatus('✅ Đã xóa tất cả dữ liệu thành công. Hệ thống đã được reset hoàn toàn.', 'success')
      } else {
        ctx.updateFileStatus(`❌ ${data.error || 'Lỗi khi xóa dữ liệu'}`, 'error')
      }
    } catch (error) {
      console.error('Error clearing all data:', error)
      ctx.updateFileStatus('❌ Lỗi kết nối khi xóa dữ liệu', 'error')
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    exportToExcel,
    backupToJson,
    restoreFromJson,
    backupData,
    restoreData,
    showRestoreDialog,
    performRestore,
    clearAllData
  }
}
