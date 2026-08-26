import { useEffect, useMemo, useState } from 'react'
import { useApp } from './app-context'
import { Loading } from '../components/common'
import { RankingsFeature } from '../features/rankings/RankingsFeature'
import { MatchesFeature } from '../features/matches/MatchesFeature'
import { PlayersFeature } from '../features/players/PlayersFeature'
import { SeasonsFeature } from '../features/seasons/SeasonsFeature'
import { CupsFeature } from '../features/cups/CupsFeature'
import { AccountsFeature } from '../features/accounts/AccountsFeature'
import { ImagesFeature } from '../features/images/ImagesFeature'
import { DataFeature } from '../features/data/DataFeature'
import { Icon, type IconName } from '../components/icons'

type Tab = 'rankings' | 'matches' | 'players' | 'seasons' | 'cups' | 'accounts' | 'images' | 'data'

const tabs: Array<{ id: Tab; label: string; icon: IconName; admin?: boolean; edit?: boolean }> = [
  { id: 'rankings', label: 'Bảng Xếp Hạng', icon: 'chart' },
  { id: 'matches', label: 'Trận Đấu', icon: 'tennis' },
  { id: 'players', label: 'Người Chơi', icon: 'users' },
  { id: 'seasons', label: 'Mùa Giải', icon: 'calendar' },
  { id: 'cups', label: 'Cúp', icon: 'trophy' },
  { id: 'accounts', label: 'Tài Khoản', icon: 'lock', admin: true },
  { id: 'images', label: 'Hình Ảnh', icon: 'image', admin: true },
  { id: 'data', label: 'Dữ Liệu', icon: 'database', edit: true }
]

