// Release calendar dates are determined in Asia/Shanghai (UTC+08:00).
export const RELEASE_DATE = '2026-09-29'

export const formatReleaseVersion = (version) => {
  const normalizedVersion = typeof version === 'string' ? version.trim() : ''
  if (!normalizedVersion || normalizedVersion === '未知版本' || normalizedVersion === '读取中...') {
    return normalizedVersion || '未知版本'
  }
  return `${normalizedVersion} (${RELEASE_DATE})`
}
