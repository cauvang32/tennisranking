/**
 * Cups feature — cup tournament management: create, edit, participants,
 * bracket visualization, status transitions, score entry, conclusion images.
 *
 * This is the largest feature module. It covers:
 * 1. Cup list view with cards
 * 2. Cup detail view with participants, action buttons, bracket visualization
 * 3. Create cup modal (uses dedicated #cupsModal)
 * 4. Add participants modal with search, select all/deselect all, clickable cards
 * 5. Edit cup modal
 * 6. Bracket rendering with round labels (Chung kết, Bán kết, Tứ kết)
 * 7. Manual winner selection for bracket matches
 * 8. Score entry for in-progress matches
 * 9. Status transitions (draft -> scheduled -> in_progress -> completed/cancelled)
 * 10. Conclusion image upload for completed cups
 */

export function createCupsModule(ctx) {
  const {
    apiBase,
    escapeHtml,
    formatDate,
    showToast,
    showModal,
    hideModal,
    makeAuthenticatedRequest,
  } = ctx

  // Dedicated modal for cups — never hijack #loginModal
  const CUPS_MODAL = 'cupsModal'
  const CUPS_MODAL_CONTENT = 'cupsModalContent'

  const editingMatches = new Set()
  let currentCupId = null

  // ── DOM setup / event wiring ──────────────────────────────────────────

  function setupCupListeners() {
    const createBtn = document.getElementById('createCupBtn')
    if (createBtn) createBtn.addEventListener('click', () => showCreateCupModal())

    const backBtn = document.getElementById('backToCupsList')
    if (backBtn) backBtn.addEventListener('click', () => backToCupsList())

    // Event delegation for dynamically generated cup cards
    const cupsGrid = document.getElementById('cupsGrid')
    if (cupsGrid) {
      cupsGrid.addEventListener('click', (e) => {
        const actionBtn = e.target.closest('[data-action]')
        if (actionBtn) {
          const action = actionBtn.dataset.action
          const cupId = parseInt(actionBtn.dataset.cupId)
          if (action === 'add-participants') {
            e.stopPropagation()
            showAddParticipantsForCup(cupId)
          } else if (action === 'edit-cup') {
            e.stopPropagation()
            editCup(cupId)
          }
          return
        }
        // Click on card body → show detail
        const card = e.target.closest('[data-cup-id]')
        if (card) showCupDetail(parseInt(card.dataset.cupId))
      })
    }

    // Event delegation for cup detail content (action buttons, bracket controls, etc.)
    const cupDetailContent = document.getElementById('cupDetailContent')
    if (cupDetailContent) {
      cupDetailContent.addEventListener('click', (e) => _handleCupDetailClick(e))
      cupDetailContent.addEventListener('change', (e) => _handleCupDetailChange(e))
    }
  }

  // ── Cup list ──────────────────────────────────────────────────────────

  async function loadCups() {
    if (!ctx.serverMode) return
    try {
      const response = await makeAuthenticatedRequest('/cups')
      const data = await response.json().catch(() => null)
      if (!response.ok || !data || !Array.isArray(data)) {
        document.getElementById('cupsGrid').innerHTML = '<div class="empty-state"><p>Chưa có giải đấu nào</p></div>'
        return
      }
      renderCupList(data)
    } catch (error) {
      showToast('Lỗi khi tải danh sách giải đấu', 'error')
      console.error('Load cups error:', error)
    }
  }

  function renderCupList(cups) {
    const grid = document.getElementById('cupsGrid')
    if (!grid) return
    if (cups.length === 0) {
      grid.innerHTML = '<div class="empty-state"><p>Chưa có giải đấu nào. Nhấn "Tạo Giải Đấu Mới" để bắt đầu.</p></div>'
      return
    }
    const statusLabels = { draft: 'Bản nháp', scheduled: 'Đã lên lịch', in_progress: 'Đang diễn ra', completed: 'Hoàn thành', cancelled: 'Đã hủy' }
    const formatLabels = { single_elimination: 'Loại trực tiếp', double_elimination: 'Loại kép', round_robin: 'Vòng tròn' }
    grid.innerHTML = cups.map(cup => {
      const statusLabel = statusLabels[cup.status] || cup.status
      const formatLabel = formatLabels[cup.format] || cup.format
      const createdDate = formatDate(cup.created_at) || 'N/A'
      const seasonInfo = cup.season_id ? `<span>Mùa giải: ${escapeHtml(cup.season_name || 'ID ' + cup.season_id)}</span>` : ''
      return `
        <div class="image-editor-card" data-cup-id="${cup.id}">
          <div class="image-editor-header">
            <h3>🏆 ${escapeHtml(cup.name)}</h3>
            <span class="image-status-badge ${statusBadgeClass(cup.status)}">${statusLabel}</span>
          </div>
          <div class="cup-meta-info">
            <span>${formatLabel} | ${cup.num_teams} đội</span>
            ${seasonInfo}
          </div>
          <p class="form-hint mt-sm">Tạo: ${createdDate}</p>
          ${cup.status === 'draft' ? `
            <div class="cup-card-actions">
              <button class="btn btn-primary btn-sm" data-action="add-participants" data-cup-id="${cup.id}">👥 Thêm tham gia</button>
              <button class="btn btn-secondary btn-sm" data-action="edit-cup" data-cup-id="${cup.id}">✏️ Sửa</button>
            </div>
          ` : ''}
        </div>
      `
    }).join('')
  }

  // ── Cup detail view ───────────────────────────────────────────────────

  async function showCupDetail(cupId) {
    if (currentCupId !== cupId) {
      editingMatches.clear()
      currentCupId = cupId
    }
    // Reset DOM state IMMEDIATELY — before any API calls
    // Ensures consistent UI even if API fails or bfcache restores
    const cupsGrid = document.getElementById('cupsGrid')
    const createCupBtn = document.getElementById('createCupBtn')
    const cupDetail = document.getElementById('cupDetail')
    const cupDetailContent = document.getElementById('cupDetailContent')

    if (cupsGrid) cupsGrid.style.display = 'none'
    if (createCupBtn) createCupBtn.style.display = 'none'
    if (cupDetail) cupDetail.style.display = 'block'
    if (cupDetailContent) cupDetailContent.innerHTML = '<div class="spinner-wrapper"><div class="spinner"></div><p class="form-hint">Đang tải...</p></div>'

    try {
      const response = await makeAuthenticatedRequest(`/cups/${cupId}`)
      const cup = await response.json().catch(() => ({}))
      if (!response.ok || !cup) {
        return showToast(cup?.error || 'Không tìm thấy giải đấu', 'error')
      }

      // Load participants and bracket
      const [partRes, bracketRes] = await Promise.all([
        makeAuthenticatedRequest(`/cups/${cupId}/participants`),
        makeAuthenticatedRequest(`/cups/${cupId}/bracket`)
      ])
      const participants = (await partRes.json().catch(() => [])) || []
      const matches = (await bracketRes.json().catch(() => [])) || []

      const statusLabels = { draft: 'Bản nháp', scheduled: 'Đã lên lịch', in_progress: 'Đang diễn ra', completed: 'Hoàn thành', cancelled: 'Đã hủy' }
      const formatLabels = { single_elimination: 'Loại trực tiếp', double_elimination: 'Loại kép', round_robin: 'Vòng tròn' }

      let html = `
        <div class="cup-detail-header">
          <h2 class="section-title">🏆 ${escapeHtml(cup.name)}</h2>
          <div class="cup-badge-group">
            <span class="image-status-badge ${statusBadgeClass(cup.status)}">${statusLabels[cup.status] || cup.status}</span>
            <span class="cup-badge-text">${formatLabels[cup.format] || cup.format} | ${cup.num_teams} đội</span>
          </div>
        </div>
      `

      // Regulation
      if (cup.regulation_text) {
        html += `<div class="cup-regulation"><h4 class="cup-section-title-sm">📋 Quy định</h4><p>${escapeHtml(cup.regulation_text)}</p></div>`
      }

      // Participants
      html += `<div class="cup-info-section">
        <h4 class="cup-section-title">👥 Danh sách tham gia (${participants.length}/${cup.num_teams})</h4>
        <div class="cup-participant-grid">
      `
      participants.forEach(p => {
        const name = p.team_name || (p.player1_name + (p.player2_name ? ' & ' + p.player2_name : ''))
        const removeBtn = cup.status === 'draft' ? `<button class="remove-participant-btn" data-action="remove-participant" data-cup-id="${cupId}" data-participant-id="${p.id}" title="Xóa">&times;</button>` : ''
        html += `<div class="cup-participant-card">${p.seed ? `<span class="participant-seed">#${p.seed}</span>` : ''}<span class="participant-name">${escapeHtml(name)}</span>${removeBtn}</div>`
      })
      html += `</div></div>`

      // Action buttons based on cup status
      if (cup.status === 'draft') {
        html += `<div class="cup-actions-bar">
          <button class="btn btn-primary btn-sm" data-action="add-participants" data-cup-id="${cupId}">👥 Thêm người tham gia</button>
          <button class="btn btn-secondary btn-sm" data-action="edit-cup" data-cup-id="${cupId}">✏️ Sửa</button>
          <button class="btn btn-primary btn-sm" data-action="shuffle-seeds" data-cup-id="${cupId}">🔀 Xáo trộn hạt giống</button>
          <button class="btn btn-success btn-sm" data-action="generate-bracket" data-cup-id="${cupId}">📊 Tạo bảng đấu</button>
          <button class="btn btn-warning btn-sm" data-action="change-status" data-cup-id="${cupId}" data-status="scheduled">📅 Lên lịch</button>
          <button class="btn btn-danger btn-sm" data-action="delete-cup" data-cup-id="${cupId}">🗑️ Xóa</button>
        </div>`
      } else if (cup.status === 'scheduled') {
        html += `<div class="cup-actions-bar">
          <button class="btn btn-secondary btn-sm" data-action="edit-cup" data-cup-id="${cupId}">✏️ Sửa</button>
          <button class="btn btn-success btn-sm" data-action="change-status" data-cup-id="${cupId}" data-status="in_progress">▶️ Bắt đầu</button>
          <button class="btn btn-warning btn-sm" data-action="change-status" data-cup-id="${cupId}" data-status="cancelled">⏹️ Hủy</button>
        </div>`
      } else if (cup.status === 'in_progress') {
        html += `<div class="cup-actions-bar">
          <button class="btn btn-success btn-sm" data-action="change-status" data-cup-id="${cupId}" data-status="completed">✅ Hoàn thành</button>
          <button class="btn btn-warning btn-sm" data-action="change-status" data-cup-id="${cupId}" data-status="cancelled">⏹️ Hủy</button>
        </div>`
      } else if (cup.status === 'completed' || cup.status === 'cancelled') {
        // Post-tournament results section
        const hasConclusion = cup.conclusion_image_path
        html += `<div class="cup-conclusion-section">
          <h4 class="cup-section-title">🏆 Kết quả giải đấu</h4>
          <textarea id="cupFinalResults" class="input-field" rows="4" placeholder="Nhập kết quả cuối cùng...">${escapeHtml(cup.final_results || '')}</textarea>
          <div class="cup-form-actions">
            <button class="btn btn-primary btn-sm" data-action="save-final-results" data-cup-id="${cupId}">💾 Lưu kết quả</button>
          </div>
          <div class="mt-sm">
            <h4 class="cup-section-title-sm">📸 Ảnh tổng kết</h4>
            ${hasConclusion ? `
              <div id="cupConclusionPreview"><img class="cup-conclusion-image" src="${apiBase}/cups/${cupId}/conclusion-image/file"></div>
              <button class="btn btn-ghost btn-sm mt-sm" data-action="delete-conclusion-image" data-cup-id="${cupId}">🗑️ Xóa ảnh</button>
            ` : `
              <label class="btn btn-secondary btn-sm" style="cursor:pointer;display:inline-block;margin-top:8px;">
                📤 Tải lên ảnh tổng kết
                <input type="file" accept="image/*" style="display:none;" data-action="upload-conclusion-image" data-cup-id="${cupId}">
              </label>
            `}
          </div>
        </div>`
      }

      // Bracket visualization
      if (matches && matches.length > 0) {
        html += `<div class="cup-info-section cup-info-section-spaced">
          <h4 class="cup-section-title">📊 Bảng đấu</h4>
          <div class="bracket-scroll">${renderBracket(matches, cupId, cup.status)}</div>
        </div>`
      }

      document.getElementById('cupDetailContent').innerHTML = html
    } catch (error) {
      showToast('Lỗi khi tải chi tiết giải đấu', 'error')
      console.error('Cup detail error:', error)
      // Show error in the detail panel (DOM already set up above)
      if (cupDetailContent) {
        cupDetailContent.innerHTML = `<div class="spinner-wrapper">
          <p>⚠️ Không thể tải chi tiết giải đấu</p>
          <p class="form-hint">${escapeHtml(error.message || 'Lỗi kết nối')}</p>
        </div>`
      }
    }
  }

  // Bracket rendering — manual progression: no auto-advance, shuffle on "Tiếp tục"

  function renderBracket(matches, cupId, cupStatus) {
    if (!matches || matches.length === 0) return '<p class="form-hint">Chưa có bảng đấu</p>'
    const rounds = {}
    matches.forEach(m => {
      if (!rounds[m.round_number]) rounds[m.round_number] = []
      rounds[m.round_number].push(m)
    })
    const maxRounds = Math.max(...Object.keys(rounds).map(Number))
    const roundNames = {}
    for (let r = 1; r <= maxRounds; r++) {
      const fromEnd = maxRounds - r
      if (fromEnd === 0) roundNames[r] = 'Chung kết'
      else if (fromEnd === 1) roundNames[r] = 'Bán kết'
      else if (fromEnd === 2) roundNames[r] = 'Tứ kết'
      else roundNames[r] = `Vòng ${r}`
    }
    const isRoundComplete = (roundNum) => {
      const roundMatches = rounds[roundNum]
      if (!roundMatches || roundMatches.length === 0) return true
      return roundMatches.every(m => m.status === 'completed' || m.status === 'locked')
    }
    const isRoundLocked = (roundNum) => {
      const roundMatches = rounds[roundNum]
      if (!roundMatches || roundMatches.length === 0) return false
      return roundMatches.every(m => m.status === 'locked')
    }
    let activeRound = 0
    for (let r = 1; r <= maxRounds; r++) {
      if (!isRoundLocked(r) && !isRoundComplete(r)) {
        activeRound = r
        break
      }
    }

    let html = '<div class="bracket-container">'
    for (let r = 1; r <= maxRounds; r++) {
      const roundMatches = rounds[r] || []
      const rName = roundNames[r] || `Vòng ${r}`
      const locked = isRoundLocked(r)
      const complete = isRoundComplete(r)
      const isFutureRound = r > activeRound

      html += `<div class="bracket-round ${locked ? 'bracket-round-locked' : ''}">`
      html += `<h5 class="bracket-round-title">${rName}`
      if (locked) html += ' <span style="font-size:0.75em;opacity:0.7;">🔒 Đã khóa</span>'
      if (isFutureRound) html += ' <small style="opacity:0.6;font-weight:normal;">(chờ vòng trước)</small>'
      html += `</h5>`

      roundMatches.forEach(m => {
        const t1Name = m.t1_team_name || (m.t1_p1_name || (isFutureRound ? 'Chờ vòng trước' : 'Chưa xác định'))
        const t2Name = m.t2_team_name || (m.t2_p1_name || (isFutureRound ? 'Chờ vòng trước' : 'Chưa xác định'))
        const t1Score = m.team1_score !== null ? m.team1_score : '-'
        const t2Score = m.team2_score !== null ? m.team2_score : '-'
        const isWinner1 = m.winner_participant_id === m.team1_participant_id
        const isWinner2 = m.winner_participant_id === m.team2_participant_id
        const matchClass = (m.status === 'completed' || m.status === 'locked') ? 'completed' : ''
        const prevRoundDone = r === 1 || isRoundComplete(r - 1)
        const canEdit = cupStatus === 'in_progress' && !locked && prevRoundDone
        const canPickWinner = canEdit && m.status === 'completed' && m.team1_participant_id !== null && m.team2_participant_id !== null
        const t1Pid = m.team1_participant_id
        const t2Pid = m.team2_participant_id

        html += `<div class="bracket-match ${matchClass}">`
        html += `<div class="bracket-match-number">Trận ${m.match_number}</div>`
        html += `<div class="bracket-team ${isWinner1 ? 'winner' : ''} ${canPickWinner ? 'clickable' : ''}">`
        if (canPickWinner && t1Pid) {
          html += `<button class="btn-winner-pick" data-action="set-match-winner" data-cup-id="${cupId}" data-match-id="${m.id}" data-winner-pid="${t1Pid}" title="Chọn người thắng">🏆</button>`
        }
        html += `<span>${escapeHtml(t1Name)}</span>`
        html += `<span class="bracket-score">${t1Score}</span>`
        html += `</div>`
        html += `<div class="bracket-team ${isWinner2 ? 'winner' : ''} ${canPickWinner ? 'clickable' : ''}">`
        if (canPickWinner && t2Pid) {
          html += `<button class="btn-winner-pick" data-action="set-match-winner" data-cup-id="${cupId}" data-match-id="${m.id}" data-winner-pid="${t2Pid}" title="Chọn người thắng">🏆</button>`
        }
        html += `<span>${escapeHtml(t2Name)}</span>`
        html += `<span class="bracket-score">${t2Score}</span>`
        html += `</div>`

        const isEditing = editingMatches.has(m.id)

        if ((cupStatus === 'scheduled' || (cupStatus === 'in_progress' && prevRoundDone)) && !locked && !isEditing) {
          html += `<div class="bracket-date-row">`
          html += `<input type="date" class="input-field input-sm bracket-input-flex" id="date_${m.id}" value="${m.play_date || ''}">`
          html += `<button class="btn btn-sm btn-secondary" data-action="schedule-match-date" data-cup-id="${cupId}" data-match-id="${m.id}">📅</button>`
          html += `</div>`
        }

        if (cupStatus === 'in_progress' && m.status === 'scheduled' && !locked && prevRoundDone && m.team1_participant_id !== null && m.team2_participant_id !== null) {
          html += `<div class="bracket-score-row">`
          html += `<input type="number" min="0" value="0" class="input-field input-sm bracket-input-sm" id="score1_${m.id}">`
          html += `<input type="number" min="0" value="0" class="input-field input-sm bracket-input-sm" id="score2_${m.id}">`
          html += `<button class="btn btn-sm btn-primary btn-flex-fill" data-action="update-match-score" data-cup-id="${cupId}" data-match-id="${m.id}">Ghi điểm</button>`
          html += `</div>`
        }

        if (cupStatus === 'in_progress' && isEditing && !locked && prevRoundDone) {
          html += `<div class="bracket-score-row">`
          html += `<input type="number" min="0" value="${m.team1_score !== null ? m.team1_score : 0}" class="input-field input-sm bracket-input-sm" id="score1_${m.id}">`
          html += `<input type="number" min="0" value="${m.team2_score !== null ? m.team2_score : 0}" class="input-field input-sm bracket-input-sm" id="score2_${m.id}">`
          html += `<button class="btn btn-sm btn-primary btn-flex-fill" data-action="save-match-score" data-cup-id="${cupId}" data-match-id="${m.id}">Lưu</button>`
          html += `<button class="btn btn-sm btn-secondary btn-flex-fill" data-action="cancel-edit-match" data-cup-id="${cupId}" data-match-id="${m.id}">Hủy</button>`
          html += `</div>`
        }

        if (cupStatus === 'in_progress' && m.status === 'completed' && !locked && prevRoundDone && !isEditing) {
          html += `<div class="bracket-score-row">`
          html += `<button class="btn btn-sm btn-secondary btn-flex-fill" data-action="edit-match-score" data-cup-id="${cupId}" data-match-id="${m.id}">✏️ Sửa</button>`
          html += `<button class="btn btn-sm btn-danger btn-flex-fill" data-action="reset-match-score" data-cup-id="${cupId}" data-match-id="${m.id}">🗑️ Reset</button>`
          html += `</div>`
        }

        if (locked) {
          html += `<div class="bracket-score-row" style="opacity:0.5;"><span class="form-hint">Đã khóa — không thể chỉnh sửa</span></div>`
        }

        html += `</div>`
      })

      if (complete && !locked && cupStatus === 'in_progress') {
        const isFinalRound = r === maxRounds
        const btnText = isFinalRound ? '🏆 Hoàn thành giải đấu' : '⏭️ Tiếp tục vòng tiếp theo'
        html += `<div class="bracket-round-actions"><button class="btn btn-success btn-sm" data-action="advance-round" data-cup-id="${cupId}" data-from-round="${r}">${btnText}</button></div>`
      }

      html += `</div>`
    }
    html += '</div>'
    return html
  }

  // ── Status badge helper ───────────────────────────────────────────────

  function statusBadgeClass(status) {
    return status ? `badge-${status}` : 'badge-draft'
  }

  // ── API helper ────────────────────────────────────────────────────────

  async function _cupApiCall(path, options = {}) {
    try {
      const res = await makeAuthenticatedRequest(path, options)
      // Parse JSON safely — handle non-JSON responses (e.g., HTML error pages from proxies)
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        // Server returned an error status — report it clearly
        console.error(`Cup API error [${res.status}] ${path}:`, data)
        showToast(data?.error || `Lỗi server (${res.status})`, 'error')
        return null
      }
      return data
    } catch (error) {
      console.error(`Cup API exception ${path}:`, error)
      showToast(error.message || 'Lỗi kết nối', 'error')
      return null
    }
  }

  // ── CSP-compliant event delegation ────────────────────────────────────
  // All dynamically generated HTML uses data-action attributes instead of
  // inline onclick/onchange handlers (blocked by CSP scriptSrcAttr: 'none').

  function _handleCupDetailClick(e) {
    const btn = e.target.closest('[data-action]')
    if (!btn) return

    const action = btn.dataset.action
    const cupId = parseInt(btn.dataset.cupId)
    const matchId = btn.dataset.matchId ? parseInt(btn.dataset.matchId) : null
    const participantId = btn.dataset.participantId ? parseInt(btn.dataset.participantId) : null
    const status = btn.dataset.status || null

    switch (action) {
      case 'add-participants':
        showAddParticipantsForCup(cupId)
        break
      case 'edit-cup':
        editCup(cupId)
        break
      case 'shuffle-seeds':
        shuffleCupSeeds(cupId)
        break
      case 'generate-bracket':
        generateCupBracket(cupId)
        break
      case 'change-status':
        changeCupStatus(cupId, status)
        break
      case 'delete-cup':
        deleteCup(cupId)
        break
      case 'remove-participant':
        e.stopPropagation()
        removeCupParticipant(cupId, participantId)
        break
      case 'save-final-results':
        saveCupFinalResults(cupId)
        break
      case 'delete-conclusion-image':
        deleteCupConclusionImage(cupId)
        break
      case 'schedule-match-date':
        scheduleMatchDate(cupId, matchId)
        break
      case 'update-match-score':
        updateMatchScore(cupId, matchId)
        break
      case 'set-match-winner': {
        const winnerPid = parseInt(btn.dataset.winnerPid, 10)
        if (!isNaN(winnerPid)) setCupMatchWinner(cupId, matchId, winnerPid)
        break
      }
      case 'advance-round': {
        const fromRound = parseInt(btn.dataset.fromRound, 10)
        if (!isNaN(fromRound)) advanceRound(cupId, fromRound)
        break
      }
      case 'edit-match-score': {
        if (matchId) {
          editingMatches.add(matchId)
          showCupDetail(cupId)
        }
        break
      }
      case 'cancel-edit-match': {
        if (matchId) {
          editingMatches.delete(matchId)
          showCupDetail(cupId)
        }
        break
      }
      case 'save-match-score': {
        if (matchId) updateMatchScore(cupId, matchId)
        break
      }
      case 'reset-match-score': {
        if (matchId) resetCupMatch(cupId, matchId)
        break
      }
    }
  }

  function _handleCupDetailChange(e) {
    const input = e.target.closest('[data-action]')
    if (!input) return

    const action = input.dataset.action
    const cupId = parseInt(input.dataset.cupId)

    if (action === 'upload-conclusion-image') {
      uploadCupConclusionImage(e, cupId)
    }
  }

  // ── Create cup modal ──────────────────────────────────────────────────

  async function showCreateCupModal() {
    try {
      // Load players and seasons for dropdowns
      const [playersRes, seasonsRes] = await Promise.all([
        makeAuthenticatedRequest('/players'),
        makeAuthenticatedRequest('/seasons')
      ])

      if (!playersRes.ok) {
        const err = await playersRes.json().catch(() => ({}))
        throw new Error(err?.error || 'Không tải được danh sách người chơi')
      }
      if (!seasonsRes.ok) {
        const err = await seasonsRes.json().catch(() => ({}))
        throw new Error(err?.error || 'Không tải được danh sách mùa giải')
      }

      const [playersPayload, seasonsPayload] = await Promise.all([
        playersRes.json(),
        seasonsRes.json()
      ])

      const players = Array.isArray(playersPayload)
        ? playersPayload
        : Array.isArray(playersPayload?.data)
          ? playersPayload.data
          : []
      const seasons = Array.isArray(seasonsPayload)
        ? seasonsPayload
        : Array.isArray(seasonsPayload?.data)
          ? seasonsPayload.data
          : []

      const content = document.getElementById(CUPS_MODAL_CONTENT)
      if (!content) return

      content.innerHTML = `
      <div class="modal-header">
        <h3 class="modal-title">🏆 Tạo Giải Đấu Cúp</h3>
        <button class="modal-close" data-dismiss="modal">&times;</button>
      </div>
      <div class="modal-body">
        <form id="createCupForm">
          <div class="cup-form-group">
            <label>Tên giải đấu *</label>
            <input type="text" id="cupName" class="input-field" required placeholder="VD: Cúp Vô Địch 2025">
          </div>
          <div class="cup-form-group">
            <label>Liên kết mùa giải (tùy chọn)</label>
            <select id="cupSeasonId" class="input-field">
              <option value="">-- Không liên kết --</option>
              ${(seasons || []).map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}
            </select>
          </div>
          <div class="cup-form-group">
            <label>Định dạng *</label>
            <select id="cupFormat" class="input-field">
              <option value="single_elimination">Loại trực tiếp</option>
            </select>
            <small class="cup-form-hint">Hiện chỉ hỗ trợ định dạng loại trực tiếp</small>
          </div>
          <div class="cup-form-group">
            <label>Số đội *</label>
            <select id="cupNumTeams" class="input-field">
              <option value="4">4 đội</option>
              <option value="8" selected>8 đội</option>
              <option value="16">16 đội</option>
              <option value="32">32 đội</option>
            </select>
          </div>
          <div class="cup-form-group">
            <label>Quy định (tùy chọn)</label>
            <textarea id="cupRegulation" class="input-field" rows="3" placeholder="Luật chơi, quy định đặc biệt..."></textarea>
          </div>
          <div class="cup-form-actions">
            <button type="button" class="btn btn-ghost" data-dismiss="modal">Hủy</button>
            <button type="submit" class="btn btn-primary">Tạo giải đấu</button>
          </div>
        </form>
      </div>
    `

      // Show modal using standard helper
      showModal(CUPS_MODAL)

      // Handle submit
      const form = content.querySelector('#createCupForm')
      if (form) {
        form.addEventListener('submit', async (e) => {
          e.preventDefault()
          const result = await createCup(players)
          if (!result) return // createCup already showed error; keep modal open
          hideModal(CUPS_MODAL)
        })
      }
    } catch (error) {
      showToast(error.message || 'Lỗi khi mở hộp thoại tạo giải đấu', 'error')
    }
  }

  // ── Create cup via API ────────────────────────────────────────────────

  async function createCup(players) {
    try {
      const name = document.getElementById('cupName').value.trim()
      if (!name) return showToast('Vui lòng nhập tên giải đấu', 'error')

      const seasonIdVal = document.getElementById('cupSeasonId').value
      const format = document.getElementById('cupFormat').value
      const numTeams = parseInt(document.getElementById('cupNumTeams').value)
      const regulationText = document.getElementById('cupRegulation').value.trim()

      const body = { name, format, numTeams }
      if (seasonIdVal) body.seasonId = parseInt(seasonIdVal)
      if (regulationText) body.regulationText = regulationText

      const data = await _cupApiCall('/cups', {
        method: 'POST',
        body: JSON.stringify(body)
      })
      if (data?.success) {
        showToast('Đã tạo giải đấu mới!', 'success')
        // Now show participant selection
        await showAddParticipantsModal(data.id, players, numTeams)
        return true
      }
      return false
    } catch (error) {
      showToast(error.message || 'Lỗi khi tạo giải đấu', 'error')
      return false
    }
  }

  // ── Participant management ────────────────────────────────────────────

  // Open the participant-selection modal for an existing cup (button on list card or detail view)
  async function showAddParticipantsForCup(cupId) {
    try {
      // First fetch cup info to know max teams
      const cupRes = await makeAuthenticatedRequest(`/cups/${cupId}`)
      const cup = await cupRes.json().catch(() => ({}))
      if (!cupRes.ok || !cup) {
        return showToast(cup?.error || 'Không tìm thấy giải đấu', 'error')
      }

      // Load players and existing participants in parallel (independent of each other)
      const [playersRes, partRes] = await Promise.all([
        makeAuthenticatedRequest('/players'),
        makeAuthenticatedRequest(`/cups/${cupId}/participants`)
      ])

      const playersPayload = await playersRes.json().catch(() => null)
      if (!playersRes.ok) {
        throw new Error(playersPayload?.error || 'Không tải được danh sách người chơi')
      }
      const players = Array.isArray(playersPayload)
        ? playersPayload
        : Array.isArray(playersPayload?.data)
          ? playersPayload.data
          : []

      const participantsPayload = await partRes.json().catch(() => null)
      const existingParticipants = Array.isArray(participantsPayload) ? participantsPayload : []
      const existingPlayerIds = new Set(
        existingParticipants.map(p => p.player1_id)
      )

      await showAddParticipantsModal(cupId, players, cup.num_teams || 8, existingPlayerIds, existingParticipants)
    } catch (error) {
      console.error('showAddParticipantsForCup error:', error)
      showToast(error.message || 'Lỗi khi mở hộp thoại thêm người tham gia', 'error')
    }
  }

  async function showAddParticipantsModal(cupId, players, maxTeams, existingPlayerIds = new Set(), existingParticipants = []) {
    const content = document.getElementById(CUPS_MODAL_CONTENT)
    if (!content) return

    content.innerHTML = `
      <div class="modal-header">
        <h3 class="modal-title">👥 Thêm Người Tham Gia</h3>
        <button class="modal-close" data-dismiss="modal">&times;</button>
      </div>
      <div class="modal-body">
        <p class="form-hint">Chọn ${maxTeams} người chơi để tạo đội (mỗi người chơi = 1 đội đánh đơn)</p>

        <!-- Search bar -->
        <input type="text" id="participantSearch" class="input-field participant-search" placeholder="🔍 Tìm kiếm người chơi...">

        <!-- Select all / Deselect all -->
        <div class="participant-select-all-bar">
          <span id="participantCount" class="participant-count">Đã chọn: 0/${maxTeams}</span>
          <div class="participant-select-buttons">
            <button class="btn btn-ghost btn-sm" id="selectAllParticipants">Chọn tất cả</button>
            <button class="btn btn-ghost btn-sm" id="deselectAllParticipants">Bỏ tất cả</button>
          </div>
        </div>

        <!-- Grid of clickable player cards -->
        <div class="participant-grid" id="participantGrid">
          ${(players || []).map(p => `
            <div class="participant-card" data-player-id="${p.id}">
              <span class="check-icon">✓</span>
              <span class="player-name">${escapeHtml(p.name)}</span>
            </div>
          `).join('')}
        </div>

        <!-- Footer with cancel/confirm -->
        <div class="participant-footer">
          <button class="btn btn-ghost" data-dismiss="modal">Hủy</button>
          <button class="btn btn-primary" id="confirmParticipantsBtn">Xác nhận</button>
        </div>
      </div>
    `

    showModal(CUPS_MODAL)

    // Store selected player IDs in a Set for easy management
    // Pre-select existing participants
    const selectedIds = new Set(existingPlayerIds)

    // Map from player1_id to participant_id for tracking existing participants
    const existingPartMap = {}
    existingParticipants.forEach(p => {
      existingPartMap[p.player1_id] = p.id
    })

    // Apply pre-selection in the DOM
    content.querySelectorAll('.participant-card').forEach(card => {
      const playerId = parseInt(card.dataset.playerId)
      if (existingPlayerIds.has(playerId)) {
        card.classList.add('selected')
      }
    })

    // Update counter display
    const updateCount = () => {
      const countEl = document.getElementById('participantCount')
      if (countEl) countEl.textContent = `Đã chọn: ${selectedIds.size}/${maxTeams}`
    }
    updateCount() // Initial count reflects existing participants

    // Click handler for participant cards
    content.querySelectorAll('.participant-card').forEach(card => {
      card.addEventListener('click', () => {
        const playerId = parseInt(card.dataset.playerId)
        if (selectedIds.has(playerId)) {
          selectedIds.delete(playerId)
          card.classList.remove('selected')
        } else {
          selectedIds.add(playerId)
          card.classList.add('selected')
        }
        updateCount()
      })
    })

    // Search filter
    const searchInput = document.getElementById('participantSearch')
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const query = searchInput.value.toLowerCase().trim()
        content.querySelectorAll('.participant-card').forEach(card => {
          const name = card.querySelector('.player-name').textContent.toLowerCase()
          card.style.display = name.includes(query) ? '' : 'none'
        })
      })
    }

    // Select all — only visible (non-hidden by search filter) cards
    const selectAllBtn = document.getElementById('selectAllParticipants')
    if (selectAllBtn) {
      selectAllBtn.addEventListener('click', () => {
        content.querySelectorAll('.participant-card').forEach(card => {
          if (card.style.display === 'none') return
          const playerId = parseInt(card.dataset.playerId)
          selectedIds.add(playerId)
          card.classList.add('selected')
        })
        updateCount()
      })
    }

    // Deselect all
    const deselectAllBtn = document.getElementById('deselectAllParticipants')
    if (deselectAllBtn) {
      deselectAllBtn.addEventListener('click', () => {
        content.querySelectorAll('.participant-card.selected').forEach(card => {
          const playerId = parseInt(card.dataset.playerId)
          selectedIds.delete(playerId)
          card.classList.remove('selected')
        })
        updateCount()
      })
    }

    // Wire up confirm button
    const confirmBtn = content.querySelector('#confirmParticipantsBtn')
    if (confirmBtn) {
      confirmBtn.addEventListener('click', () => {
        confirmCupParticipants(cupId, maxTeams, selectedIds, existingPlayerIds, existingPartMap)
      })
    }
  }

  async function confirmCupParticipants(cupId, maxTeams, selectedIds, previousPlayerIds = new Set(), existingPartMap = {}) {
    const selected = Array.from(selectedIds)
    const minRequired = Math.min(maxTeams, 2)
    if (selected.length < minRequired) return showToast(`Cần ít nhất ${minRequired} người tham gia`, 'error')
    if (selected.length > maxTeams) return showToast(`Tối đa ${maxTeams} đội`, 'error')

    try {
      // Compute additions: in current selection but NOT in previous
      const additions = selected.filter(pid => !previousPlayerIds.has(pid))
      // Compute removals: in previous but NOT in current selection (use Set.has for O(1))
      const removals = Array.from(previousPlayerIds).filter(pid => !selectedIds.has(pid))

      // Remove participants first (if any were deselected)
      let removed = 0
      for (const pid of removals) {
        const partId = existingPartMap[pid]
        if (partId) {
          const data = await _cupApiCall(`/cups/${cupId}/participants/${partId}`, { method: 'DELETE' })
          if (data?.success) removed++
        }
      }

      // Add new participants
      let added = 0
      for (let i = 0; i < additions.length; i++) {
        const data = await _cupApiCall(`/cups/${cupId}/participants`, {
          method: 'POST',
          body: JSON.stringify({ player1Id: additions[i], seed: i + 1 })
        })
        if (data?.success) added++
      }

      if (added > 0 || removed > 0) {
        let msg = ''
        if (added > 0) msg += `Thêm ${added}`
        if (removed > 0) msg += ` ${added > 0 ? ',' : ''} Xóa ${removed}`
        showToast(msg.trim(), 'success')
      } else if (selected.length > 0) {
        showToast('Không có thay đổi', 'success')
      }

      // Close modal and show cup detail
      hideModal(CUPS_MODAL)
      await showCupDetail(cupId)
    } catch (error) {
      showToast('Lỗi khi cập nhật người tham gia', 'error')
    }
  }

  // ── Navigation ────────────────────────────────────────────────────────

  function backToCupsList() {
    const cupsGrid = document.getElementById('cupsGrid')
    const createCupBtn = document.getElementById('createCupBtn')
    const cupDetail = document.getElementById('cupDetail')
    if (cupsGrid) cupsGrid.style.display = ''
    if (createCupBtn) createCupBtn.style.display = ''
    if (cupDetail) cupDetail.style.display = 'none'
    loadCups()
  }

  // ── Edit cup ──────────────────────────────────────────────────────────

  async function editCup(cupId) {
    try {
      const response = await makeAuthenticatedRequest(`/cups/${cupId}`)
      const cup = await response.json().catch(() => ({}))
      if (!response.ok || !cup) {
        return showToast(cup?.error || 'Không tìm thấy giải đấu', 'error')
      }

      // Load seasons for dropdown
      const seasonsRes = await makeAuthenticatedRequest('/seasons')
      const seasonsPayload = await seasonsRes.json().catch(() => null)
      if (!seasonsRes.ok) {
        throw new Error(seasonsPayload?.error || 'Không tải được danh sách mùa giải')
      }
      const seasons = Array.isArray(seasonsPayload)
        ? seasonsPayload
        : Array.isArray(seasonsPayload?.data)
          ? seasonsPayload.data
          : []

      const content = document.getElementById(CUPS_MODAL_CONTENT)
      if (!content) return

      content.innerHTML = `
        <div class="modal-header">
          <h3 class="modal-title">✏️ Sửa Giải Đấu</h3>
          <button class="modal-close" data-dismiss="modal">&times;</button>
        </div>
        <div class="modal-body">
          <form id="editCupForm">
            <div class="cup-form-group">
              <label>Tên giải đấu *</label>
              <input type="text" id="editCupName" class="input-field" required value="${escapeHtml(cup.name)}">
            </div>
            <div class="cup-form-group">
              <label>Liên kết mùa giải</label>
              <select id="editCupSeasonId" class="input-field">
                <option value="">-- Không liên kết --</option>
                ${(seasons || []).map(s => `<option value="${s.id}" ${s.id === cup.season_id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
              </select>
            </div>
            <div class="cup-form-group">
              <label>Ngày bắt đầu</label>
              <input type="date" id="editCupStartDate" class="input-field" value="${cup.start_date || ''}">
            </div>
            <div class="cup-form-group">
              <label>Ngày kết thúc</label>
              <input type="date" id="editCupEndDate" class="input-field" value="${cup.end_date || ''}">
            </div>
            <div class="cup-form-group">
              <label>Quy định</label>
              <textarea id="editCupRegulation" class="input-field" rows="3">${escapeHtml(cup.regulation_text || '')}</textarea>
            </div>
            ${cup.status !== 'draft' ? `<small class="cup-form-hint">⚠️ Chỉ có thể sửa tên, ngày, quy định khi đã lên lịch.</small>` : ''}
            <div class="cup-form-actions">
              <button type="button" class="btn btn-ghost" data-dismiss="modal">Hủy</button>
              <button type="submit" class="btn btn-primary">Lưu thay đổi</button>
            </div>
          </form>
        </div>
      `

      showModal(CUPS_MODAL)

      const form = content.querySelector('#editCupForm')
      if (form) {
        form.addEventListener('submit', async (e) => {
          e.preventDefault()
          const result = await updateCup(cupId)
          if (!result) return // updateCup already showed error; keep modal open
          hideModal(CUPS_MODAL)
        })
      }
    } catch (error) {
      console.error('editCup error:', error)
      showToast('Lỗi khi tải thông tin giải đấu', 'error')
    }
  }

  async function updateCup(cupId) {
    try {
      const name = document.getElementById('editCupName').value.trim()
      if (!name) return showToast('Vui lòng nhập tên giải đấu', 'error')

      const body = { name }
      const seasonId = document.getElementById('editCupSeasonId').value
      if (seasonId) body.seasonId = parseInt(seasonId)
      const startDate = document.getElementById('editCupStartDate').value
      if (startDate) body.startDate = startDate
      const endDate = document.getElementById('editCupEndDate').value
      if (endDate) body.endDate = endDate
      const regulationText = document.getElementById('editCupRegulation').value.trim()
      if (regulationText) body.regulationText = regulationText

      const data = await _cupApiCall(`/cups/${cupId}`, {
        method: 'PUT',
        body: JSON.stringify(body)
      })
      if (data?.success) {
        showToast('Đã lưu thay đổi!', 'success')
        await showCupDetail(cupId)
        return true
      }
      return false
    } catch (error) {
      showToast(error.message || 'Lỗi khi lưu thay đổi', 'error')
      return false
    }
  }

  // ── Cup lifecycle actions ─────────────────────────────────────────────

  async function shuffleCupSeeds(cupId) {
    if (!confirm('Xáo trộn hạt giống? Thứ tự đội sẽ được random.')) return
    const data = await _cupApiCall(`/cups/${cupId}/seed-shuffle`, { method: 'POST' })
    if (data?.success) {
      ctx.invalidateCache(['cups'])
      showToast('Đã xáo trộn hạt giống!', 'success')
      await showCupDetail(cupId)
    }
  }

  async function generateCupBracket(cupId) {
    if (!confirm('Tạo bảng đấu? Hành động này sẽ chuyển giải đấu sang trạng thái "Đã lên lịch".')) return
    const data = await _cupApiCall(`/cups/${cupId}/generate-bracket`, { method: 'POST' })
    if (data?.success) {
      ctx.invalidateCache(['cups'])
      showToast(`Đã tạo bảng đấu! ${data.matchesCount} trận`, 'success')
      await showCupDetail(cupId)
    }
  }

  async function changeCupStatus(cupId, newStatus) {
    const labels = { scheduled: 'lên lịch', in_progress: 'bắt đầu', completed: 'hoàn thành', cancelled: 'hủy' }
    if (!confirm(`Bạn có chắc muốn ${labels[newStatus] || 'thay đổi trạng thái'} giải đấu?`)) return
    const data = await _cupApiCall(`/cups/${cupId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status: newStatus })
    })
    if (data?.success) {
      ctx.invalidateCache(['cups'])
      showToast('Đã thay đổi trạng thái', 'success')
      await showCupDetail(cupId)
    }
  }

  async function deleteCup(cupId) {
    if (!confirm('Bạn có chắc muốn xóa giải đấu này? Hành động này không thể hoàn tác.')) return
    const data = await _cupApiCall(`/cups/${cupId}`, { method: 'DELETE' })
    if (data?.success) {
      ctx.invalidateCache(['cups'])
      showToast('Đã xóa giải đấu', 'success')
      backToCupsList()
    }
  }

  async function removeCupParticipant(cupId, participantId) {
    if (!confirm('Bạn có chắc muốn xóa người tham gia này?')) return
    const data = await _cupApiCall(`/cups/${cupId}/participants/${participantId}`, { method: 'DELETE' })
    if (data?.success) {
      ctx.invalidateCache(['cups'])
      showToast('Đã xóa người tham gia', 'success')
      await showCupDetail(cupId)
    }
  }

  // ── Match-level actions within bracket ────────────────────────────────

  async function scheduleMatchDate(cupId, matchId) {
    const dateEl = document.getElementById(`date_${matchId}`)
    if (!dateEl || !dateEl.value) return showToast('Vui lòng chọn ngày', 'error')
    const data = await _cupApiCall(`/cups/${cupId}/matches/${matchId}/date`, {
      method: 'PUT',
      body: JSON.stringify({ playDate: dateEl.value })
    })
    if (data?.success) {
      ctx.invalidateCache(['cups'])
      showToast('Đã lên lịch trận đấu!', 'success')
      await showCupDetail(cupId)
    }
  }

  async function updateMatchScore(cupId, matchId) {
    const score1El = document.getElementById(`score1_${matchId}`)
    const score2El = document.getElementById(`score2_${matchId}`)
    if (!score1El || !score2El) return
    const s1 = parseInt(score1El.value) || 0
    const s2 = parseInt(score2El.value) || 0

    const data = await _cupApiCall(`/cups/${cupId}/matches/${matchId}`, {
      method: 'PUT',
      body: JSON.stringify({ team1Score: s1, team2Score: s2 })
    })
    if (data?.success) {
      editingMatches.delete(matchId)
      ctx.invalidateCache(['cups'])
      if (data.roundComplete) {
        showToast(`Ghi điểm ${s1}-${s2} thành công! ⏭️ Vòng đã hoàn thành — nhấn "Chuyển sang vòng tiếp theo"`, 'success')
      } else {
        showToast(`Ghi điểm ${s1}-${s2} thành công!`, 'success')
      }
      await showCupDetail(cupId)
    }
  }

  async function resetCupMatch(cupId, matchId) {
    if (!confirm('Bạn có chắc muốn xoá kết quả trận đấu này?')) return
    const data = await _cupApiCall(`/cups/${cupId}/matches/${matchId}/reset`, {
      method: 'PUT'
    })
    if (data?.success) {
      editingMatches.delete(matchId)
      ctx.invalidateCache(['cups'])
      showToast('Đã xoá kết quả trận đấu!', 'success')
      await showCupDetail(cupId)
    }
  }

  async function setCupMatchWinner(cupId, matchId, winnerParticipantId) {
    const data = await _cupApiCall(`/cups/${cupId}/matches/${matchId}/winner`, {
      method: 'PUT',
      body: JSON.stringify({ winnerParticipantId })
    })
    if (data?.success) {
      ctx.invalidateCache(['cups'])
      if (data.roundComplete) {
        showToast('Đã chọn người thắng! ⏭️ Vòng đã hoàn thành — nhấn "Chuyển sang vòng tiếp theo"', 'success')
      } else {
        showToast('Đã chọn người thắng!', 'success')
      }
      await showCupDetail(cupId)
    }
  }

  async function advanceRound(cupId, fromRound) {
    if (!confirm('Xáo trộn người thắng và chuyển sang vòng tiếp theo?')) return
    const data = await _cupApiCall(`/cups/${cupId}/advance-round`, {
      method: 'POST',
      body: JSON.stringify({ fromRound })
    })
    if (data?.success) {
      ctx.invalidateCache(['cups'])
      if (data.isFinal) {
        showToast('🏆 Giải đấu đã hoàn thành!', 'success')
      } else {
        showToast('⏭️ Đã chuyển sang vòng tiếp theo (xáo trộn người thắng)', 'success')
      }
      await showCupDetail(cupId)
    }
  }

  // ── Conclusion image management ───────────────────────────────────────

  async function saveCupFinalResults(cupId) {
    const textEl = document.getElementById('cupFinalResults')
    if (!textEl) return
    const text = textEl.value.trim()
    if (!text) return showToast('Vui lòng nhập kết quả giải đấu', 'error')
    const data = await _cupApiCall(`/cups/${cupId}`, {
      method: 'PUT',
      body: JSON.stringify({ finalResults: text })
    })
    if (data?.success) {
      ctx.invalidateCache(['cups'])
      showToast('Đã lưu kết quả giải đấu!', 'success')
      await showCupDetail(cupId)
    }
  }

  async function uploadCupConclusionImage(e, cupId) {
    const input = e.target
    if (!input.files || !input.files[0]) return
    const file = input.files[0]
    if (file.size > 10 * 1024 * 1024) {
      showToast('File quá lớn (tối đa 10MB)', 'error')
      input.value = ''
      return
    }
    try {
      const formData = new FormData()
      formData.append('image', file)
      const res = await makeAuthenticatedRequest(`/cups/${cupId}/conclusion-image`, {
        method: 'POST',
        body: formData
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.success) {
        showToast(data?.error || 'Lỗi khi tải lên', 'error')
      } else {
        ctx.invalidateCache(['cups'])
        showToast('Đã tải lên ảnh tổng kết!', 'success')
        await showCupDetail(cupId)
      }
    } catch (error) {
      showToast(error.message || 'Lỗi kết nối', 'error')
    }
    input.value = ''
  }

  async function deleteCupConclusionImage(cupId) {
    if (!confirm('Bạn có chắc muốn xóa ảnh tổng kết?')) return
    const data = await _cupApiCall(`/cups/${cupId}/conclusion-image`, { method: 'DELETE' })
    if (data?.success) {
      showToast('Đã xóa ảnh tổng kết', 'success')
      await showCupDetail(cupId)
    }
  }

  // ── Public API ────────────────────────────────────────────────────────

  return {
    setupCupListeners,
    loadCups,
    renderCupList,
    showCupDetail,
    renderBracket,
    statusBadgeClass,
    _cupApiCall,
    _handleCupDetailClick,
    _handleCupDetailChange,
    showCreateCupModal,
    createCup,
    showAddParticipantsForCup,
    showAddParticipantsModal,
    confirmCupParticipants,
    backToCupsList,
    editCup,
    updateCup,
    shuffleCupSeeds,
    generateCupBracket,
    changeCupStatus,
    deleteCup,
    removeCupParticipant,
    saveCupFinalResults,
    deleteCupConclusionImage,
    uploadCupConclusionImage,
    scheduleMatchDate,
    updateMatchScore,
    setCupMatchWinner,
    advanceRound,
  }
}
