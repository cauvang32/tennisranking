/**
 * Season Results feature — modal for viewing/editing season final results
 * and managing the conclusion image (upload/delete).
 */

export function createSeasonResultsModule(ctx) {

  function setupSeasonResultsListeners() {
    const saveBtn = document.getElementById('saveSeasonResultsBtn')
    if (saveBtn) saveBtn.addEventListener('click', () => saveSeasonResults())

    const imageInput = document.getElementById('seasonConclusionImageInput')
    if (imageInput) imageInput.addEventListener('change', (e) => uploadConclusionImage(e))

    const deleteImgBtn = document.getElementById('deleteConclusionImageBtn')
    if (deleteImgBtn) deleteImgBtn.addEventListener('click', () => deleteConclusionImage())
  }

  function showSeasonResultsModal(seasonId) {
    const season = ctx.seasons.find(s => s.id === seasonId)
    if (!season) return

    document.getElementById('seasonResultsSeasonId').value = seasonId
    document.getElementById('seasonResultsModalTitle').textContent = `Kết quả: ${season.name}`
    document.getElementById('seasonResultsText').value = season.final_results || ''

    const previewEl = document.getElementById('seasonConclusionImagePreview')
    const deleteBtn = document.getElementById('deleteConclusionImageBtn')

    if (season.conclusion_image_path) {
      previewEl.innerHTML = `<img src="${ctx.apiBase}/images/season/${seasonId}/conclusion/file" style="max-width:100%;max-height:150px;object-fit:contain;border-radius:8px;">`
      deleteBtn.style.display = 'inline-block'
    } else {
      previewEl.innerHTML = ''
      deleteBtn.style.display = 'none'
    }

    ctx.showModal('seasonResultsModal')
  }

  async function saveSeasonResults() {
    const seasonId = parseInt(document.getElementById('seasonResultsSeasonId').value)
    const text = document.getElementById('seasonResultsText').value.trim()

    if (!text) {
      ctx.showToast('Vui lòng nhập kết quả giải đấu', 'error')
      return
    }

    try {
      const res = await ctx.makeAuthenticatedRequest(`/seasons/${seasonId}/results`, {
        method: 'PUT',
        body: JSON.stringify({ finalResults: text })
      })
      const data = await res.json()
      if (data.success) {
        ctx.showToast('Đã lưu kết quả giải đấu', 'success')
        await ctx.loadSeasons()
        ctx.renderSeasons()
        ctx.hideModal('seasonResultsModal')
      } else {
        ctx.showToast(data.error || 'Lỗi khi lưu', 'error')
      }
    } catch (error) {
      ctx.showToast(error.message, 'error')
    }
  }

  async function uploadConclusionImage(e) {
    const input = e.target
    const seasonId = parseInt(document.getElementById('seasonResultsSeasonId').value)

    if (!input.files || !input.files[0]) return
    const file = input.files[0]

    if (file.size > 10 * 1024 * 1024) {
      ctx.showToast('File quá lớn (tối đa 10MB)', 'error')
      input.value = ''
      return
    }

    try {
      const formData = new FormData()
      formData.append('image', file)
      formData.append('seasonId', seasonId)

      const res = await ctx.makeAuthenticatedRequest(`/images/season/${seasonId}/conclusion`, {
        method: 'POST',
        body: formData
      })
      const data = await res.json()
      if (data.success) {
        ctx.showToast('Đã tải lên ảnh tổng kết', 'success')
        document.getElementById('seasonConclusionImagePreview').innerHTML =
          `<img src="${ctx.apiBase}/images/season/${seasonId}/conclusion/file" style="max-width:100%;max-height:150px;object-fit:contain;border-radius:8px;">`
        document.getElementById('deleteConclusionImageBtn').style.display = 'inline-block'
      } else {
        ctx.showToast(data.error || 'Lỗi khi tải lên', 'error')
      }
    } catch (error) {
      ctx.showToast(error.message, 'error')
    }

    input.value = ''
  }

  async function deleteConclusionImage() {
    const seasonId = parseInt(document.getElementById('seasonResultsSeasonId').value)

    if (!confirm('Bạn có chắc muốn xóa ảnh tổng kết?')) return

    try {
      const res = await ctx.makeAuthenticatedRequest(`/images/season/${seasonId}/conclusion`, {
        method: 'DELETE'
      })
      const data = await res.json()
      if (data.success) {
        ctx.showToast('Đã xóa ảnh tổng kết', 'success')
        document.getElementById('seasonConclusionImagePreview').innerHTML = ''
        document.getElementById('deleteConclusionImageBtn').style.display = 'none'
      } else {
        ctx.showToast(data.error || 'Lỗi khi xóa', 'error')
      }
    } catch (error) {
      ctx.showToast('Lỗi kết nối: ' + error.message, 'error')
    }
  }

  return {
    setupSeasonResultsListeners,
    showSeasonResultsModal,
    saveSeasonResults,
    uploadConclusionImage,
    deleteConclusionImage
  }
}
