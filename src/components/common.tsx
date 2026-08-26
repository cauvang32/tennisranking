import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Icon, type IconName } from './icons'

export function Loading({ label = 'Đang tải...' }: { label?: string }) {
  return <div className="react-loading"><span className="spinner" /> {label}</div>
}

export function Empty({ children = 'Chưa có dữ liệu' }: { children?: ReactNode }) {
  return <div className="empty-state"><p>{children}</p></div>
}

export function PageHeader({ icon, title, subtitle, actions }: { icon: IconName; title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return <div className="page-header"><div className="page-heading"><span className="page-heading-icon"><Icon name={icon} size={24} /></span><div><h2 tabIndex={-1}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div></div>{actions && <div className="page-actions">{actions}</div>}</div>
}

export function Panel({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`ui-panel ${className}`.trim()}>{(title || actions) && <header className="ui-panel-header">{title && <h3>{title}</h3>}{actions && <div className="card-actions">{actions}</div>}</header>}<div className="ui-panel-body">{children}</div></section>
}

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export function StatusBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: StatusTone }) {
  return <span className={`status-badge tone-${tone}`}>{children}</span>
}

export function Modal({ title, children, onClose, wide = false }: {
  title: string
  children: ReactNode
  onClose: () => void
  wide?: boolean
}) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') || [])
    requestAnimationFrame(() => {
      const firstField = dialogRef.current?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')
      ;(firstField || focusable()[0])?.focus()
    })
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { onCloseRef.current(); return }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (!items.length) return
      const first = items[0]!
      const last = items.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', handleKey)
    return () => { window.removeEventListener('keydown', handleKey); document.body.style.overflow = previousOverflow; previous?.focus() }
  }, [])
  return <div className="modal react-modal active" role="presentation" onMouseDown={event => {
    if (event.target === event.currentTarget) onCloseRef.current()
  }}>
    <div ref={dialogRef} aria-labelledby={titleId} aria-modal="true" className={`modal-content ${wide ? 'modal-wide' : ''}`} role="dialog">
      <div className="modal-header"><h3 id={titleId}>{title}</h3><button type="button" className="close-btn" onClick={() => onCloseRef.current()} aria-label="Đóng"><Icon name="close" /></button></div>
      {children}
    </div>
  </div>
}

export function ConfirmButton({ message, onConfirm, children, className = 'btn btn-danger btn-sm', disabled = false }: {
  message: string
  onConfirm: () => void | Promise<void>
  children: ReactNode
  className?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  return <><button type="button" className={className} disabled={disabled || busy} onClick={() => setOpen(true)}>{children}</button>{open && <Modal title="Xác nhận thao tác" onClose={() => { if (!busy) setOpen(false) }}><div className="modal-body confirm-dialog"><span className="confirm-icon"><Icon name="trash" size={22} /></span><p>{message}</p></div><div className="modal-footer"><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setOpen(false)}>Hủy</button><button type="button" className="btn btn-danger" disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); setOpen(false) } finally { setBusy(false) } }}>{busy ? 'Đang xử lý…' : 'Xác nhận'}</button></div></Modal>}</>
}

export async function runForm(event: FormEvent, action: () => Promise<void>, setBusy: (busy: boolean) => void) {
  event.preventDefault()
  setBusy(true)
  try { await action() } finally { setBusy(false) }
}

export function formatDate(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value.includes('T') ? value : `${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('vi-VN').format(date)
}

export function formatMoney(value?: number | string | null) {
  return new Intl.NumberFormat('vi-VN').format(Number(value) || 0) + ' ₫'
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Đã xảy ra lỗi'
}
