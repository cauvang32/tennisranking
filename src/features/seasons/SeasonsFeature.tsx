import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { Player, Season } from '../../../shared/domain'
import { api } from '../../api/client'
import { ConfirmButton, Empty, Modal, PageHeader, StatusBadge, errorMessage, formatDate, formatMoney } from '../../components/common'
import { useApp } from '../../app/app-context'
import { Icon } from '../../components/icons'

interface SeasonForm {
  name: string
  startDate: string
  endDate: string
  autoEnd: boolean
  description: string
  loseMoneyPerLoss: number
  playerIds: number[]
}

const blank = (): SeasonForm => ({ name: '', startDate: new Date().toISOString().slice(0, 10), endDate: '', autoEnd: false, description: '', loseMoneyPerLoss: 20000, playerIds: [] })

function toForm(season: Season): SeasonForm {
  return { name: season.name, startDate: season.start_date, endDate: season.end_date || '', autoEnd: season.auto_end, description: season.description || '', loseMoneyPerLoss: season.lose_money_per_loss, playerIds: [] }
}

export function SeasonsFeature() {
  const app = useApp()
  const notify = app.notify
  const [editing, setEditing] = useState<Season | null | 'new'>(null)
  const [form, setForm] = useState<SeasonForm>(blank)
  const [busy, setBusy] = useState(false)
  const [playersForSeason, setPlayersForSeason] = useState<{ season: Season; players: Player[] } | null>(null)
  const [resultsFor, setResultsFor] = useState<Season | null>(null)
  const [results, setResults] = useState('')
  const [filter, setFilter] = useState<'all' | 'active' | 'ended'>('all')
  const playersForSeasonId = playersForSeason?.season.id
  const visibleSeasons = useMemo(() => app.seasons.filter(season => filter === 'all' || (filter === 'active' ? season.is_active : !season.is_active)).sort((a, b) => Number(b.is_active) - Number(a.is_active) || b.start_date.localeCompare(a.start_date)), [app.seasons, filter])

  useEffect(() => {
    if (!playersForSeasonId) return
    api.seasonPlayers(playersForSeasonId).then(players => setPlayersForSeason(current => current ? { ...current, players } : null)).catch(error => notify(errorMessage(error), 'error'))
  }, [notify, playersForSeasonId])

  const open = async (season?: Season) => {
    setEditing(season || 'new')
    const next = season ? toForm(season) : blank()
    if (season) next.playerIds = (await api.seasonPlayers(season.id)).map(player => player.id)
    setForm(next)
  }

  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true)
    try {
      const body = { ...form, endDate: form.endDate || null }
      if (editing === 'new') await api.mutate('/seasons', 'POST', body)
      else if (editing) {
        await api.mutate(`/seasons/${editing.id}`, 'PUT', body)
        await api.mutate(`/seasons/${editing.id}/players`, 'POST', { playerIds: form.playerIds })
      }
      setEditing(null); await app.reload(); app.notify('Đã lưu mùa giải', 'success')
    } catch (error) { app.notify(errorMessage(error), 'error') } finally { setBusy(false) }
  }

  const savePlayers = async () => {
    if (!playersForSeason) return
    try {
      await api.mutate(`/seasons/${playersForSeason.season.id}/players`, 'POST', { playerIds: playersForSeason.players.map(player => player.id) })
      setPlayersForSeason(null); await app.reload(); app.notify('Đã cập nhật danh sách người chơi', 'success')
    } catch (error) { app.notify(errorMessage(error), 'error') }
  }

  return <section className="tab-content active">
    <PageHeader icon="calendar" title="Mùa giải" subtitle="Quản lý thời gian, thành viên và kết quả cuối mùa" actions={app.isAdmin && <button className="btn btn-primary" onClick={() => void open()}><Icon name="plus" /> Tạo mùa giải</button>} />
    <div className="filter-chips" aria-label="Lọc mùa giải">{([['all', 'Tất cả'], ['active', 'Đang hoạt động'], ['ended', 'Đã kết thúc']] as const).map(([value, label]) => <button type="button" key={value} className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>
    {app.seasons.length === 0 ? <Empty /> : visibleSeasons.length === 0 ? <Empty>Không có mùa giải trong bộ lọc này</Empty> : <div className="seasons-grid">{visibleSeasons.map(season => <article className={`season-card ${season.is_active ? 'active-season' : ''}`} key={season.id}>
      <div className="season-header"><h3>{season.name}</h3><StatusBadge tone={season.is_active ? 'success' : 'neutral'}>{season.is_active ? 'Đang hoạt động' : 'Đã kết thúc'}</StatusBadge></div>
      <p>{season.description || 'Không có mô tả'}</p><div className="season-meta"><span>📆 {formatDate(season.start_date)} – {formatDate(season.end_date)}</span><span>💸 Phạt: {formatMoney(season.lose_money_per_loss)}</span></div>
      {season.final_results && <div className="season-results-preview"><strong>Kết quả:</strong><p>{season.final_results}</p></div>}
      {app.canEdit && <div className="season-actions">
        <button className="btn btn-sm btn-secondary" onClick={() => setPlayersForSeason({ season, players: [] })}><Icon name="users" size={14} /> Người chơi</button>
        {season.is_active ? <ConfirmButton className="btn btn-sm btn-warning" message={`Kết thúc ${season.name}?`} onConfirm={async () => { try { await api.mutate(`/seasons/${season.id}/end`, 'POST', { endDate: new Date().toISOString().slice(0, 10) }); await app.reload(); app.notify('Đã kết thúc mùa giải', 'success') } catch (error) { app.notify(errorMessage(error), 'error') } }}>Kết thúc</ConfirmButton> : <button className="btn btn-sm btn-primary" onClick={async () => { try { await api.mutate(`/seasons/${season.id}/reactivate`, 'POST'); await app.reload(); app.notify('Đã kích hoạt lại', 'success') } catch (error) { app.notify(errorMessage(error), 'error') } }}>Kích hoạt</button>}
        {app.isAdmin && <details className="action-menu"><summary aria-label={`Thêm thao tác cho ${season.name}`}><Icon name="more" /></summary><div className="action-menu-popover"><button type="button" onClick={() => void open(season)}><Icon name="edit" size={14} /> Sửa</button><button type="button" onClick={() => { setResultsFor(season); setResults(season.final_results || '') }}><Icon name="trophy" size={14} /> Kết quả</button>{!season.is_active && <ConfirmButton className="action-danger" message={`Xóa vĩnh viễn ${season.name}?`} onConfirm={async () => { try { await api.mutate(`/seasons/${season.id}`, 'DELETE'); await app.reload(); app.notify('Đã xóa mùa giải', 'success') } catch (error) { app.notify(errorMessage(error), 'error') } }}><Icon name="trash" size={14} /> Xóa</ConfirmButton>}</div></details>}
      </div>}
    </article>)}</div>}

    {editing && <Modal title={editing === 'new' ? 'Tạo mùa giải' : 'Chỉnh sửa mùa giải'} onClose={() => setEditing(null)} wide>
      <form onSubmit={save}><div className="modal-body react-form-grid">
        <label className="form-group">Tên<input required maxLength={100} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
        <label className="form-group">Ngày bắt đầu<input required type="date" value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} /></label>
        <label className="form-group">Ngày kết thúc<input type="date" value={form.endDate} onChange={e => setForm({ ...form, endDate: e.target.value })} /></label>
        <label className="form-group">Tiền phạt mỗi trận thua<input type="number" min={0} value={form.loseMoneyPerLoss} onChange={e => setForm({ ...form, loseMoneyPerLoss: Number(e.target.value) })} /></label>
        <label className="form-group checkbox-label"><input type="checkbox" checked={form.autoEnd} onChange={e => setForm({ ...form, autoEnd: e.target.checked })} /> Tự kết thúc theo ngày</label>
        <label className="form-group full-width">Mô tả<textarea rows={3} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></label>
        <fieldset className="full-width player-checklist"><legend>Người chơi tham gia</legend>{app.players.map(player => <label key={player.id}><input type="checkbox" checked={form.playerIds.includes(player.id)} onChange={e => setForm({ ...form, playerIds: e.target.checked ? [...form.playerIds, player.id] : form.playerIds.filter(id => id !== player.id) })} /> {player.name}</label>)}</fieldset>
      </div><div className="modal-footer"><button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>Hủy</button><button className="btn btn-primary" disabled={busy}>Lưu</button></div></form>
    </Modal>}

    {playersForSeason && <Modal title={`Người chơi · ${playersForSeason.season.name}`} onClose={() => setPlayersForSeason(null)}>
      <div className="modal-body player-checklist">{app.players.map(player => <label key={player.id}><input type="checkbox" checked={playersForSeason.players.some(item => item.id === player.id)} onChange={e => setPlayersForSeason(current => current ? { ...current, players: e.target.checked ? [...current.players, player] : current.players.filter(item => item.id !== player.id) } : null)} /> {player.name}</label>)}</div>
      <div className="modal-footer"><button className="btn btn-secondary" onClick={() => setPlayersForSeason(null)}>Hủy</button><button className="btn btn-primary" onClick={() => void savePlayers()}>Lưu danh sách</button></div>
    </Modal>}

    {resultsFor && <Modal title={`Kết quả · ${resultsFor.name}`} onClose={() => setResultsFor(null)}>
      <div className="modal-body"><label className="form-group">Kết quả cuối mùa<textarea rows={8} maxLength={10000} value={results} onChange={e => setResults(e.target.value)} /></label><label className="form-group">Ảnh tổng kết{resultsFor.conclusion_image_path ? <img src={`${import.meta.env.BASE_URL ?? '/tennis/'}api/images/season/${resultsFor.id}/conclusion/file`} alt="Ảnh tổng kết" style={{ maxWidth: '100%', maxHeight: 150, borderRadius: 8, margin: '8px 0' }} /> : null}<input type="file" accept="image/*" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; try { await api.upload(`/images/season/${resultsFor.id}/conclusion`, file, { seasonId: String(resultsFor.id) }); await app.reload(); app.notify('Đã tải ảnh tổng kết', 'success') } catch (error) { app.notify(errorMessage(error), 'error') } }} /></label></div>
      <div className="modal-footer"><button className="btn btn-secondary" onClick={() => setResultsFor(null)}>Hủy</button>{resultsFor.conclusion_image_path && <ConfirmButton message="Xóa ảnh tổng kết?" onConfirm={async () => { try { await api.mutate(`/images/season/${resultsFor.id}/conclusion`, 'DELETE'); await app.reload(); app.notify('Đã xóa ảnh tổng kết', 'success') } catch (error) { app.notify(errorMessage(error), 'error') } }}><Icon name="trash" size={14} /> Xóa ảnh</ConfirmButton>}<button className="btn btn-primary" onClick={async () => { try { await api.mutate(`/seasons/${resultsFor.id}/results`, 'PUT', { finalResults: results }); setResultsFor(null); await app.reload(); app.notify('Đã lưu kết quả', 'success') } catch (error) { app.notify(errorMessage(error), 'error') } }}>Lưu</button></div>
    </Modal>}
  </section>
}
