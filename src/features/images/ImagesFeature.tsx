import { useCallback, useEffect, useState } from 'react'
import type { SiteImage } from '../../../shared/domain'
import { api } from '../../api/client'
import { ConfirmButton, Empty, Loading, PageHeader, StatusBadge, errorMessage, formatDate } from '../../components/common'
import { useApp } from '../../app/app-context'
import { Icon } from '../../components/icons'

const imageDefinitions = [
  { key: 'hero_banner', label: 'Ảnh bìa' }, { key: 'logo', label: 'Logo' }, { key: 'favicon', label: 'Favicon' }, { key: 'background', label: 'Ảnh nền' }
]

export function ImagesFeature() {
  const app = useApp()
  const notify = app.notify
  const [images, setImages] = useState<SiteImage[]>([])
  const [loading, setLoading] = useState(true)
  const [alt, setAlt] = useState<Record<string, string>>({})
  const load = useCallback(async () => { setLoading(true); try { const rows = await api.images(); setImages(rows); setAlt(Object.fromEntries(rows.map(image => [image.key, image.alt_text || '']))) } catch (error) { notify(errorMessage(error), 'error') } finally { setLoading(false) } }, [notify])
  useEffect(() => { void load() }, [app.revision, load])

  return <section className="tab-content active"><PageHeader icon="image" title="Hình ảnh website" subtitle="PNG, JPEG, WebP hoặc GIF · tối đa 10 MB" actions={<details className="maintenance-menu"><summary className="btn btn-secondary"><Icon name="more" /> Bảo trì</summary><div className="maintenance-popover"><button type="button" onClick={async () => { try { await api.mutate('/images/migrate-hero', 'POST'); await load(); app.notify('Đã kiểm tra ảnh bìa cũ', 'success') } catch (error) { app.notify(errorMessage(error), 'error') } }}>Di chuyển ảnh bìa cũ</button></div></details>} />
    {loading ? <Loading /> : <div className="image-editor-grid">{imageDefinitions.map(definition => { const image = images.find(item => item.key === definition.key); return <article className="image-editor-card" key={definition.key}><div className="image-editor-header"><h3>{definition.label}</h3><StatusBadge tone={image?.is_active ? 'success' : 'neutral'}>{image?.is_active ? 'Đang dùng' : 'Mặc định'}</StatusBadge></div><div className="image-preview">{image?.is_active ? <img src={`${api.baseUrl}/images/${definition.key}/file?v=${encodeURIComponent(image.updated_at || '')}`} alt={image.alt_text || definition.label} /> : <Empty>Chưa tải ảnh</Empty>}</div><p className="image-file-meta"><small>{image?.filename || 'Chưa có tệp'} · {formatDate(image?.updated_at)}</small></p><label className="form-group">Văn bản thay thế<input maxLength={255} placeholder={`Mô tả ${definition.label.toLocaleLowerCase('vi')}`} value={alt[definition.key] || ''} onChange={e => setAlt({ ...alt, [definition.key]: e.target.value })} /></label><div className="card-actions"><label className="btn btn-primary file-button"><Icon name="upload" /> Tải ảnh<input hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; try { await api.upload(`/images/${definition.key}`, file, { altText: alt[definition.key] || '' }); await load(); await app.reload(); app.notify('Đã cập nhật ảnh', 'success') } catch (error) { app.notify(errorMessage(error), 'error') } }} /></label>{image && <button className="btn btn-secondary" onClick={async () => { try { await api.mutate(`/images/${definition.key}/meta`, 'PUT', { altText: alt[definition.key], isActive: true }); await load(); app.notify('Đã lưu mô tả', 'success') } catch (error) { app.notify(errorMessage(error), 'error') } }}>Lưu mô tả</button>}{image && <ConfirmButton message={`Gỡ ${definition.label}?`} onConfirm={async () => { try { await api.mutate(`/images/${definition.key}`, 'DELETE'); await load(); await app.reload(); app.notify('Đã gỡ ảnh', 'success') } catch (error) { app.notify(errorMessage(error), 'error') } }}><Icon name="trash" size={14} /> Gỡ</ConfirmButton>}</div></article> })}</div>}
  </section>
}
