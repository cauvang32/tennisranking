import { useMemo, useState } from 'react'
import { api } from '../../api/client'
import { ConfirmButton, Empty, PageHeader, errorMessage, formatDate } from '../../components/common'
import { useApp } from '../../app/app-context'
import { Icon } from '../../components/icons'

export function PlayersFeature() {
  const app = useApp()
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const players = useMemo(() => app.players.filter(player => player.name.toLocaleLowerCase('vi').includes(query.toLocaleLowerCase('vi'))).sort((a, b) => a.name.localeCompare(b.name, 'vi')), [app.players, query])

  const create = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      await api.mutate('/players', 'POST', { name: name.trim() })
      setName('')
      await app.reload()
      app.notify('Đã thêm người chơi', 'success')
    } catch (error) { app.notify(errorMessage(error), 'error') } finally { setBusy(false) }
  }

  return <section className="tab-content active">
    <PageHeader icon="users" title="Quản lý người chơi" subtitle={`${app.players.length} người chơi`} />
    <div className="entity-toolbar">
      <label className="search-field"><span className="sr-only">Tìm người chơi</span><Icon name="search" /><input type="search" placeholder="Tìm người chơi…" value={query} onChange={e => setQuery(e.target.value)} /></label>
      {app.isAdmin && <form className="inline-form" onSubmit={e => { e.preventDefault(); void create() }}>
        <input required maxLength={100} placeholder="Tên người chơi mới" value={name} onChange={e => setName(e.target.value)} />
        <button className="btn btn-primary" disabled={busy}><Icon name="plus" /> Thêm</button>
      </form>}
    </div>
    {players.length === 0 ? <Empty>{query ? 'Không tìm thấy người chơi phù hợp' : 'Chưa có người chơi'}</Empty> : <div className="table-container responsive-table players-table"><table><thead><tr><th>Người chơi</th><th>ID</th><th>Ngày tạo</th>{app.isAdmin && <th className="col-actions">Thao tác</th>}</tr></thead><tbody>{players.map(player => <tr key={player.id}>
      <td data-label="Người chơi"><div className="player-cell"><span className="player-avatar">{player.name.slice(0, 1).toLocaleUpperCase('vi')}</span><strong>{player.name}</strong></div></td>
      <td data-label="ID"><span className="id-badge">#{player.id}</span></td><td data-label="Ngày tạo">{formatDate(player.created_at)}</td>
      {app.isAdmin && <td data-label="Thao tác"><ConfirmButton message={`Xóa ${player.name}? Các dữ liệu liên quan có thể bị ảnh hưởng.`} onConfirm={async () => {
        try { await api.mutate(`/players/${player.id}`, 'DELETE'); await app.reload(); app.notify('Đã xóa người chơi', 'success') } catch (error) { app.notify(errorMessage(error), 'error') }
      }}><Icon name="trash" size={14} /> Xóa</ConfirmButton></td>}
    </tr>)}</tbody></table></div>}
  </section>
}
