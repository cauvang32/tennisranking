import { useState, type ChangeEvent } from 'react'
import { api } from '../../api/client'
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
  const executeRestore = async () => {
    if (!pendingRestore) return
    setBusy(true)
    try {
      const payload = JSON.parse(await pendingRestore.text()) as Record<string, unknown>
      await api.mutate('/restore', 'POST', { ...payload, confirmRestore: true })
      await app.reload()
      setPendingRestore(null)
      app.notify('Khôi phục dữ liệu thành công', 'success')
    } catch (error) { app.notify(errorMessage(error), 'error') } finally { setBusy(false) }
  }
  return <section className="tab-content active"><PageHeader icon="database" title="Xuất, sao lưu & khôi phục" subtitle="Các thao tác khôi phục và xóa chỉ dành cho quản trị viên" /><div className="data-actions-grid">
    <article className="card react-card"><h3><Icon name="download" /> Xuất Excel</h3><p>Tải bảng xếp hạng hiện tại.</p><div className="card-actions"><button className="btn btn-primary" disabled={busy} onClick={() => void api.download('/export-excel/lifetime', 'tennis-lifetime.xlsx').catch(error => app.notify(errorMessage(error), 'error'))}>Toàn thời gian</button>{app.data?.defaultDate && <button className="btn btn-secondary" onClick={() => void api.download(`/export-excel/date/${app.data?.defaultDate}`, `tennis-${app.data?.defaultDate}.xlsx`)}>Ngày gần nhất</button>}</div></article>
    {app.isAdmin && <article className="card react-card"><h3>Sao lưu JSON</h3><p>Tạo một bản sao đầy đủ để lưu trữ hoặc khôi phục sau này.</p><div className="card-actions"><button className="btn btn-primary" disabled={busy} onClick={() => void downloadJson('/backup', `tennis-backup-${Date.now()}.json`)}>Tải bản sao lưu</button></div></article>}
    {app.isAdmin && <article className="card react-card"><h3>Khôi phục JSON</h3><p>Chọn tệp được tạo từ “Tải bản sao lưu”. Dữ liệu hiện tại sẽ được thay thế.</p><div className="card-actions"><label className="btn btn-secondary file-button">Chọn tệp khôi phục<input hidden type="file" accept="application/json" onChange={restore} /></label></div></article>}
    {app.isAdmin && <article className="card react-card danger-zone"><h3>Vùng nguy hiểm</h3><p>Xóa toàn bộ dữ liệu nghiệp vụ. Tài khoản hiện tại được giữ lại theo quy tắc của máy chủ.</p><ConfirmButton disabled={busy} message="XÓA TOÀN BỘ DỮ LIỆU? Hành động này không thể hoàn tác nếu không có bản sao lưu." onConfirm={async () => { setBusy(true); try { await api.mutate('/clear-all-data', 'DELETE', { confirmClear: true }); await app.reload(); app.notify('Đã xóa dữ liệu', 'success') } catch (error) { app.notify(errorMessage(error), 'error') } finally { setBusy(false) } }}>Xóa toàn bộ</ConfirmButton></article>}
  </div>{pendingRestore && <Modal title="Xác nhận khôi phục" onClose={() => { if (!busy) setPendingRestore(null) }}><div className="modal-body"><p>Khôi phục sẽ thay thế dữ liệu hiện tại bằng nội dung của bản sao lưu. Hãy đảm bảo bạn đã chọn đúng tệp.</p></div><div className="modal-footer"><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setPendingRestore(null)}>Hủy</button><button type="button" className="btn btn-danger" disabled={busy} onClick={() => void executeRestore()}>{busy ? 'Đang khôi phục…' : 'Khôi phục'}</button></div></Modal>}</section>
}