function tabFromHash(): Tab | null {
  const value = window.location.hash.replace(/^#/, '')
  return tabs.some(item => item.id === value) ? value as Tab : null
}

export function App() {
  const app = useApp()
  const [tab, setTab] = useState<Tab>(() => tabFromHash() || 'rankings')
  const [showLogin, setShowLogin] = useState(false)
  const [credentials, setCredentials] = useState({ username: '', password: '' })
  const [loginError, setLoginError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const visibleTabs = useMemo(() => tabs.filter(item => (!item.admin || app.isAdmin) && (!item.edit || app.canEdit)), [app.canEdit, app.isAdmin])
  const managementTabs = useMemo(() => visibleTabs.filter(item => ['accounts', 'images', 'data'].includes(item.id)), [visibleTabs])
  const primaryTabs = useMemo(() => {
    const coreTabs = visibleTabs.filter(item => !['accounts', 'images', 'data'].includes(item.id))
    if (managementTabs.length === 0) return coreTabs
    const managementTab: { id: Tab; label: string; icon: IconName } = app.isAdmin
      ? { id: 'accounts', label: 'Quản trị', icon: 'lock' }
      : { id: 'data', label: 'Dữ liệu', icon: 'database' }
    return [...coreTabs, managementTab]
  }, [app.isAdmin, managementTabs, visibleTabs])
  const isManagementTab = managementTabs.some(item => item.id === tab)

  useEffect(() => {
    const syncTab = () => {
      const requested = tabFromHash()
      const next = requested && visibleTabs.some(item => item.id === requested) ? requested : 'rankings'
      if (window.location.hash !== `#${next}`) window.history.replaceState(null, '', `#${next}`)
      setTab(next)
      window.scrollTo({ top: 0, behavior: 'auto' })
      requestAnimationFrame(() => document.querySelector<HTMLElement>('#main-content h2')?.focus({ preventScroll: true }))
    }
    syncTab()
    window.addEventListener('hashchange', syncTab)
    window.addEventListener('popstate', syncTab)
    return () => { window.removeEventListener('hashchange', syncTab); window.removeEventListener('popstate', syncTab) }
  }, [visibleTabs])

  const selectTab = (next: Tab) => {
    if (window.location.hash === `#${next}`) {
      window.scrollTo({ top: 0, behavior: 'smooth' })
      document.querySelector<HTMLElement>('#main-content h2')?.focus({ preventScroll: true })
    } else {
      window.history.pushState(null, '', `#${next}`)
      setTab(next)
      window.scrollTo({ top: 0, behavior: 'auto' })
      requestAnimationFrame(() => document.querySelector<HTMLElement>('#main-content h2')?.focus({ preventScroll: true }))
    }
  }

  if (app.loading && !app.data) return <main className="app-container"><Loading label="Đang khởi tạo hệ thống..." /></main>

  return <div className="app-container react-app">
    <header className="app-header">
      <div className="header-content">
        <div className="logo-section"><div className="logo-icon" aria-hidden="true">🎾</div><div className="logo-text">
          <h1>Câu lạc bộ Tennis Siêu Lành Mạnh</h1>
          <span className="tagline">Làm chăm, sống khỏe, vui chơi lành mạnh</span>
        </div></div>
        <nav className="main-nav" aria-label="Điều hướng chính">
          {primaryTabs.map(item => <button type="button" key={item.id} aria-current={(item.id === 'accounts' && app.isAdmin ? isManagementTab : tab === item.id) ? 'page' : undefined} className={`nav-btn ${(item.id === 'accounts' && app.isAdmin ? isManagementTab : tab === item.id) ? 'active' : ''}`} onClick={() => selectTab(item.id)}>
            <span className="nav-icon"><Icon name={item.icon} /></span><span className="nav-text">{item.label}</span>
          </button>)}
        </nav>
        <div className="auth-section">
          {app.authenticated ? <>
            <div className="user-info"><span className="user-name">{app.user?.displayName || app.user?.display_name || app.user?.username}</span><span className="user-role badge">{app.user?.role}</span></div>
            <button className="btn btn-secondary btn-sm" onClick={() => void app.logout()}>Đăng xuất</button>
          </> : <button className="btn btn-primary btn-sm" onClick={() => setShowLogin(true)}>Đăng nhập</button>}
        </div>
      </div>
    </header>

    <main className="main-content" id="main-content">
      {app.error && <div className="status-message error">⚠️ {app.error} <button className="btn btn-sm" onClick={() => void app.reload()}>Thử lại</button></div>}
      {isManagementTab && managementTabs.length > 1 && <nav className="admin-subnav" aria-label="Quản trị">
        {managementTabs.map(item => <button type="button" key={item.id} aria-current={tab === item.id ? 'page' : undefined} className={`admin-subnav-btn ${tab === item.id ? 'active' : ''}`} onClick={() => selectTab(item.id)}><Icon name={item.icon} size={16} />{item.label}</button>)}
      </nav>}
      {tab === 'rankings' && <RankingsFeature />}
      {tab === 'matches' && <MatchesFeature />}
      {tab === 'players' && <PlayersFeature />}
      {tab === 'seasons' && <SeasonsFeature />}
      {tab === 'cups' && <CupsFeature />}
      {tab === 'accounts' && app.isAdmin && <AccountsFeature />}
      {tab === 'images' && app.isAdmin && <ImagesFeature />}
      {tab === 'data' && app.canEdit && <DataFeature />}
    </main>

    <footer className="app-footer"><p>🎾 Tennis Siêu Lành Mạnh</p></footer>

    {showLogin && <div className="modal react-modal active" role="dialog" aria-modal="true">
      <form className="modal-content" onSubmit={async event => {
        event.preventDefault(); setBusy(true); setLoginError(null)
        const error = await app.login(credentials.username, credentials.password)
        setBusy(false)
        if (error) setLoginError(error); else setShowLogin(false)
      }}>
        <div className="modal-header"><h3>Đăng nhập</h3><button type="button" className="close-btn" onClick={() => setShowLogin(false)}>×</button></div>
        <div className="modal-body">
          {loginError && <div className="status-message error">{loginError}</div>}
          <label className="form-group">Tên đăng nhập<input required autoComplete="username" value={credentials.username} onChange={e => setCredentials({ ...credentials, username: e.target.value })} /></label>
          <label className="form-group">Mật khẩu<input required type="password" autoComplete="current-password" value={credentials.password} onChange={e => setCredentials({ ...credentials, password: e.target.value })} /></label>
        </div>
        <div className="modal-footer"><button type="button" className="btn btn-secondary" onClick={() => setShowLogin(false)}>Hủy</button><button className="btn btn-primary" disabled={busy}>{busy ? 'Đang đăng nhập...' : 'Đăng nhập'}</button></div>
      </form>
    </div>}
  </div>
}
