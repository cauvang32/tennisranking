import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { ManagedUser, UserRole } from '../../../shared/domain'
import { api } from '../../api/client'
import { ConfirmButton, Empty, Loading, Modal, PageHeader, Panel, StatusBadge, errorMessage, formatDate } from '../../components/common'
import { useApp } from '../../app/app-context'
import { Icon } from '../../components/icons'

interface UserForm { username: string; password: string; email: string; role: UserRole; displayName: string; isActive: boolean; notes: string }
interface CacheResponse { cacheStats?: { hits?: number; misses?: number; keyCount?: number; hitRate?: string; isConnected?: boolean; memoryUsage?: string; errors?: number }; recommendations?: { performance?: string; memory?: string; info?: string }; serverInfo?: { uptime?: number; redisConnected?: boolean }; [key: string]: unknown }
interface QueueMetrics { wait?: number; active?: number; completed?: number; failed?: number; paused?: number }
interface FcmResponse { status?: { isPaused?: boolean; dispatcher?: QueueMetrics; sender?: QueueMetrics }; deviceCount?: number; timestamp?: string; [key: string]: unknown }
const blank = (): UserForm => ({ username: '', password: '', email: '', role: 'viewer', displayName: '', isActive: true, notes: '' })

export function AccountsFeature() {
  const app = useApp()
  const notify = app.notify
  const [users, setUsers] = useState<ManagedUser[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<ManagedUser | 'new' | null>(null)
  const [form, setForm] = useState<UserForm>(blank)
  const [cacheStats, setCacheStats] = useState<CacheResponse | null>(null)
  const [fcm, setFcm] = useState<FcmResponse | null>(null)
  const [broadcast, setBroadcast] = useState({ title: '', body: '' })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [nextUsers, cache, status] = await Promise.all([api.users(), api.request<CacheResponse>('/cache-stats'), api.request<FcmResponse>('/admin/fcm/status')])
      setUsers(nextUsers); setCacheStats(cache); setFcm(status)
    } catch (error) { notify(errorMessage(error), 'error') } finally { setLoading(false) }
  }, [notify])
  useEffect(() => { void load() }, [app.revision, load])

  const open = (user?: ManagedUser) => {
    setEditing(user || 'new')
    setForm(user ? { username: user.username, password: '', email: user.email || '', role: user.role, displayName: user.displayName || user.display_name || '', isActive: user.is_active, notes: user.notes || '' } : blank())
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    try {
      if (editing === 'new') await api.mutate('/auth/users', 'POST', { ...form, email: form.email || null })
      else if (editing) {
        await api.mutate(`/auth/users/${editing.id}`, 'PUT', { email: form.email || null, role: form.role, displayName: form.displayName, isActive: form.isActive, notes: form.notes })
        if (form.password) await api.mutate(`/auth/users/${editing.id}/password`, 'PUT', { password: form.password })
      }
      setEditing(null); await load(); app.notify('Đã lưu tài khoản', 'success')
    } catch (error) { app.notify(errorMessage(error), 'error') }
  }

  const cache = cacheStats?.cacheStats
  const worker = fcm?.status
  const dispatcher = worker?.dispatcher || {}
  const sender = worker?.sender || {}

  return <section className="tab-content active"><PageHeader icon="lock" title="Tài khoản & hệ thống" subtitle="Phân quyền, cache và thông báo đẩy" actions={<button className="btn btn-primary" onClick={() => open()}><Icon name="plus" /> Tạo tài khoản</button>} />
    {loading ? <Loading /> : users.length === 0 ? <Empty /> : <div className="table-container responsive-table accounts-table"><table><thead><tr><th>Tài khoản</th><th>Vai trò</th><th>Trạng thái</th><th>Lần cuối</th><th>Thao tác</th></tr></thead><tbody>{users.map(user => <tr key={user.id}><td data-label="Tài khoản"><strong>{user.displayName || user.display_name || user.username}</strong><br /><small>{user.username} · {user.email || '—'}</small></td><td data-label="Vai trò"><StatusBadge tone={user.role === 'admin' ? 'info' : 'neutral'}>{user.role}</StatusBadge></td><td data-label="Trạng thái"><StatusBadge tone={user.is_active ? 'success' : 'danger'}>{user.is_active ? 'Hoạt động' : 'Đã khóa'}</StatusBadge></td><td data-label="Lần cuối">{formatDate(user.last_login)}</td><td data-label="Thao tác"><div className="card-actions"><button className="btn btn-sm btn-secondary" onClick={() => open(user)}><Icon name="edit" size={14} /> Sửa</button>{user.id !== app.user?.id && <ConfirmButton message={`Xóa tài khoản ${user.username}?`} onConfirm={async () => { try { await api.mutate(`/auth/users/${user.id}`, 'DELETE'); await load(); app.notify('Đã xóa tài khoản', 'success') } catch (error) { app.notify(errorMessage(error), 'error') } }}><Icon name="trash" size={14} /> Xóa</ConfirmButton>}</div></td></tr>)}</tbody></table></div>}

    <div className="admin-grid"><Panel title={<span className="panel-title-with-icon"><Icon name="server" /> Redis cache</span>} actions={<button className="btn btn-sm btn-secondary" onClick={() => void load()}><Icon name="refresh" size={14} /> Làm mới</button>}>
      <div className="health-summary"><div><span>Kết nối</span><StatusBadge tone={cache?.isConnected ? 'success' : 'danger'}>{cache?.isConnected ? 'Ổn định' : 'Mất kết nối'}</StatusBadge></div><div><span>Tỷ lệ hit</span><strong>{cache?.hitRate || '—'}</strong></div><div><span>Hit / Miss</span><strong>{cache?.hits ?? 0} / {cache?.misses ?? 0}</strong></div><div><span>Số khóa</span><strong>{cache?.keyCount ?? 0}</strong></div><div><span>Bộ nhớ</span><strong>{cache?.memoryUsage || '—'}</strong></div><div><span>Lỗi</span><strong>{cache?.errors ?? 0}</strong></div></div>
      {cacheStats?.recommendations?.performance && <p className="recommendation">{cacheStats.recommendations.performance}</p>}
      <details className="technical-details"><summary>Chi tiết kỹ thuật</summary><pre className="json-summary">{JSON.stringify(cacheStats, null, 2)}</pre></details>
    </Panel>
      <Panel title={<span className="panel-title-with-icon"><Icon name="bell" /> FCM Worker</span>} actions={<>{worker?.isPaused ? <button className="btn btn-sm btn-primary" onClick={async () => { try { await api.mutate('/admin/fcm/resume', 'POST'); await load() } catch (error) { app.notify(errorMessage(error), 'error') } }}>Tiếp tục</button> : <button className="btn btn-sm btn-warning" onClick={async () => { try { await api.mutate('/admin/fcm/pause', 'POST'); await load() } catch (error) { app.notify(errorMessage(error), 'error') } }}>Tạm dừng</button>}</>}>
        <div className="health-summary"><div><span>Trạng thái</span><StatusBadge tone={worker?.isPaused ? 'warning' : 'success'}>{worker?.isPaused ? 'Tạm dừng' : 'Đang chạy'}</StatusBadge></div><div><span>Thiết bị</span><strong>{fcm?.deviceCount ?? 0}</strong></div><div><span>Đang chờ</span><strong>{(dispatcher.wait || 0) + (sender.wait || 0)}</strong></div><div><span>Đang xử lý</span><strong>{(dispatcher.active || 0) + (sender.active || 0)}</strong></div><div><span>Hoàn thành</span><strong>{(dispatcher.completed || 0) + (sender.completed || 0)}</strong></div><div><span>Thất bại</span><strong>{(dispatcher.failed || 0) + (sender.failed || 0)}</strong></div></div>
        <form className="broadcast-form" onSubmit={async e => { e.preventDefault(); try { await api.mutate('/admin/fcm/send', 'POST', broadcast); setBroadcast({ title: '', body: '' }); app.notify('Đã gửi thông báo', 'success') } catch (error) { app.notify(errorMessage(error), 'error') } }}><label className="form-group">Tiêu đề<input required value={broadcast.title} onChange={e => setBroadcast({ ...broadcast, title: e.target.value })} /></label><label className="form-group">Nội dung<textarea required rows={3} value={broadcast.body} onChange={e => setBroadcast({ ...broadcast, body: e.target.value })} /></label><button className="btn btn-primary"><Icon name="bell" /> Gửi thông báo</button></form>
        <details className="technical-details"><summary>Chi tiết kỹ thuật</summary><pre className="json-summary">{JSON.stringify(fcm, null, 2)}</pre></details>
      </Panel>
    </div>

    {editing && <Modal title={editing === 'new' ? 'Tạo tài khoản' : `Sửa ${editing.username}`} onClose={() => setEditing(null)}><form onSubmit={save}><div className="modal-body">
      <label className="form-group">Tên đăng nhập<input required={editing === 'new'} disabled={editing !== 'new'} minLength={3} maxLength={50} value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} /></label><label className="form-group">{editing === 'new' ? 'Mật khẩu' : 'Mật khẩu mới (để trống nếu không đổi)'}<input required={editing === 'new'} type="password" minLength={12} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></label><label className="form-group">Email<input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></label><label className="form-group">Tên hiển thị<input maxLength={100} value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} /></label><label className="form-group">Vai trò<select value={form.role} onChange={e => setForm({ ...form, role: e.target.value as UserRole })}><option value="admin">Admin</option><option value="editor">Editor</option><option value="viewer">Viewer</option></select></label>{editing !== 'new' && <label className="checkbox-label"><input type="checkbox" checked={form.isActive} onChange={e => setForm({ ...form, isActive: e.target.checked })} /> Hoạt động</label>}<label className="form-group">Ghi chú<textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></label>
    </div><div className="modal-footer"><button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>Hủy</button><button className="btn btn-primary">Lưu</button></div></form></Modal>}
  </section>
}
