/**
 * Players feature — add/remove/render players, update selects.
 * Uses ctx pattern: ctx is the app instance with direct property access.
 */

export function createPlayersModule(ctx) {
  async function render() {
    const players = ctx.players
    const container = document.getElementById('playersTableBody')
    if (!container) return
    const isAuthenticated = ctx.isAuthenticated
    const user = ctx.user
    const canEdit = isAuthenticated && (user?.role === 'admin' || user?.role === 'editor')

    if (players.length === 0) {
      container.innerHTML = '<tr><td colspan="4" class="text-center">Chưa có người chơi nào</td></tr>'
      return
    }

    container.innerHTML = players.map(player => `
      <tr>
        <td class="col-id">${ctx.escapeHtml(player.id)}</td>
        <td><strong>${ctx.escapeHtml(player.name)}</strong></td>
        <td class="col-date-created">${ctx.formatDate(player.created_at) || '-'}</td>
        <td class="admin-only">
          ${canEdit ? `<button class="delete-player-btn" data-player-id="${player.id}" title="Xóa">🗑️</button>` : ''}
        </td>
      </tr>
    `).join('')

    // Update player count badge
    const countEl = document.getElementById('playerCount')
    if (countEl) countEl.textContent = `${players.length} người chơi`

    // Wire up delete buttons
    container.querySelectorAll('.delete-player-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const playerId = parseInt(btn.dataset.playerId)
        await removePlayer(playerId)
      })
    })
  }

  async function addPlayer() {
    const oldInput = document.getElementById('playerName')
    const newInput = document.getElementById('newPlayerName')
    const inputElement = (newInput && newInput.value.trim()) ? newInput : oldInput
    const playerName = inputElement?.value?.trim()
    if (!playerName) { ctx.showToast('Vui lòng nhập tên người chơi', 'error'); return }
    if (!ctx.isAuthenticated) { ctx.showToast('Cần đăng nhập để thêm người chơi', 'error'); return }

    try {
      const response = await ctx.makeAuthenticatedRequest('/players', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: playerName })
      })
      if (response.ok) {
        await response.json()
        ctx.invalidateCache(['players'])
        await ctx.loadPlayers()
        render()
        ctx.updatePlayerSelects()
        ctx.showToast(`Đã thêm người chơi: ${playerName}`, 'success')
        if (inputElement) inputElement.value = ''
      } else if (response.status === 409 || response.status === 400) {
        const data = await response.json().catch(() => ({}))
        ctx.showToast(data.error || 'Tên người chơi đã tồn tại', 'error')
      } else {
        ctx.showToast('Lỗi khi thêm người chơi', 'error')
      }
    } catch (err) { ctx.showToast('Lỗi khi thêm người chơi', 'error') }
  }

  async function removePlayer(playerId) {
    if (!ctx.isAuthenticated) { ctx.showToast('Cần đăng nhập để xóa người chơi', 'error'); return }
    const player = ctx.players.find(p => p.id === playerId)
    if (!player) return
    if (!confirm(`Bạn có chắc muốn xóa người chơi "${player.name}"?`)) return

    try {
      const response = await ctx.makeAuthenticatedRequest(`/players/${playerId}`, { method: 'DELETE' })
      if (response.ok) {
        const data = await response.json()
        if (data?.success) {
          ctx.invalidateCache(['players', 'rankings', 'matches'])
          await ctx.loadPlayers()
          await ctx.loadMatches()
          render()
          ctx.updatePlayerSelects()
          ctx.showToast(`Đã xóa người chơi: ${player.name}`, 'success')
        }
      } else {
        const data = await response.json().catch(() => ({}))
        ctx.showToast(data.error || 'Lỗi khi xóa người chơi', 'error')
      }
    } catch (err) { ctx.showToast('Lỗi khi xóa người chơi', 'error') }
  }

  function setupEventListeners() {
    const addPlayerBtn = document.getElementById('addPlayer')
    if (addPlayerBtn) addPlayerBtn.addEventListener('click', addPlayer)
    const playerNameInput = document.getElementById('playerName')
    if (playerNameInput) playerNameInput.addEventListener('keypress', async (e) => { if (e.key === 'Enter') await addPlayer() })
    const newPlayerNameInput = document.getElementById('newPlayerName')
    if (newPlayerNameInput) newPlayerNameInput.addEventListener('keypress', async (e) => { if (e.key === 'Enter') await addPlayer() })
  }

  return { render, addPlayer, removePlayer, setupEventListeners }
}
