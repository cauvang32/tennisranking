/**
 * Accounts feature — account CRUD, cache status, FCM management, password validation.
 *
 * Extracted from src/main.js (lines ~4732–5196).
 * Factory: createAccountsModule(ctx) where ctx is the TennisRankingSystem instance.
 */

const WEAK_PASSWORDS = ['123456', 'password', 'abc123', '111111', '123123', 'admin', 'qwerty', '12345678', 'password123']

/**
 * Safe date formatter — handles null, undefined, {}, Invalid Date.
 */
function formatDate(val) {
  if (!val || typeof val === 'object') return null
  try {
    const d = new Date(val)
    if (isNaN(d.getTime())) return null
    return d.toLocaleString('vi-VN')
  } catch {
    return null
  }
}

export function createAccountsModule(ctx) {

  // ─── Account Modal ───────────────────────────────────────────────

  function showAccountModal(account) {
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

    ctx.showModal('accountModal')
  }

  // ─── Save Account ────────────────────────────────────────────────

  async function saveAccount() {
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
      const passwordValidation = validatePasswordStrength(password)
      if (!passwordValidation.valid) {
        ctx.showToast(passwordValidation.message, 'error')
        return
      }
      accountData.password = password
    }

    try {
      let response
      if (accountId) {
        // Update existing account
        response = await ctx.makeAuthenticatedRequest(`${ctx.apiBase}/auth/users/${accountId}`, {
          method: 'PUT',
          body: JSON.stringify(accountData)
        })
      } else {
        // Create new account
        if (!password) {
          ctx.showToast('Vui lòng nhập mật khẩu', 'error')
          return
        }
        response = await ctx.makeAuthenticatedRequest(`${ctx.apiBase}/auth/users`, {
          method: 'POST',
          body: JSON.stringify(accountData)
        })
      }

      const data = await response.json()

      if (response.ok) {
        ctx.hideModal('accountModal')
        ctx.showToast(accountId ? 'Đã cập nhật tài khoản' : 'Đã tạo tài khoản mới', 'success')
        renderAccounts()
      } else {
        ctx.showToast(data.error || 'Lỗi khi lưu tài khoản', 'error')
      }
    } catch (error) {
      console.error('Error saving account:', error)
      ctx.showToast('Lỗi kết nối server', 'error')
    }
  }

  // ─── Delete Account ──────────────────────────────────────────────

  async function deleteAccount(accountId) {
    if (!confirm('Bạn có chắc chắn muốn xóa tài khoản này?')) return

    try {
      const response = await ctx.makeAuthenticatedRequest(`${ctx.apiBase}/auth/users/${accountId}`, {
        method: 'DELETE'
      })

      if (response.ok) {
        ctx.showToast('Đã xóa tài khoản', 'success')
        renderAccounts()
      } else {
        const data = await response.json()
        ctx.showToast(data.error || 'Lỗi khi xóa tài khoản', 'error')
      }
    } catch (error) {
      console.error('Error deleting account:', error)
      ctx.showToast('Lỗi kết nối server', 'error')
    }
  }

  // ─── Render Accounts Table ───────────────────────────────────────

  async function renderAccounts() {
    const container = document.querySelector('#accountsTable tbody')
    if (!container) return

    try {
      const response = await fetch(`${ctx.apiBase}/auth/users?t=${Date.now()}`, {
        credentials: 'include'
      })

      if (!response.ok) {
        container.innerHTML = '<tr><td colspan="9" class="text-center">Không thể tải danh sách tài khoản</td></tr>'
        return
      }

      const raw = await response.json()
      const accounts = Array.isArray(raw) ? raw : (raw.users || raw.data || [])

      if (accounts.length === 0) {
        container.innerHTML = '<tr><td colspan="9" class="text-center">Chưa có tài khoản nào</td></tr>'
        return
      }

      container.innerHTML = accounts.map(account => {
        const roleClass = account.role === 'admin' ? 'role-admin' : (account.role === 'editor' ? 'role-editor' : 'role-viewer')
        const statusClass = account.is_active ? 'status-active' : 'status-inactive'
        const lastLogin = formatDate(account.last_login) || 'Chưa đăng nhập'
        const isSelf = ctx.user && ctx.user.username === account.username
        const notifMatch = account.receive_match_notifications !== false ? '\u{1F3AF}' : ''
        const notifSeason = account.receive_season_notifications !== false ? '\u{1F3C6}' : ''
        const notifStatus = (notifMatch || notifSeason) ? `${notifMatch} ${notifSeason}`.trim() : '<span class="badge badge-notif-off">Tắt</span>'

        return `
          <tr>
            <td>${ctx.escapeHtml(account.id)}</td>
            <td><strong>${ctx.escapeHtml(account.username)}</strong>${isSelf ? ' <span class="badge role-viewer">Bạn</span>' : ''}</td>
            <td>${ctx.escapeHtml(account.display_name) || '-'}</td>
            <td>${ctx.escapeHtml(account.email) || '-'}</td>
            <td><span class="badge ${roleClass}">${ctx.escapeHtml(account.role || 'viewer').toUpperCase()}</span></td>
            <td><span class="${statusClass}">${account.is_active ? '\u2705 Hoạt động' : '\u274C Vô hiệu'}</span></td>
            <td>${notifStatus}</td>
            <td>${ctx.escapeHtml(lastLogin)}</td>
            <td>
              <div class="action-btns">
                <button class="edit-btn" data-account-id="${account.id}" title="Chỉnh sửa">\u270F\uFE0F</button>
                <button class="delete-btn" data-account-id="${account.id}" ${isSelf ? 'disabled title="Không thể xóa tài khoản của chính mình"' : 'title="Xóa"'}>\u{1F5D1}\uFE0F</button>
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
          if (account) showAccountModal(account)
        })
      })

      container.querySelectorAll('.delete-btn:not([disabled])').forEach(btn => {
        btn.addEventListener('click', () => {
          const accountId = parseInt(btn.dataset.accountId)
          deleteAccount(accountId)
        })
      })
    } catch (error) {
      console.error('Error rendering accounts:', error)
      container.innerHTML = '<tr><td colspan="9" class="text-center">Lỗi tải danh sách tài khoản</td></tr>'
    }
  }

  // ─── Cache Status (Admin Only) ───────────────────────────────────

  async function renderCacheStatus() {
    const container = document.getElementById('cacheStatusContainer')
    if (!container) return

    // Only render for admin users
    if (!ctx.isAuthenticated || ctx.user?.role !== 'admin') {
      container.innerHTML = '<p class="cache-status-error">\u26A0\uFE0F Chỉ admin mới có thể xem trạng thái cache</p>'
      return
    }

    // Show loading state
    container.innerHTML = `
      <div class="cache-status-loading">
        <div class="loading-spinner"></div>
        <span>Đang tải trạng thái cache...</span>
      </div>
    `

    try {
      const response = await ctx.makeAuthenticatedRequest(`${ctx.apiBase}/cache-stats`, {
        method: 'GET'
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Không thể tải trạng thái cache')
      }

      const data = await response.json()
      const stats = data.cacheStats
      const recommendations = data.recommendations
      const serverInfo = data.serverInfo

      // Calculate hit rate class
      const hitRateValue = parseFloat(stats.hitRate) || 0
      const hitRateClass = hitRateValue >= 70 ? 'positive' : (hitRateValue >= 40 ? 'warning' : 'negative')

      // Connection status
      const connectionClass = stats.isConnected ? 'positive' : 'negative'
      const connectionText = stats.isConnected ? '\u2705 Kết nối' : '\u274C Mất kết nối'

      container.innerHTML = `
        <div class="cache-status-grid">
          <div class="cache-stat-card">
            <span class="stat-label">Trạng thái Redis</span>
            <span class="stat-value ${connectionClass}">${connectionText}</span>
          </div>
          <div class="cache-stat-card">
            <span class="stat-label">Tỷ lệ Hit</span>
            <span class="stat-value ${hitRateClass}">${ctx.escapeHtml(stats.hitRate)}</span>
          </div>
          <div class="cache-stat-card">
            <span class="stat-label">Hits / Misses</span>
            <span class="stat-value">${stats.hits} / ${stats.misses}</span>
          </div>
          <div class="cache-stat-card">
            <span class="stat-label">Số entry</span>
            <span class="stat-value">${stats.currentEntries || 0}</span>
          </div>
          <div class="cache-stat-card">
            <span class="stat-label">Bộ nhớ sử dụng</span>
            <span class="stat-value">${ctx.escapeHtml(stats.memoryUsage || 'N/A')}</span>
          </div>
          <div class="cache-stat-card">
            <span class="stat-label">Sets / Invalidations</span>
            <span class="stat-value">${stats.sets || 0} / ${stats.invalidations || 0}</span>
          </div>
        </div>

        ${recommendations ? `
          <div class="cache-recommendations">
            <h4>\u{1F4A1} Khuyến nghị</h4>
            <ul>
              <li><strong>Hiệu suất:</strong> ${ctx.escapeHtml(recommendations.performance)}</li>
              <li><strong>Bộ nhớ:</strong> ${ctx.escapeHtml(recommendations.memory)}</li>
              <li><strong>Ghi chú:</strong> ${ctx.escapeHtml(recommendations.info)}</li>
            </ul>
          </div>
        ` : ''}

        ${serverInfo ? `
          <div class="cache-server-info">
            <h4>\u{1F5A5}\uFE0F Thông tin Server</h4>
            <div class="server-info-grid">
              <span><strong>Uptime:</strong> ${formatUptime(serverInfo.uptime)}</span>
              <span><strong>Môi trường:</strong> ${ctx.escapeHtml(serverInfo.environment)}</span>
              <span><strong>Redis:</strong> ${serverInfo.redisConnected ? '\u2705 Đã kết nối' : '\u274C Chưa kết nối'}</span>
            </div>
          </div>
        ` : ''}
      `

    } catch (error) {
      console.error('Error fetching cache status:', error)
      container.innerHTML = `
        <p class="cache-status-error">
          \u274C Lỗi tải trạng thái cache: ${ctx.escapeHtml(error.message)}
        </p>
      `
    }
  }

  // ─── Format Uptime ───────────────────────────────────────────────

  function formatUptime(seconds) {
    if (!seconds || seconds < 0) return 'N/A'

    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = Math.floor(seconds % 60)

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`
    } else {
      return `${secs}s`
    }
  }

  // ─── FCM Status ──────────────────────────────────────────────────

  async function fetchFcmStatus() {
    if (ctx.user?.role !== 'admin') return

    try {
      const response = await ctx.makeAuthenticatedRequest(`${ctx.apiBase}/admin/fcm/status`, {
        method: 'GET'
      })
      const data = await response.json()
      if (data.success && data.status) {
        const { isPaused, dispatcher, sender } = data.status
        const pending = (dispatcher?.wait || 0) + (sender?.wait || 0)
        const active = (dispatcher?.active || 0) + (sender?.active || 0)
        const failed = (dispatcher?.failed || 0) + (sender?.failed || 0)

        document.getElementById('fcmDevicesCount').textContent = data.deviceCount || 0
        document.getElementById('fcmJobsPending').textContent = pending
        document.getElementById('fcmJobsActive').textContent = active
        document.getElementById('fcmJobsFailed').textContent = failed

        const pauseBtn = document.getElementById('fcmPauseBtn')
        const resumeBtn = document.getElementById('fcmResumeBtn')
        if (pauseBtn) pauseBtn.style.display = isPaused ? 'none' : 'inline-flex'
        if (resumeBtn) resumeBtn.style.display = isPaused ? 'inline-flex' : 'none'
      } else {
        ctx.showToast('Không thể lấy trạng thái FCM (Workers có thể đang tắt)', 'warning')
      }
    } catch (error) {
      console.warn('Lỗi khi lấy trạng thái FCM:', error)
    }
  }

  // ─── FCM Control (Pause / Resume) ────────────────────────────────

  async function controlFcm(action) {
    if (!confirm(`Bạn có chắc muốn ${action === 'pause' ? 'TẠM DỪNG' : 'TIẾP TỤC'} hàng đợi thông báo?`)) return
    try {
      const response = await ctx.makeAuthenticatedRequest(`${ctx.apiBase}/admin/fcm/${action}`, {
        method: 'POST'
      })
      const data = await response.json()
      if (data.success) {
        ctx.showToast(data.message, 'success')
        fetchFcmStatus()
      } else {
        ctx.showToast(data.error || 'Thao tác thất bại', 'error')
      }
    } catch (error) {
      ctx.showToast('Lỗi mạng khi điều khiển FCM', 'error')
    }
  }

  // ─── FCM Broadcast ───────────────────────────────────────────────

  async function sendFcmBroadcast(e) {
    e.preventDefault()
    if (!confirm('Gửi thông báo này đến TẤT CẢ người dùng?')) return

    const title = document.getElementById('fcmBroadcastTitle').value.trim()
    const body = document.getElementById('fcmBroadcastBody').value.trim()
    const submitBtn = document.getElementById('fcmBroadcastSubmitBtn')

    submitBtn.disabled = true
    submitBtn.innerHTML = '<span class="spinner-small"></span> Đang gửi...'

    try {
      const response = await ctx.makeAuthenticatedRequest(`${ctx.apiBase}/admin/fcm/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body })
      })
      const data = await response.json()
      if (data.success) {
        ctx.showToast('Đã đưa thông báo vào hàng đợi gửi (Broadcast)', 'success')
        document.getElementById('fcmBroadcastForm').reset()
        setTimeout(() => fetchFcmStatus(), 1500)
      } else {
        ctx.showToast(data.error || 'Gửi thất bại', 'error')
      }
    } catch (error) {
      ctx.showToast('Lỗi mạng khi gửi Broadcast', 'error')
    } finally {
      submitBtn.disabled = false
      submitBtn.innerHTML = 'Gửi Broadcast'
    }
  }

  // ─── Password Validation ─────────────────────────────────────────

  function validatePasswordStrength(password) {
    if (!password || password.length < 6) {
      return { valid: false, message: 'Mật khẩu phải có ít nhất 6 ký tự' }
    }

    // Check for common weak passwords
    if (WEAK_PASSWORDS.includes(password.toLowerCase())) {
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

  // ─── Public API ──────────────────────────────────────────────────

  return {
    showAccountModal,
    saveAccount,
    deleteAccount,
    renderAccounts,
    renderCacheStatus,
    formatUptime,
    fetchFcmStatus,
    controlFcm,
    sendFcmBroadcast,
    validatePasswordStrength
  }
}
