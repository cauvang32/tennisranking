import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react'
import type { Match, MatchInput, MatchType, Player } from '../../../shared/domain'
import { api } from '../../api/client'
import { ConfirmButton, Empty, Loading, PageHeader, Panel, errorMessage, formatDate } from '../../components/common'
import { useApp } from '../../app/app-context'
import { Icon } from '../../components/icons'

const today = () => new Date().toISOString().slice(0, 10)

function blankMatch(seasonId = 0, playDate = today(), matchType: MatchType = 'duo'): MatchInput {
  return { seasonId, playDate, player1Id: 0, player2Id: null, player3Id: 0, player4Id: null, team1Score: 0, team2Score: 0, winningTeam: 1, matchType }
}

function PlayerSelect({ value, players, onChange, label }: { value: number | null; players: Player[]; onChange: (id: number | null) => void; label: string }) {
  return <label className="form-group">{label}<select required value={value || ''} onChange={e => onChange(e.target.value ? Number(e.target.value) : null)}><option value="">-- Chọn --</option>{players.map(player => <option key={player.id} value={player.id}>{player.name}</option>)}</select></label>
}

function winnerFromScores(team1Score: number, team2Score: number, fallback: 1 | 2): 1 | 2 {
  return team1Score === team2Score ? fallback : team1Score > team2Score ? 1 : 2
}

function validate(input: MatchInput): string | null {
  const ids = input.matchType === 'solo' ? [input.player1Id, input.player3Id] : [input.player1Id, input.player2Id, input.player3Id, input.player4Id]
  if (!input.seasonId || !input.playDate || ids.some(id => !id)) return 'Vui lòng nhập đầy đủ mùa giải, ngày và người chơi'
  if (new Set(ids).size !== ids.length) return 'Mỗi vị trí phải là một người chơi khác nhau'
  if (input.team1Score < 0 || input.team2Score < 0) return 'Tỷ số không hợp lệ'
  return null
}

interface ParsedMatch {
  player1Name: string
  player2Name?: string | null
  player3Name: string
  player4Name?: string | null
  team1Score: number
  team2Score: number
  winningTeam: 1 | 2
  matchType: MatchType
}

