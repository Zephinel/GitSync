const IMAGE_DIFF_EXTENSIONS = new Set([
  'png', 'apng',
  'jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg', 'pjp',
  'gif', 'webp', 'avif', 'svg',
  'bmp', 'dib', 'ico', 'cur',
  'tif', 'tiff',
  'heic', 'heics', 'heif', 'heifs', 'hif',
  'jxl', 'jp2', 'jpf', 'jpx', 'jpm', 'mj2', 'j2k', 'j2c',
  'icns', 'tga', 'icb', 'vda', 'vst', 'dds', 'qoi',
  'pnm', 'pam', 'pbm', 'pgm', 'ppm',
  'hdr', 'pic', 'rgbe', 'xyze', 'exr',
  'psd', 'psb', 'ktx', 'ktx2', 'wbmp', 'ff', 'farbfeld',
])

const IMAGE_BACKUP_SUFFIXES = new Set([
  'bak', 'backup', 'old', 'orig', 'original', 'copy', 'tmp', 'temp',
])

function getFileName(path) {
  const normalized = String(path || '').trim().toLowerCase().replace(/\\/g, '/')
  return normalized.split('/').pop() || ''
}

export function getImageDiffExtension(path) {
  const parts = getFileName(path).split('.').filter(Boolean)
  if (parts.length < 2) return ''

  while (parts.length > 1 && IMAGE_BACKUP_SUFFIXES.has(parts[parts.length - 1])) {
    parts.pop()
  }
  return parts.length > 1 ? parts[parts.length - 1] : ''
}

export function isImageDiffPath(path) {
  return IMAGE_DIFF_EXTENSIONS.has(getImageDiffExtension(path))
}

export function isImageDiffCandidate(file) {
  if (!file || typeof file !== 'object') return false
  const path = file.path || file.old_path || file.oldPath
  if (isImageDiffPath(path)) return true
  return file.is_binary === true || file.isBinary === true
}

export function getImageDiffSupportedExtensions() {
  return [...IMAGE_DIFF_EXTENSIONS]
}
