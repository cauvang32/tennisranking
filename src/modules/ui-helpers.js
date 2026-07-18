/**
 * Shared UI utilities — loader, toast, modal, escapeHtml, formatters.
 * Pure DOM helpers with no domain logic.
 */

export function createUiHelpers() {
  function escapeHtml(unsafe) {
    if (unsafe === null || unsafe === undefined) return ''
    return String(unsafe)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/`/g, '&#96;')
  }

  function showLoader(message = 'Đang tải...') {
    const overlay = document.getElementById('loadingOverlay')
    if (overlay) {
      const msgEl = overlay.querySelector('p')
      if (msgEl) msgEl.textContent = message
      overlay.classList.add('show')
    }
  }

  function hideLoader() {
    const overlay = document.getElementById('loadingOverlay')
    if (overlay) overlay.classList.remove('show')
  }

  function showToast(message, type = 'success') {
    const toast = document.createElement('div')
    toast.className = `toast toast-${type}`
    toast.textContent = message
    document.body.appendChild(toast)
    setTimeout(() => {
      toast.classList.add('show')
      setTimeout(() => {
        toast.classList.remove('show')
        setTimeout(() => toast.remove(), 300)
      }, 3000)
    }, 100)
  }

  function showModal(modalId) {
    const modal = document.getElementById(modalId)
    if (modal) modal.classList.add('show')
  }

  function hideModal(modalId) {
    const modal = document.getElementById(modalId)
    if (modal) modal.classList.remove('show')
  }

  function updateFileStatus(message, type = 'info') {
    const el = document.getElementById('fileStatus')
    if (el) {
      el.textContent = message
      el.className = `status-${type}`
    }
  }

  function formatDate(dateValue) {
    if (!dateValue) return ''
    const d = new Date(dateValue)
    if (isNaN(d.getTime())) return dateValue
    const day = String(d.getDate()).padStart(2, '0')
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const year = d.getFullYear()
    return `${day}/${month}/${year}`
  }

  function formatMoney(amount) {
    if (amount == null) return '0 ₫'
    return Number(amount).toLocaleString('vi-VN') + ' ₫'
  }

  function setTodaysDate() {
    const today = new Date().toISOString().split('T')[0]
    const matchDate = document.getElementById('matchDate')
    if (matchDate) matchDate.value = today
  }

  function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    return `${h}h ${m}m`
  }

  return { escapeHtml, showLoader, hideLoader, showToast, showModal, hideModal, updateFileStatus, formatDate, formatMoney, setTodaysDate, formatUptime }
}
