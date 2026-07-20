/**
 * Rankings feature — load/render rankings, form display, view mode switching.
 * Uses ctx pattern: ctx is the app instance with direct property access.
 */

export function createRankingsModule(ctx) {
  async function render() {
    let rankings = []

    try {
      let cacheKey = ''
      let apiUrl = ''

      if (ctx.currentViewMode === 'daily' && ctx.selectedDate) {
        cacheKey = `daily:${ctx.selectedDate}`
        apiUrl = `${ctx.apiBase}/rankings/date/${ctx.selectedDate}`
      } else if (ctx.currentViewMode === 'season' && ctx.selectedSeason) {
        cacheKey = `season:${ctx.selectedSeason}`
        apiUrl = `${ctx.apiBase}/rankings/season/${ctx.selectedSeason}`
      } else if (ctx.currentViewMode === 'lifetime') {
        cacheKey = 'lifetime'
        apiUrl = `${ctx.apiBase}/rankings/lifetime`
      }

      if (cacheKey) {
        rankings = ctx.getCache('rankings', cacheKey)
        if (!rankings && apiUrl) {
          const response = await fetch(apiUrl, { credentials: 'include' })
          if (response.ok) {
            rankings = await response.json()
            ctx.setCache('rankings', cacheKey, rankings)
          }
        }
      }
      rankings = rankings || []
    } catch (error) {
      console.error('Error loading rankings:', error)
      rankings = []
    }

    // Determine which table to use based on view mode
    let tableId = 'dailyRankingTable'
    if (ctx.currentViewMode === 'season') tableId = 'seasonRankingTable'
    else if (ctx.currentViewMode === 'lifetime') tableId = 'lifetimeRankingTable'

    const container = document.getElementById(tableId)
    if (!container) return

    const tbody = container.querySelector('tbody')
    if (!tbody) return

    const diffColor = (val) => val > 0 ? 'positive' : (val < 0 ? 'negative' : '')
    const diffLabel = (val) => (val > 0 ? '+' : '') + (val ?? 0)
    tbody.innerHTML = rankings.length === 0
      ? '<tr><td colspan="10" style="text-align: center; padding: 2rem; color: var(--text-muted);">Không có dữ liệu</td></tr>'
      : rankings.map((player, index) => {
          const balanceClass = player.money_balance > 0 ? 'positive' : (player.money_balance < 0 ? 'negative' : '')
          const balanceValue = player.money_balance ?? (player.money_won ?? 0) - (player.money_lost ?? 0)
          const formHtml = renderForm(player.form ?? player.recent_form ?? [])
          const points = player.points ?? 0
          const pointsClass = points > 0 ? 'positive' : (points < 0 ? 'negative' : '')
          const scoreDiff = player.score_difference ?? 0
          return `
          <tr>
            <td class="col-rank">${getRankEmoji(index + 1)}${index + 1}</td>
            <td class="col-name">${ctx.escapeHtml(player.name)}</td>
            <td class="col-form"><div class="form-dots">${formHtml || '-'}</div></td>
            <td>${player.total_matches || 0}</td>
            <td>${player.wins || 0}</td>
            <td>${player.losses || 0}</td>
            <td>${player.win_percentage || 0}%</td>
            <td class="col-points ${pointsClass}">${points}</td>
            <td class="col-difference ${diffColor(scoreDiff)}">${diffLabel(scoreDiff)}</td>
            <td class="col-balance ${balanceClass}">${ctx.formatMoney(balanceValue)}</td>
          </tr>
          `
        }).join('')
  }

  function getRankEmoji(rank) {
    if (rank === 1) return '🥇'
    if (rank === 2) return '🥈'
    if (rank === 3) return '🥉'
    return ''
  }

  function renderForm(form) {
    if (!form || form.length === 0) return ''
    return form.map(match => {
      const cssClass = match.result === 'win' ? 'form-dot-win' : 'form-dot-loss'
      return `<span class="form-dot ${cssClass}" title="${match.result === 'win' ? 'Thắng' : 'Thua'} - ${ctx.formatDate(match.play_date)}"></span>`
    }).join('')
  }

  function updateDateSelector() {
    const select = document.getElementById('rankingDateSelect')
    if (!select) return
    const dates = ctx.playDates
    const selected = ctx.selectedDate
    select.innerHTML = dates.map(d => {
      const date = d.play_date.split('T')[0]
      const sel = date === selected ? ' selected' : ''
      return `<option value="${date}"${sel}>${ctx.formatDate(date)}</option>`
    }).join('')
  }

  function updateRankingsSeasonSelector() {
    const select = document.getElementById('seasonSelect')
    if (!select) return
    const seasons = ctx.seasons
    const selected = ctx.selectedSeason
    select.innerHTML = seasons.map(s => {
      const sel = s.id === selected ? ' selected' : ''
      return `<option value="${s.id}"${sel}>${ctx.escapeHtml(s.name)}</option>`
    }).join('')
  }

  function switchViewMode(mode) {
    ctx.currentViewMode = mode
    document.querySelectorAll('.view-btn').forEach(btn => btn.classList.remove('active'))
    const activeBtn = document.querySelector(`.view-btn[data-view="${mode}"]`)
    if (activeBtn) activeBtn.classList.add('active')
    document.querySelectorAll('.view-section').forEach(section => section.classList.remove('active'))
    const activeView = document.getElementById(`${mode}-view`)
    if (activeView) activeView.classList.add('active')
    if (mode === 'daily' && !ctx.selectedDate) {
      const dates = ctx.playDates
      if (dates.length > 0) ctx.selectedDate = dates[0].play_date.split('T')[0]
    }
    if (mode === 'season' && !ctx.selectedSeason) {
      const activeSeason = ctx.seasons.find(s => s.is_active)
      if (activeSeason) ctx.selectedSeason = activeSeason.id
    }
    render()
  }

  function setupViewModeUI() {
    document.querySelectorAll('.view-btn').forEach(btn => btn.classList.remove('active'))
    const activeBtn = document.querySelector(`.view-btn[data-view="${ctx.currentViewMode}"]`)
    if (activeBtn) activeBtn.classList.add('active')
    document.querySelectorAll('.view-section').forEach(section => section.classList.remove('active'))
    const activeView = document.getElementById(`${ctx.currentViewMode}-view`)
    if (activeView) activeView.classList.add('active')
  }

  function setupEventListeners() {
    const rankingDateSelect = document.getElementById('rankingDateSelect')
    if (rankingDateSelect) {
      rankingDateSelect.addEventListener('change', (e) => {
        ctx.selectedDate = e.target.value
        if (ctx.currentViewMode === 'daily') render()
      })
    }
    const seasonSelect = document.getElementById('seasonSelect')
    if (seasonSelect) {
      seasonSelect.addEventListener('change', (e) => {
        ctx.selectedSeason = parseInt(e.target.value)
        if (ctx.currentViewMode === 'season') render()
      })
    }
  }

  return { render, getRankEmoji, renderForm, updateDateSelector, updateRankingsSeasonSelector, switchViewMode, setupViewModeUI, setupEventListeners }
}
