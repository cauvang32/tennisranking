import { useEffect, useState } from 'react'
import type { SiteImage } from '../../shared/domain'
import { api } from '../api/client'
import { useApp } from '../app/app-context'

// The image is served with `Cache-Control: immutable` (1y), so the URL must
// change on every upload or existing visitors keep the stale image. The file
// endpoint resolves the current storage_path from the DB, so appending the
// row's updated_at busts the browser cache exactly like the editor preview does.
const heroFileUrl = (image: SiteImage) =>
  `${api.baseUrl}/images/hero_banner/file?v=${encodeURIComponent(image.updated_at || image.filename || 'latest')}`

/**
 * Full-width cover image ("Ảnh bìa") shown at the very top of the page, above
 * the sticky header. Only renders when an admin has uploaded and activated a
 * hero banner — otherwise the page is unchanged (hardcoded emoji header).
 */
export function HeroBanner() {
  const { revision } = useApp()
  const [hero, setHero] = useState<SiteImage | null>(null)

  useEffect(() => {
    let cancelled = false
    api.images()
      .then(rows => {
        if (cancelled) return
        const active = rows.find(image => image.key === 'hero_banner' && image.is_active)
        setHero(active || null)
      })
      .catch(() => { if (!cancelled) setHero(null) })
    return () => { cancelled = true }
  }, [revision])

  if (!hero) return null

  return (
    <div className="hero-banner">
      <div className="hero-banner-inner">
        <img className="hero-banner-image" src={heroFileUrl(hero)} alt={hero.alt_text || 'Ảnh bìa'} />
      </div>
    </div>
  )
}
