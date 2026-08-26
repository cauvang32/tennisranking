import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import type { Cup, CupFormat, CupMatch, CupParticipant, CupStatus } from '../../../shared/domain'
import { api } from '../../api/client'
import { ConfirmButton, Empty, Loading, Modal, PageHeader, StatusBadge, errorMessage, formatDate, type StatusTone } from '../../components/common'
import { useApp } from '../../app/app-context'
import { Icon } from '../../components/icons'

interface CupForm { name: string; seasonId: number | null; format: CupFormat; numTeams: number; regulationText: string; startDate: string; endDate: string; finalResults: string }
const blank = (): CupForm => ({ name: '', seasonId: null, format: 'single_elimination', numTeams: 8, regulationText: '', startDate: '', endDate: '', finalResults: '' })
const statuses: Record<CupStatus, string> = { draft: 'Bản nháp', scheduled: 'Đã lên lịch', in_progress: 'Đang diễn ra', completed: 'Hoàn thành', cancelled: 'Đã hủy' }
const transitions: Record<CupStatus, CupStatus[]> = { draft: ['scheduled', 'cancelled'], scheduled: ['in_progress', 'cancelled'], in_progress: ['completed', 'cancelled'], completed: [], cancelled: ['draft'] }
const statusTone = (status: CupStatus): StatusTone => status === 'completed' ? 'success' : status === 'in_progress' ? 'warning' : status === 'cancelled' ? 'danger' : status === 'scheduled' ? 'info' : 'neutral'

function teamName(match: CupMatch, side: 1 | 2) {
  const custom = side === 1 ? match.t1_team_name || match.team1_name : match.t2_team_name || match.team2_name
  if (custom) return custom
  const names = side === 1 ? [match.t1_p1_name, match.t1_p2_name] : [match.t2_p1_name, match.t2_p2_name]
  return names.filter(Boolean).join(' + ') || 'Chờ xác định'
}

