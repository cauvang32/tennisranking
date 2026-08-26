import { useEffect, useState } from 'react'
import type { Ranking, ViewMode } from '../../../shared/domain'
import { api } from '../../api/client'
import { Empty, Loading, PageHeader, errorMessage, formatMoney } from '../../components/common'
import { useApp } from '../../app/app-context'
import { Icon } from '../../components/icons'

const labels: Record<ViewMode, string> = { daily: 'Theo ngày', season: 'Theo mùa', lifetime: 'Toàn thời gian' }

export function RankingsFeature() {
  const app = useApp()
  const [mode, setMode] = useState<ViewMode>('daily')
  const [date, setDate] = useState(app.data?.defaultDate || new Date().toISOString().slice(0, 10))
  const [seasonId, setSeasonId] = useState<number>(app.data?.activeSeason?.id || app.seasons[0]?.id || 0)
  const [rankings, setRankings] = useState<Ranking[]>(app.data?.defaultDateRankings || [])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const value = mode === 'daily' ? date : seasonId
    api.rankings(mode, value).then(rows => { if (!cancelled) setRankings(rows) }).catch(error => app.notify(errorMessage(error), 'error')).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [app, app.revision, date, mode, seasonId])

  const exportPath = mode === 'daily' ? `/export-excel/date/${date}` : mode === 'season' ? `/export-excel/season/${seasonId}` : '/export-excel/lifetime'

  return <section className="tab-content active">
    <PageHeader icon="chart" title="Bảng xếp hạng" subtitle="Cập nhật tự động khi dữ liệu thay đổi" actions={app.canEdit && <button className="btn btn-secondary" onClick={() => void api.download(exportPath, `tennis-${mode}.xlsx`).catch(error => app.notify(errorMessage(error), 'error'))}><Icon name="download" /> Xuất Excel</button>} />
    <div className="ranking-toolbar">
      <div className="view-mode-selector">
      {(['daily', 'season', 'lifetime'] as ViewMode[]).map(item => <button key={item} className={`view-mode-btn ${mode === item ? 'active' : ''}`} onClick={() => setMode(item)}>{labels[item]}</button>)}
      </div>
      <div className="filters-section compact-filter">
        {mode === 'daily' && <label>Ngày thi đấu<select value={date} onChange={e => setDate(e.target.value)}>{app.data?.playDates.map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
        {mode === 'season' && <label>Mùa giải<select value={seasonId} onChange={e => setSeasonId(Number(e.target.value))}>{app.seasons.map(season => <option key={season.id} value={season.id}>{season.name}</option>)}</select></label>}
      </div>
    </div>
    {loading ? <Loading /> : rankings.length === 0 ? <Empty>Chưa có dữ liệu xếp hạng</Empty> : <div className="table-container"><table className="rankings-table">
      <thead><tr><th>Hạng</th><th>Người chơi</th><th>Trận</th><th>Thắng</th><th>Thua</th><th>Điểm</th><th>Tỷ lệ thắng</th><th>Phong độ</th><th>Tiền</th></tr></thead>
      <tbody>{rankings.map((row, index) => {
        const played = row.total_matches ?? row.matches_played ?? row.wins + row.losses
        const rate = row.win_rate ?? row.win_percentage ?? (played ? row.wins / played * 100 : 0)
        return <tr key={row.player_id ?? row.id ?? index} className={index < 3 ? `rank-${index + 1}` : ''}>
          <td><span className="rank-badge">{index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : index + 1}</span></td>
          <td><strong>{row.player_name || row.name}</strong></td><td>{played}</td><td>{row.wins}</td><td>{row.losses}</td><td><strong>{row.points}</strong></td>
          <td>{Number(rate).toFixed(1)}%</td><td><div className="form-indicator">{row.form?.map((entry, i) => {
            const result = typeof entry === 'string' ? entry : entry.result
            return <span key={i} className={`form-dot ${result.toLowerCase().startsWith('w') ? 'win' : 'loss'}`}>{result.slice(0, 1).toUpperCase()}</span>
          })}</div></td>
          <td>{formatMoney(row.total_money ?? row.money ?? row.money_lost)}</td>
        </tr>
      })}</tbody>
    </table></div>}
  </section>
}
