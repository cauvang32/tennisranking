/**
 * Site Image Editor feature — manage site images (hero banner, etc.)
 * via upload, delete, alt-text metadata, and hero banner migration.
 */

export function createImagesModule(ctx) {

  async function loadHeroBanner() {
    if (!ctx.serverMode) return
    try {
      const response = await ctx.makeAuthenticatedRequest('/images/hero_banner/file')
      if (response.ok) {
        const dynamicBanner = document.getElementById('dynamicHeroBanner')
        const staticBanner = document.querySelector('.hero-banner-image:not(#dynamicHeroBanner)')
        if (dynamicBanner) {
          dynamicBanner.style.display = 'block'
          dynamicBanner.src = `${ctx.apiBase}/images/hero_banner/file?t=${Date.now()}`
          if (staticBanner) staticBanner.style.display = 'none'
        }
      }
    } catch { /* fallback to static /image.png */ }
  }

  function setupImageEditorListeners() {
    document.querySelectorAll('.image-upload-input').forEach(input => {
      input.addEventListener('change', (e) => handleImageUpload(e))
    })
    document.querySelectorAll('.image-delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const key = e.currentTarget.dataset.key
        if (key) deleteSiteImage(key)
      })
    })
    document.querySelectorAll('.image-alt-input').forEach(input => {
      let debounceTimer
      input.addEventListener('input', (e) => {
        clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          const key = e.currentTarget.dataset.key
          if (key) updateImageMeta(key, { altText: e.currentTarget.value })
        }, 800)
      })
    })
    const refreshBtn = document.getElementById('refreshImagesBtn')
    if (refreshBtn) refreshBtn.addEventListener('click', () => loadSiteImages())
    const migrateBtn = document.getElementById('migrateHeroBtn')
    if (migrateBtn) migrateBtn.addEventListener('click', () => migrateHeroBanner())
  }

  async function loadSiteImages() {
    if (!ctx.serverMode) return
    try {
      const response = await ctx.makeAuthenticatedRequest('/images')
      const data = await response.json()
      if (!data || !Array.isArray(data)) return
      for (const img of data) {
        renderImageEditor(img)
      }
    } catch (error) {
      console.error('Failed to load site images:', error)
    }
  }

  function renderImageEditor(img) {
    const { key, file_size, uploaded_at, alt_text, is_active } = img
    const previewEl = document.getElementById(`${key}-preview`)
    if (previewEl) {
      if (is_active && img.storage_path) {
        previewEl.innerHTML = `<img src="${ctx.apiBase}/images/${key}/file" alt="${ctx.escapeHtml(alt_text || '')}" style="max-width:100%;max-height:200px;object-fit:contain;border-radius:8px;">`
      } else {
        previewEl.innerHTML = '<div class="image-preview-placeholder">Chưa có hình ảnh</div>'
      }
    }
    const statusEl = document.getElementById(`${key}-status`)
    if (statusEl) {
      statusEl.textContent = is_active ? '✅ Đang hoạt động' : '⏸️ Đã tắt'
      statusEl.className = `image-status-badge ${is_active ? 'active' : 'inactive'}`
    }
    const infoEl = document.getElementById(`${key}-info`)
    if (infoEl) {
      const sizeStr = file_size ? `${(file_size / 1024).toFixed(1)} KB` : ''
      const dateStr = uploaded_at ? new Date(uploaded_at).toLocaleDateString('vi-VN') : ''
      infoEl.textContent = [sizeStr, dateStr].filter(Boolean).join(' • ')
    }
    const altInput = document.querySelector(`.image-alt-input[data-key="${key}"]`)
    if (altInput) altInput.value = alt_text || ''
  }

  async function handleImageUpload(e) {
    const input = e.target
    const key = input.dataset.key
    if (!input.files || !input.files[0]) return
    const file = input.files[0]
    if (file.size > 10 * 1024 * 1024) {
      ctx.showToast('File quá lớn (tối đa 10MB)', 'error')
      input.value = ''
      return
    }
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    if (!allowed.includes(file.type)) {
      ctx.showToast('Định dạng không hợp lệ', 'error')
      input.value = ''
      return
    }
    try {
      const formData = new FormData()
      formData.append('image', file)
      const altInput = document.querySelector(`.image-alt-input[data-key="${key}"]`)
      if (altInput) formData.append('altText', altInput.value)
      const res = await ctx.makeAuthenticatedRequest(`/images/${key}`, {
        method: 'POST',
        body: formData
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        ctx.showToast(data.error || 'Lỗi khi tải lên hình ảnh', 'error')
        input.value = ''
        return
      }
      const data = await res.json()
      if (data.success) {
        ctx.showToast(`Hình ảnh "${key}" đã được cập nhật`, 'success')
        if (key === 'hero_banner') loadHeroBanner()
        loadSiteImages()
      }
    } catch (error) {
      ctx.showToast('Lỗi khi tải lên hình ảnh', 'error')
    }
    input.value = ''
  }

  async function deleteSiteImage(key) {
    if (!confirm(`Bạn có chắc muốn xóa hình ảnh "${key}"?`)) return
    try {
      const res = await ctx.makeAuthenticatedRequest(`/images/${key}`, {
        method: 'DELETE'
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        ctx.showToast(data.error || 'Lỗi khi xóa hình ảnh', 'error')
        return
      }
      const data = await res.json()
      if (data.success) {
        ctx.showToast(`Đã xóa hình ảnh "${key}"`, 'success')
        if (key === 'hero_banner') loadHeroBanner()
        loadSiteImages()
      }
    } catch (error) {
      ctx.showToast('Lỗi khi xóa hình ảnh', 'error')
    }
  }

  async function updateImageMeta(key, meta) {
    try {
      const res = await ctx.makeAuthenticatedRequest(`/images/${key}/meta`, {
        method: 'PUT',
        body: JSON.stringify(meta)
      })
      const data = await res.json()
      if (!data.success) ctx.showToast(data.error || 'Lỗi khi cập nhật', 'error')
    } catch (error) {
      console.error('updateImageMeta error:', error)
    }
  }

  async function migrateHeroBanner() {
    if (!confirm('Dời banner từ file public/image.png vào hệ thống quản lý?')) return
    try {
      const res = await ctx.makeAuthenticatedRequest(`/images/migrate-hero`, {
        method: 'POST'
      })
      const data = await res.json()
      if (data.success) {
        ctx.showToast('Đã dời banner thành công!', 'success')
        loadSiteImages()
        loadHeroBanner()
      } else {
        ctx.showToast(data.error || 'Lỗi khi dời banner', 'error')
      }
    } catch (error) {
      ctx.showToast(error.message, 'error')
    }
  }

  return {
    loadHeroBanner,
    setupImageEditorListeners,
    loadSiteImages,
    renderImageEditor,
    handleImageUpload,
    deleteSiteImage,
    updateImageMeta,
    migrateHeroBanner
  }
}
