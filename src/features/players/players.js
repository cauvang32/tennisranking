/**
 * Players feature — add/remove/render players, update selects.
 * Uses ctx pattern: ctx is the app instance with direct property access.
 */

export function createPlayersModule(ctx) {
  async function render() {
    const players = ctx.players
    const container = document.getElementById('playersList')
    if (!container) return
    const isAuthenticated = ctx.isAuthenticated
    const user = ctx.user
    const canEdit = isAuthenticated && (user?.role === 'admin' || user?.role === 'editor')

    container.innerHTML = players.map(player => `
      <div class="player-card">
        <span class="player-name">${ctx.escapeHtml(player.name)}</span>
        ${canEdit ? `<button class="delete-btn" data-player-id="${player.id}">✕</button>` : ''}
      </div>
    `).join('')

    // Wire up delete buttons
    container.querySelectorAll('.delete-btn').forEach(btn => {
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
      const data = await ctx.makeAuthenticatedRequest('/players', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: playerName })
      })
      if (data) {
        ctx.invalidateCache(['players'])
        await ctx.loadPlayers()
        render()
        ctx.updatePlayerSelects()
        ctx.showToast(`Đã thêm người chơi: ${playerName}`, 'success')
      }
    } catch (err) { ctx.showToast('Lỗi khi thêm người chơi', 'error') }
  }

  async function removePlayer(playerId) {
    if (!ctx.isAuthenticated) { ctx.showToast('Cần đăng nhập để xóa người chơi', 'error'); return }
    const player = ctx.players.find(p => p.id === playerId)
    if (!player) return
    if (!confirm(`Bạn có chắc muốn xóa người chơi "${player.name}"?`)) return

    try {
      const data = await ctx.makeAuthenticatedRequest(`/players/${playerId}`, { method: 'DELETE' })
      if (data) {
        ctx.invalidateCache(['players', 'rankings', 'matches'])
        await ctx.loadPlayers()
        await ctx.loadMatches()
        render()
        ctx.updatePlayerSelects()
        ctx.showToast(`Đã xóa người chơi: ${player.name}`, 'success')
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