export function CupsFeature() {
  const app = useApp()
  const notify = app.notify
  const [cups, setCups] = useState<Cup[]>([])
  const [selected, setSelected] = useState<Cup | null>(null)
  const [participants, setParticipants] = useState<CupParticipant[]>([])
  const [bracket, setBracket] = useState<CupMatch[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Cup | 'new' | null>(null)
  const [form, setForm] = useState<CupForm>(blank)
  const [participantForm, setParticipantForm] = useState({ player1Id: 0, player2Id: 0, teamName: '' })
  const [score, setScore] = useState<Record<number, { team1Score: number; team2Score: number; playDate: string }>>({})
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | CupStatus>('all')

  const loadList = useCallback(async () => {
    setLoading(true)
    try { setCups(await api.cups()) } catch (error) { notify(errorMessage(error), 'error') } finally { setLoading(false) }
  }, [notify])
  const loadDetail = async (id: number) => {
    setLoading(true)
    try {
      const [cup, nextParticipants, nextBracket] = await Promise.all([api.cup(id), api.cupParticipants(id), api.cupBracket(id)])
      setSelected(cup); setParticipants(nextParticipants); setBracket(nextBracket)
      setScore(Object.fromEntries(nextBracket.map(match => [match.id, { team1Score: match.team1_score || 0, team2Score: match.team2_score || 0, playDate: match.play_date || '' }])))
    } catch (error) { app.notify(errorMessage(error), 'error') } finally { setLoading(false) }
  }
  useEffect(() => { void loadList() }, [app.revision, loadList])

  const open = (cup?: Cup) => {
    setEditing(cup || 'new')
    setForm(cup ? { name: cup.name, seasonId: cup.season_id, format: cup.format, numTeams: cup.num_teams, regulationText: cup.regulation_text || '', startDate: cup.start_date || '', endDate: cup.end_date || '', finalResults: cup.final_results || '' } : blank())
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    try {
      const body = { ...form, startDate: form.startDate || null, endDate: form.endDate || null }
      if (editing === 'new') await api.mutate('/cups', 'POST', body)
      else if (editing) await api.mutate(`/cups/${editing.id}`, 'PUT', body)
      setEditing(null); await app.reload(); await loadList(); app.notify('Đã lưu giải đấu', 'success')
    } catch (error) { app.notify(errorMessage(error), 'error') }
  }
  const mutateSelected = async (path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown, message = 'Đã cập nhật') => {
    if (!selected) return
    try { await api.mutate(path, method, body); await loadDetail(selected.id); await loadList(); app.notify(message, 'success') } catch (error) { app.notify(errorMessage(error), 'error') }
  }

  const usedPlayers = useMemo(() => new Set(participants.flatMap(item => [item.player1_id, item.player2_id].filter(Boolean))), [participants])
  const rounds = useMemo(() => Array.from(new Set(bracket.map(match => match.round_number))).sort((a, b) => a - b), [bracket])
  const visibleCups = useMemo(() => cups.filter(cup => (statusFilter === 'all' || cup.status === statusFilter) && cup.name.toLocaleLowerCase('vi').includes(query.toLocaleLowerCase('vi'))), [cups, query, statusFilter])

  if (selected) return <section className="tab-content active">
    <button className="btn btn-ghost btn-sm back-button" onClick={() => setSelected(null)}><Icon name="back" size={15} /> Danh sách cúp</button>
    <PageHeader icon="trophy" title={selected.name} subtitle={`${statuses[selected.status]} · ${selected.num_teams} đội · ${formatDate(selected.start_date)} – ${formatDate(selected.end_date)}`} actions={app.isAdmin && selected.status !== 'completed' && <button className="btn btn-secondary" onClick={() => open(selected)}><Icon name="edit" /> Sửa thông tin</button>} />
    {selected.regulation_text && <div className="card react-card"><h3>Điều lệ</h3><p className="preserve-lines">{selected.regulation_text}</p></div>}
    {app.isAdmin && transitions[selected.status].length > 0 && <div className="card react-card"><h3>Trạng thái</h3><div className="card-actions">{transitions[selected.status].map(status => <button key={status} className="btn btn-primary btn-sm" onClick={() => void mutateSelected(`/cups/${selected.id}/status`, 'PUT', { status }, `Đã chuyển sang ${statuses[status]}`)}>{statuses[status]}</button>)}</div></div>}

    <div className="card react-card"><div className="section-header"><h3>Đội tham gia ({participants.length}/{selected.num_teams})</h3>{app.isAdmin && selected.status === 'draft' && participants.length >= 2 && <button className="btn btn-primary" onClick={() => void mutateSelected(`/cups/${selected.id}/generate-bracket`, 'POST', undefined, 'Đã tạo nhánh đấu')}>Tạo nhánh đấu</button>}</div>
      {app.isAdmin && selected.status === 'draft' && <form className="inline-form participant-form" onSubmit={event => { event.preventDefault(); void mutateSelected(`/cups/${selected.id}/participants`, 'POST', { ...participantForm, player2Id: participantForm.player2Id || undefined, seed: participants.length + 1 }, 'Đã thêm đội').then(() => setParticipantForm({ player1Id: 0, player2Id: 0, teamName: '' })) }}>
        <select required value={participantForm.player1Id || ''} onChange={e => setParticipantForm({ ...participantForm, player1Id: Number(e.target.value) })}><option value="">Người chơi 1</option>{app.players.filter(player => !usedPlayers.has(player.id)).map(player => <option key={player.id} value={player.id}>{player.name}</option>)}</select>
        <select value={participantForm.player2Id || ''} onChange={e => setParticipantForm({ ...participantForm, player2Id: Number(e.target.value) })}><option value="">Người chơi 2 (nếu đánh đôi)</option>{app.players.filter(player => !usedPlayers.has(player.id) && player.id !== participantForm.player1Id).map(player => <option key={player.id} value={player.id}>{player.name}</option>)}</select>
        <input placeholder="Tên đội (tùy chọn)" value={participantForm.teamName} onChange={e => setParticipantForm({ ...participantForm, teamName: e.target.value })} /><button className="btn btn-primary">Thêm</button>
      </form>}
      {participants.length === 0 ? <Empty>Chưa có đội tham gia</Empty> : <div className="participant-list">{participants.map((participant, index) => <div className="participant-row" key={participant.id}><span className="seed">#{participant.seed || index + 1}</span><strong>{participant.team_name || [participant.player1_name, participant.player2_name].filter(Boolean).join(' + ')}</strong>{app.isAdmin && selected.status === 'draft' && <><button className="btn btn-sm" disabled={index === 0} onClick={() => { const order = [...participants]; [order[index - 1], order[index]] = [order[index]!, order[index - 1]!]; void mutateSelected(`/cups/${selected.id}/participants/reorder`, 'PUT', { orderedIds: order.map(item => item.id) }) }}>↑</button><button className="btn btn-sm" disabled={index === participants.length - 1} onClick={() => { const order = [...participants]; [order[index + 1], order[index]] = [order[index]!, order[index + 1]!]; void mutateSelected(`/cups/${selected.id}/participants/reorder`, 'PUT', { orderedIds: order.map(item => item.id) }) }}>↓</button><ConfirmButton message="Xóa đội khỏi cúp?" onConfirm={() => mutateSelected(`/cups/${selected.id}/participants/${participant.id}`, 'DELETE')}>Xóa</ConfirmButton></>}</div>)}</div>}
    </div>

    <div className="card react-card"><h3>Nhánh đấu</h3>{bracket.length === 0 ? <Empty>Chưa tạo nhánh đấu</Empty> : <div className="bracket-board">{rounds.map(round => <div className="bracket-round" key={round}><h4>{round === rounds.at(-1) ? 'Chung kết' : `Vòng ${round}`}</h4>{bracket.filter(match => match.round_number === round).map(match => <article className={`bracket-match ${match.status || ''}`} key={match.id}>
        <div className={(match.winner_participant_id === (match.team1_participant_id ?? match.participant1_id)) ? 'winner' : ''}><span>{teamName(match, 1)}</span><strong>{match.team1_score ?? '–'}</strong></div><div className={(match.winner_participant_id === (match.team2_participant_id ?? match.participant2_id)) ? 'winner' : ''}><span>{teamName(match, 2)}</span><strong>{match.team2_score ?? '–'}</strong></div>
        {app.isAdmin && selected.status !== 'completed' && match.status !== 'completed' && <div className="bracket-controls"><input aria-label="Điểm đội 1" type="number" min={0} value={score[match.id]?.team1Score ?? 0} onChange={e => setScore({ ...score, [match.id]: { ...score[match.id]!, team1Score: Number(e.target.value) } })} /><input aria-label="Điểm đội 2" type="number" min={0} value={score[match.id]?.team2Score ?? 0} onChange={e => setScore({ ...score, [match.id]: { ...score[match.id]!, team2Score: Number(e.target.value) } })} /><button className="btn btn-sm btn-primary" disabled={selected.status !== 'in_progress'} onClick={() => void mutateSelected(`/cups/${selected.id}/matches/${match.id}`, 'PUT', score[match.id], 'Đã lưu tỷ số')}>Lưu điểm</button><input aria-label="Ngày thi đấu" type="date" value={score[match.id]?.playDate || ''} onChange={e => setScore({ ...score, [match.id]: { ...score[match.id]!, playDate: e.target.value } })} /><button className="btn btn-sm" onClick={() => void mutateSelected(`/cups/${selected.id}/matches/${match.id}/date`, 'PUT', { playDate: score[match.id]?.playDate })}>Lưu ngày</button>{match.winner_participant_id && <button className="btn btn-sm btn-warning" onClick={() => void mutateSelected(`/cups/${selected.id}/matches/${match.id}/reset`, 'PUT')}>Đặt lại</button>}</div>}
      </article>)}</div>)}</div>}</div>

    {selected.status === 'completed' && selected.final_results && <div className="card react-card"><h3>Tổng kết cúp</h3><p className="preserve-lines">{selected.final_results}</p></div>}

    {editing && <CupModal editing={editing} form={form} setForm={setForm} onClose={() => setEditing(null)} onSave={save} />}
  </section>

  return <section className="tab-content active"><PageHeader icon="trophy" title="Cúp & giải đấu" subtitle="Nhánh đấu loại trực tiếp" actions={app.isAdmin && <button className="btn btn-primary" onClick={() => open()}><Icon name="plus" /> Tạo cúp</button>} />
    <div className="entity-toolbar cup-toolbar"><label className="search-field"><span className="sr-only">Tìm cúp</span><Icon name="search" /><input type="search" placeholder="Tìm cúp…" value={query} onChange={event => setQuery(event.target.value)} /></label><label className="compact-select">Trạng thái<select value={statusFilter} onChange={event => setStatusFilter(event.target.value as 'all' | CupStatus)}><option value="all">Tất cả</option>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    {loading ? <Loading /> : cups.length === 0 ? <Empty /> : visibleCups.length === 0 ? <Empty>Không tìm thấy cúp phù hợp</Empty> : <div className="cups-grid">{visibleCups.map(cup => <article className="cup-card clickable" key={cup.id} onClick={() => void loadDetail(cup.id)}><div className="cup-card-header"><h3>{cup.name}</h3><StatusBadge tone={statusTone(cup.status)}>{statuses[cup.status]}</StatusBadge></div><div className="cup-card-meta"><span><Icon name="users" size={15} /> {cup.num_teams} đội</span><span><Icon name="calendar" size={15} /> {formatDate(cup.start_date)} – {formatDate(cup.end_date)}</span>{cup.season_name && <span><Icon name="trophy" size={15} /> {cup.season_name}</span>}</div><div className="cup-card-actions" onClick={event => event.stopPropagation()}>{app.isAdmin && cup.status !== 'completed' && <button className="btn btn-sm btn-secondary" onClick={() => open(cup)}><Icon name="edit" size={14} /> Sửa</button>}{app.isAdmin && cup.status === 'draft' && <ConfirmButton message={`Xóa ${cup.name}?`} onConfirm={async () => { await api.mutate(`/cups/${cup.id}`, 'DELETE'); await loadList() }}><Icon name="trash" size={14} /> Xóa</ConfirmButton>}<button type="button" className="btn btn-sm btn-ghost" onClick={() => void loadDetail(cup.id)}>Chi tiết <Icon name="chevron" size={14} /></button></div></article>)}</div>}
    {editing && <CupModal editing={editing} form={form} setForm={setForm} onClose={() => setEditing(null)} onSave={save} />}
  </section>
}

function CupModal({ editing, form, setForm, onClose, onSave }: { editing: Cup | 'new'; form: CupForm; setForm: (value: CupForm) => void; onClose: () => void; onSave: (event: FormEvent) => Promise<void> }) {
  const app = useApp()
  return <Modal title={editing === 'new' ? 'Tạo cúp' : 'Chỉnh sửa cúp'} onClose={onClose} wide><form onSubmit={onSave}><div className="modal-body react-form-grid">
    <label className="form-group">Tên cúp<input required maxLength={255} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label><label className="form-group">Mùa giải<select value={form.seasonId || ''} onChange={e => setForm({ ...form, seasonId: e.target.value ? Number(e.target.value) : null })}><option value="">Không gắn mùa</option>{app.seasons.map(season => <option key={season.id} value={season.id}>{season.name}</option>)}</select></label><label className="form-group">Số đội<select value={form.numTeams} onChange={e => setForm({ ...form, numTeams: Number(e.target.value) })}>{[2, 4, 8, 16, 32].map(value => <option key={value}>{value}</option>)}</select></label><label className="form-group">Thể thức<select value={form.format} onChange={e => setForm({ ...form, format: e.target.value as CupFormat })}><option value="single_elimination">Loại trực tiếp</option></select></label><label className="form-group">Bắt đầu<input type="date" value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} /></label><label className="form-group">Kết thúc<input type="date" value={form.endDate} onChange={e => setForm({ ...form, endDate: e.target.value })} /></label><label className="form-group full-width">Điều lệ<textarea rows={5} value={form.regulationText} onChange={e => setForm({ ...form, regulationText: e.target.value })} /></label>
  </div><div className="modal-footer"><button type="button" className="btn btn-secondary" onClick={onClose}>Hủy</button><button className="btn btn-primary">Lưu</button></div></form></Modal>
}