export function MatchesFeature() {
  const app = useApp()
  const activeSeason = app.seasons.find(season => season.is_active) || app.seasons[0]
  const defaultDate = app.data?.defaultDate || today()
  const [form, setForm] = useState<MatchInput>(() => blankMatch(activeSeason?.id, defaultDate))
  const [editingId, setEditingId] = useState<number | undefined>()
  const [eligiblePlayers, setEligiblePlayers] = useState<Player[]>(app.players)
  const [historyDate, setHistoryDate] = useState(defaultDate)
  const [history, setHistory] = useState<Match[]>(app.data?.defaultDateMatches || [])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [busy, setBusy] = useState(false)
  const [batch, setBatch] = useState<MatchInput[]>([])
  const [parsed, setParsed] = useState<ParsedMatch[]>([])
  const [parsing, setParsing] = useState(false)

  useEffect(() => {
    if (!form.seasonId) { setEligiblePlayers(app.players); return }
    let cancelled = false
    api.seasonPlayers(form.seasonId).then(players => { if (!cancelled) setEligiblePlayers(players.length ? players : app.players) }).catch(() => setEligiblePlayers(app.players))
    return () => { cancelled = true }
  }, [app.players, form.seasonId])

  useEffect(() => {
    if (!historyDate) return
    let cancelled = false
    setLoadingHistory(true)
    api.matchesByDate(historyDate).then(rows => { if (!cancelled) setHistory(rows) }).catch(error => app.notify(errorMessage(error), 'error')).finally(() => { if (!cancelled) setLoadingHistory(false) })
    return () => { cancelled = true }
  }, [app, app.revision, historyDate])

  const selectedIds = useMemo(() => [form.player1Id, form.player2Id, form.player3Id, form.player4Id].filter(Boolean), [form])
  const available = (current: number | null) => eligiblePlayers.filter(player => player.id === current || !selectedIds.includes(player.id))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const issue = validate(form)
    if (issue) { app.notify(issue, 'error'); return }
    setBusy(true)
    try {
      await api.saveMatch(form, editingId)
      app.notify(editingId ? 'Đã cập nhật trận đấu' : 'Đã ghi nhận trận đấu', 'success')
      setEditingId(undefined)
      setForm(blankMatch(form.seasonId, form.playDate, form.matchType))
      await app.reload()
      setHistory(await api.matchesByDate(form.playDate))
      setHistoryDate(form.playDate)
    } catch (error) { app.notify(errorMessage(error), 'error') } finally { setBusy(false) }
  }

  const startEdit = (match: Match) => {
    setEditingId(match.id)
    setForm({
      seasonId: match.season_id, playDate: match.play_date.slice(0, 10), matchType: match.match_type,
      player1Id: match.player1_id, player2Id: match.player2_id, player3Id: match.player3_id, player4Id: match.player4_id,
      team1Score: match.team1_score, team2Score: match.team2_score, winningTeam: match.winning_team
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const addBatch = () => {
    const issue = validate(form)
    if (issue) { app.notify(issue, 'error'); return }
    setBatch(items => [...items, { ...form }])
    setForm(blankMatch(form.seasonId, form.playDate, form.matchType))
  }

  const submitBatch = async () => {
    if (!batch.length) return
    setBusy(true)
    try {
      await api.mutate('/matches/bulk-create', 'POST', { matches: batch })
      setBatch([]); await app.reload(); app.notify('Đã ghi nhận danh sách trận đấu', 'success')
    } catch (error) { app.notify(errorMessage(error), 'error') } finally { setBusy(false) }
  }

  const handleScreenshot = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setParsing(true)
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file) })
      const result = await api.mutate<{ matches: ParsedMatch[] }>('/matches/parse-image', 'POST', { imageBase64: dataUrl.split(',')[1], mimeType: file.type })
      setParsed(result.matches || [])
      app.notify(`Đã trích xuất ${result.matches?.length || 0} trận`, 'success')
    } catch (error) { app.notify(errorMessage(error), 'error') } finally { setParsing(false); event.target.value = '' }
  }

  const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const findPlayer = (name?: string | null) => app.players.find(player => normalize(player.name) === normalize(name || ''))?.id || 0
  const confirmParsed = async () => {
    if (!parsed.length) return
    // Map each parsed row to a match, dropping any that can't be matched to
    // existing players (name not found or invalid). The old UI let users fix or
    // skip individual rows; keep that behavior instead of aborting the whole batch.
    const candidates = parsed.map(item => ({
      ...blankMatch(activeSeason?.id, defaultDate, item.matchType),
      player1Id: findPlayer(item.player1Name), player2Id: item.matchType === 'duo' ? findPlayer(item.player2Name) || null : null,
      player3Id: findPlayer(item.player3Name), player4Id: item.matchType === 'duo' ? findPlayer(item.player4Name) || null : null,
      team1Score: item.team1Score, team2Score: item.team2Score, winningTeam: item.winningTeam
    }))
    const valid = candidates.filter(match => !validate(match))
    const skipped = candidates.length - valid.length
    if (!valid.length) { app.notify('Không có trận nào khớp với người chơi hiện có. Hãy thêm thủ công.', 'error'); return }
    setBusy(true)
    try {
      await api.mutate('/matches/bulk-create', 'POST', { matches: valid })
      setParsed([])
      await app.reload()
      app.notify(skipped > 0 ? `Đã ghi nhận ${valid.length} trận, bỏ qua ${skipped} trận chưa khớp` : 'Đã ghi nhận kết quả từ ảnh', skipped ? 'info' : 'success')
    } catch (error) { app.notify(errorMessage(error), 'error') } finally { setBusy(false) }
  }

  return <section className="tab-content active">
    <PageHeader icon="tennis" title="Quản lý trận đấu" subtitle="Ghi nhận 1v1, 2v2, theo lô hoặc từ ảnh" />
    {app.canEdit && <Panel className="match-entry-panel" title={editingId ? `Chỉnh sửa trận #${editingId}` : 'Ghi nhận trận đấu'}>
      <form onSubmit={submit} className="match-entry-form">
        <div className="match-meta-grid">
          <label className="form-group">Loại trận<select value={form.matchType} onChange={e => setForm(blankMatch(form.seasonId, form.playDate, e.target.value as MatchType))}><option value="duo">Đôi (2v2)</option><option value="solo">Đơn (1v1)</option></select></label>
          <label className="form-group">Mùa giải<select required value={form.seasonId || ''} onChange={e => setForm({ ...form, seasonId: Number(e.target.value), player1Id: 0, player2Id: null, player3Id: 0, player4Id: null })}><option value="">-- Chọn --</option>{app.seasons.filter(s => s.is_active || s.id === form.seasonId).map(season => <option value={season.id} key={season.id}>{season.name}</option>)}</select></label>
          <label className="form-group">Ngày thi đấu<input required type="date" value={form.playDate} onChange={e => setForm({ ...form, playDate: e.target.value })} /></label>
        </div>
        <div className="match-teams-editor">
          <fieldset className="team-editor team-one"><legend>Đội 1</legend><PlayerSelect label="Người chơi 1" players={available(form.player1Id)} value={form.player1Id} onChange={id => setForm({ ...form, player1Id: id || 0 })} />{form.matchType === 'duo' && <PlayerSelect label="Người chơi 2" players={available(form.player2Id)} value={form.player2Id} onChange={id => setForm({ ...form, player2Id: id })} />}</fieldset>
          <fieldset className="score-editor"><legend>Kết quả</legend><div className="score-inputs"><label className="form-group">Đội 1<input aria-label="Tỷ số đội 1" min={0} max={100} type="number" value={form.team1Score} onChange={e => setForm({ ...form, team1Score: Number(e.target.value), winningTeam: winnerFromScores(Number(e.target.value), form.team2Score, form.winningTeam) })} /></label><span>:</span><label className="form-group">Đội 2<input aria-label="Tỷ số đội 2" min={0} max={100} type="number" value={form.team2Score} onChange={e => setForm({ ...form, team2Score: Number(e.target.value), winningTeam: winnerFromScores(form.team1Score, Number(e.target.value), form.winningTeam) })} /></label></div><label className="form-group">Đội thắng<select value={form.winningTeam} onChange={e => setForm({ ...form, winningTeam: Number(e.target.value) as 1 | 2 })}><option value={1}>Đội 1</option><option value={2}>Đội 2</option></select></label></fieldset>
          <fieldset className="team-editor team-two"><legend>Đội 2</legend><PlayerSelect label="Người chơi 1" players={available(form.player3Id)} value={form.player3Id} onChange={id => setForm({ ...form, player3Id: id || 0 })} />{form.matchType === 'duo' && <PlayerSelect label="Người chơi 2" players={available(form.player4Id)} value={form.player4Id} onChange={id => setForm({ ...form, player4Id: id })} />}</fieldset>
        </div>
        <div className="react-form-actions"><button className="btn btn-primary" disabled={busy}>{editingId ? 'Lưu thay đổi' : 'Ghi nhận'}</button>{!editingId && <button type="button" className="btn btn-secondary" onClick={addBatch}><Icon name="plus" /> Thêm vào lô</button>}{editingId && <button type="button" className="btn btn-secondary" onClick={() => { setEditingId(undefined); setForm(blankMatch(activeSeason?.id, defaultDate)) }}>Hủy sửa</button>}</div>
      </form>
      {batch.length > 0 && <div className="batch-panel"><div className="subsection-heading"><h4>Lô chờ gửi</h4><span className="count-badge">{batch.length}</span></div>{batch.map((item, index) => <div className="batch-row" key={index}><span>{item.playDate} · {item.matchType === 'solo' ? '1v1' : '2v2'} · {item.team1Score}-{item.team2Score}</span><button type="button" className="btn btn-sm btn-danger" onClick={() => setBatch(rows => rows.filter((_, i) => i !== index))}><Icon name="trash" size={14} /> Xóa</button></div>)}<button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submitBatch()}>Gửi toàn bộ</button></div>}
      <details className="image-import"><summary><Icon name="image" /> Nhập kết quả từ ảnh</summary><div className="image-import-body"><p>Chọn ảnh PNG, JPEG hoặc WebP có danh sách kết quả rõ ràng.</p><label className="btn btn-secondary file-button"><Icon name="upload" /> {parsing ? 'Đang phân tích…' : 'Chọn ảnh kết quả'}<input hidden type="file" accept="image/png,image/jpeg,image/webp" disabled={parsing} onChange={handleScreenshot} /></label>{parsed.length > 0 && <><div className="parsed-list">{parsed.map((item, index) => <div className="parsed-row" key={index}><strong>{item.player1Name}{item.player2Name ? ` + ${item.player2Name}` : ''}</strong><span>{item.team1Score} – {item.team2Score}</span><strong>{item.player3Name}{item.player4Name ? ` + ${item.player4Name}` : ''}</strong><button type="button" className="btn btn-sm btn-danger" onClick={() => setParsed(rows => rows.filter((_, i) => i !== index))}><Icon name="close" size={14} /></button></div>)}</div><button type="button" className="btn btn-primary" onClick={() => void confirmParsed()}>Xác nhận tất cả</button></>}</div></details>
    </Panel>}

    <Panel title="Lịch sử trận đấu" actions={<label className="compact-select">Ngày<select value={historyDate} onChange={e => setHistoryDate(e.target.value)}>{app.data?.playDates.map(date => <option key={date} value={date}>{date}</option>)}</select></label>}>
      {loadingHistory ? <Loading /> : history.length === 0 ? <Empty>Không có trận đấu ngày này</Empty> : <div className="matches-grid">{history.map(match => <article className="match-card" key={match.id}>
        <div className="match-card-header"><span className="match-type-badge">{match.match_type === 'solo' ? '1v1' : '2v2'}</span><span>{formatDate(match.play_date)}</span></div>
        <div className="match-result"><div className={match.winning_team === 1 ? 'match-side winner' : 'match-side'}>{match.winning_team === 1 && <Icon name="check" size={14} />}<strong>{match.player1_name}{match.player2_name ? ` + ${match.player2_name}` : ''}</strong></div><div className="match-score"><strong>{match.team1_score} : {match.team2_score}</strong></div><div className={match.winning_team === 2 ? 'match-side winner' : 'match-side'}>{match.winning_team === 2 && <Icon name="check" size={14} />}<strong>{match.player3_name}{match.player4_name ? ` + ${match.player4_name}` : ''}</strong></div></div>
        {app.canEdit && <div className="match-card-actions"><button type="button" className="btn btn-sm btn-secondary" onClick={() => startEdit(match)}><Icon name="edit" size={14} /> Sửa</button><ConfirmButton message="Xóa trận đấu này?" onConfirm={async () => { try { await api.mutate(`/matches/${match.id}`, 'DELETE'); setHistory(rows => rows.filter(row => row.id !== match.id)); await app.reload(); app.notify('Đã xóa trận đấu', 'success') } catch (error) { app.notify(errorMessage(error), 'error') } }}><Icon name="trash" size={14} /> Xóa</ConfirmButton></div>}
      </article>)}</div>}
    </Panel>
  </section>
}
