import { describe, expect, it } from 'vitest'
import { join } from 'path'
import {
  resolveAbsoluteUploadPath,
  resolveUploadPath,
  toStoredUploadPath,
  uploadRoot
} from '../../lib/upload-storage.js'

describe('upload storage containment', () => {
  it('resolves logical upload paths below the configured root', () => {
    expect(resolveUploadPath('cups/12/image.jpg')).toBe(join(uploadRoot, 'cups/12/image.jpg'))
  })

  it('maps legacy data/uploads paths to the persistent root', () => {
    expect(resolveUploadPath('/data/uploads/seasons/3/image.png'))
      .toBe(join(uploadRoot, 'seasons/3/image.png'))
  })

  it('rejects traversal outside the configured root', () => {
    expect(resolveUploadPath('../../etc/passwd')).toBeNull()
  })

  it('stores only logical relative paths', () => {
    expect(toStoredUploadPath(join(uploadRoot, 'images', 'hero.png'))).toBe('images/hero.png')
    expect(() => toStoredUploadPath('/tmp/not-an-upload.png')).toThrow()
  })

  it('validates absolute upload paths that stay within the root', () => {
    const inside = join(uploadRoot, 'cups', '12', 'img.png')
    expect(resolveAbsoluteUploadPath(inside)).toBe(inside)
  })

  it('rejects absolute paths that escape the upload root', () => {
    expect(resolveAbsoluteUploadPath('/tmp/escape.png')).toBeNull()
    expect(resolveAbsoluteUploadPath(join(uploadRoot, '..', '..', 'etc', 'passwd'))).toBeNull()
  })
})
