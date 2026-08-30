import { DatabaseCore } from './core.js'

export class ImagesMethods extends DatabaseCore {
  // ── Site Images (self-service image editor) ───────────────────────────────
  async getSiteImages() {
    const result = await this.query(`
      SELECT id, key, filename, storage_path, content_type, file_size,
             alt_text, is_active, uploaded_by,
             uploaded_at,
             updated_at
      FROM site_images
      ORDER BY
        CASE key WHEN 'hero_banner' THEN 1 WHEN 'logo' THEN 2 WHEN 'favicon' THEN 3 WHEN 'background' THEN 4 ELSE 5 END,
        id
    `)
    return result.rows
  }


  async getSiteImageByKey(key) {
    const result = await this.query(`
      SELECT id, key, filename, storage_path, content_type, file_size,
             alt_text, is_active, uploaded_by,
             uploaded_at,
             updated_at
      FROM site_images WHERE key = $1
    `, [key])
    return result.rows[0] || null
  }


  async upsertSiteImage({ key, filename, storage_path, content_type, file_size, alt_text = '', uploaded_by }) {
    await this.query(`
      INSERT INTO site_images (key, filename, storage_path, content_type, file_size, alt_text, is_active, uploaded_by, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, true, $7, NOW())
      ON CONFLICT (key) DO UPDATE SET
        filename = $2, storage_path = $3, content_type = $4, file_size = $5,
        alt_text = $6, uploaded_by = $7, updated_at = NOW()
    `, [key, filename, storage_path, content_type, file_size, alt_text, uploaded_by])
  }


  async updateSiteImageMeta(key, { altText, isActive }) {
    const updates = []
    const params = []
    let idx = 1
    if (altText !== undefined) { updates.push(`alt_text = $${idx}`); params.push(altText); idx++ }
    if (isActive !== undefined) { updates.push(`is_active = $${idx}`); params.push(isActive); idx++ }
    if (updates.length > 0) {
      updates.push(`updated_at = NOW()`)
      params.push(key)
      await this.query(`UPDATE site_images SET ${updates.join(', ')} WHERE key = $${idx}`, params)
    }
  }


  // ── Season conclusion image ────────────────────────────────────────────────
  async uploadSeasonConclusionImage(seasonId, { filename, storage_path, content_type, file_size }) {
    await this.query(`
      UPDATE seasons SET
        conclusion_image_path = $1,
        conclusion_image_filename = $2,
        conclusion_image_content_type = $3,
        conclusion_image_size = $4
      WHERE id = $5
    `, [storage_path, filename, content_type, file_size, seasonId])
  }


  async deleteSeasonConclusionImage(seasonId) {
    await this.query(`
      UPDATE seasons SET
        conclusion_image_path = NULL,
        conclusion_image_filename = NULL,
        conclusion_image_content_type = NULL,
        conclusion_image_size = NULL
      WHERE id = $1
    `, [seasonId])
  }


}
