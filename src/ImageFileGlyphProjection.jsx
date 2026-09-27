import { useEffect } from 'react'
import { FILE_GLYPH_DEFINITIONS, FILE_GLYPH_KIND, resolveFileGlyphKind } from './fileGlyphIcons.js'
import { createIconSvgElement } from './icons/iconDom.js'
import './ImageFileGlyphProjection.css'

// Authored through the shared tooltip authority instead of `title`: this
// projection re-syncs on DOM mutations, and a mutable `title` would race the
// tooltip layer's native-hint interception.
const GLYPH_TOOLTIP_ATTRIBUTE = 'data-app-tooltip'
const GLYPH_TOOLTIP_TEXT = '图片文件'

function readGlyphPath(glyph) {
  const explicitOwner = glyph.closest('[data-file-path]')
  if (explicitOwner?.hasAttribute('data-file-path')) {
    return explicitOwner.getAttribute('data-file-path') || ''
  }

  const fileItem = glyph.closest('.commit-diff-file-item')
  const itemPath = fileItem?.querySelector('.commit-diff-file-item__path')
  const itemValue = String(itemPath?.getAttribute?.('title') || itemPath?.textContent || '').trim()
  if (itemValue) return itemValue

  const fileHeader = glyph.closest('.commit-diff-file-header__identity')
  const headerPath = fileHeader?.querySelector('.commit-diff-file-header__path')
  return String(headerPath?.getAttribute?.('title') || headerPath?.textContent || '').trim()
}

function syncGlyph(glyph) {
  if (!(glyph instanceof HTMLElement)) return
  const path = readGlyphPath(glyph)
  const kind = resolveFileGlyphKind(path)
  const icon = FILE_GLYPH_DEFINITIONS[kind]
  const isImage = kind === FILE_GLYPH_KIND.image

  if (glyph.querySelector(':scope > .image-file-glyph__icon')) {
    // React already rendered the canonical glyph; only keep the image markers in sync.
    if (isImage) glyph.dataset.imageFileGlyph = 'true'
    else delete glyph.dataset.imageFileGlyph
    if (isImage) {
      if (glyph.getAttribute(GLYPH_TOOLTIP_ATTRIBUTE) !== GLYPH_TOOLTIP_TEXT) glyph.setAttribute(GLYPH_TOOLTIP_ATTRIBUTE, GLYPH_TOOLTIP_TEXT)
    } else if (glyph.hasAttribute(GLYPH_TOOLTIP_ATTRIBUTE)) {
      glyph.removeAttribute(GLYPH_TOOLTIP_ATTRIBUTE)
    }
    return
  }

  glyph.replaceChildren(createIconSvgElement(icon, {
    className: 'image-file-glyph__icon',
    documentRef: glyph.ownerDocument,
  }))
  if (isImage) {
    glyph.dataset.imageFileGlyph = 'true'
    if (glyph.getAttribute(GLYPH_TOOLTIP_ATTRIBUTE) !== GLYPH_TOOLTIP_TEXT) glyph.setAttribute(GLYPH_TOOLTIP_ATTRIBUTE, GLYPH_TOOLTIP_TEXT)
  } else {
    delete glyph.dataset.imageFileGlyph
    if (glyph.hasAttribute(GLYPH_TOOLTIP_ATTRIBUTE)) glyph.removeAttribute(GLYPH_TOOLTIP_ATTRIBUTE)
  }
}

function syncImageFileGlyphs() {
  document
    .querySelectorAll('.commit-diff-stage .commit-diff-file-glyph')
    .forEach(syncGlyph)
}

export default function ImageFileGlyphProjection() {
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    let frame = 0
    const schedule = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        syncImageFileGlyphs()
      })
    }

    const observer = new MutationObserver(schedule)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'title', 'aria-pressed', 'data-file-path', 'data-app-tooltip'],
    })
    schedule()

    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])

  return null
}
