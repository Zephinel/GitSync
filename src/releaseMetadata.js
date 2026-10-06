/*
 * 「关于」里显示的发布日历日期，按 Asia/Shanghai（UTC+08:00）计的发布当天。
 *
 * 这个常量是**唯一 authority**，每次发版必须手动跟着改——它不会自己更新，
 * 而版本号是运行时从二进制读的（getVersion），所以两者会漂移：
 * 曾经出现过「0.1.4 (2026-09-29)」这种新版本号配旧日期的怪东西。
 *
 * releaseMetadata.test.js 里有一条漂移护栏：它从 CHANGELOG.md 里读出当前版本
 * 对应条目的日期，和这里比对。发版时只改一处会立刻失败。
 */
export const RELEASE_DATE = '2026-10-06'

export const formatReleaseVersion = (version) => {
  const normalizedVersion = typeof version === 'string' ? version.trim() : ''
  if (!normalizedVersion || normalizedVersion === '未知版本' || normalizedVersion === '读取中...') {
    return normalizedVersion || '未知版本'
  }
  return `${normalizedVersion} (${RELEASE_DATE})`
}
