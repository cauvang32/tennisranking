import { useState, type ChangeEvent } from 'react'
import { api, getApiBase } from '../../api/client'
import { ConfirmButton, Modal, PageHeader, errorMessage } from '../../components/common'
import { useApp } from '../../app/app-context'
import { Icon } from '../../components/icons'

export function DataFeature() {
  const app = useApp()
  const [busy, setBusy] = useState(false)
  const [pendingRestore, setPendingRestore] = useState<File | null>(null)
  const downloadJson = async (path: string, filename: string) => {
    setBusy(true)
    try {
      const data = await api.request<unknown>(path)
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url)
    } catch (error) { app.notify(errorMessage(error), 'error') } finally { setBusy(false) }
  }
  const restore = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return
    setPendingRestore(file)
    event.target.value = ''
  }
  const downloadDump = async () => {
    setBusy(true)
    try {
      const response = await fetch(`${getApiBase()}/backup-file`, { method: 'GET', credentials: 'include' })
      if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error((err as { error?: string }).error || 'Failed to download backup') }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); const disposition = response.headers.get('Content-Disposition') || ''; const match = /filename="?([^";]+)"?/.exec(disposition); anchor.download = match?.[1] || `tennis-backup-${Date.now()}.dump`; anchor.href = url; anchor.click(); URL.revokeObjectURL(url)
    } catch (error) { app.notify(errorMessage(error), 'error') } finally { setBusy(false) }
  }
  const executeRestore = async () => {
    if (!pendingRestore) return
    setBusy(true)
    try {
      // Route through the shared client so the X-CSRF-Token header is attached
      // (a raw fetch here bypassed the CSRF middleware → 403 on every restore).
      const form = new FormData()
      form.append('file', pendingRestore)
      form.append('confirmRestore', 'true')
      const data = await api.request<{ success?: boolean; error?: string; warnings?: string }>('/restore-file', { method: 'POST', body: form })
      if (!data.success) { throw new Error(data.error || 'Restore failed') }
      await app.reload()
      setPendingRestore(null)
      app.notify(data.warnings ? `Đã khôi phục (có cảnh báo: ${data.warnings.slice(0, 120)})` : 'Khôi phục dữ liệu thành công', 'success')
    } catch (error) { app.notify(errorMessage(error), 'error') } finally { setBusy(false) }
  }
  return <section className="tab-content active"><PageHeader icon="database" title="Xuất, sao lưu & khôi phục" subtitle="Các thao tác khôi phục và xóa chỉ dành cho quản trị viên" /><div className="data-actions-grid">
    <article className="card react-card"><h3><Icon name="download" /> Xuất Excel</h3><p>Tải bảng xếp hạng hiện tại.</p><div className="card-actions"><button className="btn btn-primary" disabled={busy} onClick={() => void api.download('/export-excel/lifetime', 'tennis-lifetime.xlsx').catch(error => app.notify(errorMessage(error), 'error'))}>Toàn thời gian</button>{app.data?.defaultDate && <button className="btn btn-secondary" onClick={() => void api.download(`/export-excel/date/${app.data?.defaultDate}`, `tennis-${app.data?.defaultDate}.xlsx`)}>Ngày gần nhất</button>}</div></article>
    {app.isAdmin && <article className="card react-card"><h3><Icon name="database" /> Sao lưu cơ sở dữ liệu</h3><p>Tải tệp <code>.dump</code> toàn bộ CSDL (cấu trúc + dữ liệu). Đây là cách khôi phục an toàn nhất, kể cả lên một máy chủ mới có CSDL trống.</p><div className="card-actions"><button className="btn btn-primary" disabled={busy} onClick={() => void downloadDump()}>{busy ? 'Đang tạo…' : 'Tải .dump'}</button></div></article>}
    {app.isAdmin && <article className="card react-card"><h3>Khôi phục cơ sở dữ liệu</h3><p>Chọn tệp <code>.dump</code> (khuyến nghị) hoặc <code>.json</code> (legacy) đã tải về. Dữ liệu hiện tại sẽ được thay thế hoàn toàn; nếu khôi phục thất bại, dữ liệu cũ được giữ nguyên.</p><div className="card-actions"><label className="btn btn-secondary file-button">Chọn tệp .dump / .json<input hidden type="file" accept=".dump,.sql,.json,application/octet-stream" onChange={restore} /></label></div></article>}
    {app.isAdmin && <article className="card react-card"><h3>Sao lưu JSON (legacy)</h3><p>Bản sao JSON để xem chi tiết từng bản ghi. Có thể dùng để khôi phục tại mục «Khôi phục cơ sở dữ liệu» (khuyến nghị dùng <code>.dump</code>).</p><div className="card-actions"><button className="btn btn-secondary" disabled={busy} onClick={() => void downloadJson('/backup', `tennis-backup-${Date.now()}.json`)}>Tải JSON</button></div></article>}
    {app.isAdmin && <article className="card react-card danger-zone"><h3>Vùng nguy hiểm</h3><p>Xóa toàn bộ dữ liệu nghiệp vụ. Tài khoản hiện tại được giữ lại theo quy tắc của máy chủ.</p><ConfirmButton disabled={busy} message="XÓA TOÀN BỘ DỮ LIỆU? Hành động này không thể hoàn tác nếu không có bản sao lưu." onConfirm={async () => { setBusy(true); try { await api.mutate('/clear-all-data', 'DELETE', { confirmClear: true }); await app.reload(); app.notify('Đã xóa dữ liệu', 'success') } catch (error) { app.notify(errorMessage(error), 'error') } finally { setBusy(false) } }}>Xóa toàn bộ</ConfirmButton></article>}
  </div>{pendingRestore && <Modal title="Xác nhận khôi phục" onClose={() => { if (!busy) setPendingRestore(null) }}><div className="modal-body"><p>Khôi phục sẽ thay thế dữ liệu hiện tại bằng nội dung của bản sao lưu. Nếu khôi phục thất bại, dữ liệu cũ sẽ được giữ nguyên. Hãy đảm bảo bạn đã chọn đúng tệp.</p></div><div className="modal-footer"><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setPendingRestore(null)}>Hủy</button><button type="button" className="btn btn-danger" disabled={busy} onClick={() => void executeRestore()}>{busy ? 'Đang khôi phục…' : 'Khôi phục'}</button></div></Modal>}</section>
}
