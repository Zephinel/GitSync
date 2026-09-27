import { DASHBOARD_REPO_FILTER_MODE, normalizeDashboardRepoFilterMode } from './repoStatusUtils.js'
import allLightImage from './assets/dashboard-empty-states/light/all.webp'
import syncedLightImage from './assets/dashboard-empty-states/light/synced.webp'
import newChangesLightImage from './assets/dashboard-empty-states/light/new-changes.webp'
import localChangesLightImage from './assets/dashboard-empty-states/light/local-changes.webp'
import newAndLocalChangesLightImage from './assets/dashboard-empty-states/light/new-and-local-changes.webp'
import allDarkImage from './assets/dashboard-empty-states/dark/all.webp'
import syncedDarkImage from './assets/dashboard-empty-states/dark/synced.webp'
import newChangesDarkImage from './assets/dashboard-empty-states/dark/new-changes.webp'
import localChangesDarkImage from './assets/dashboard-empty-states/dark/local-changes.webp'
import newAndLocalChangesDarkImage from './assets/dashboard-empty-states/dark/new-and-local-changes.webp'

export const DASHBOARD_EMPTY_STATE_CONFIG = Object.freeze({
  [DASHBOARD_REPO_FILTER_MODE.all]: {
    lightImage: allLightImage,
    darkImage: allDarkImage,
    title: '还没有导入仓库',
    description: '添加一个本地仓库或从远程克隆，开始使用 GitSync 管理同步状态。',
  },
  [DASHBOARD_REPO_FILTER_MODE.synced]: {
    lightImage: syncedLightImage,
    darkImage: syncedDarkImage,
    title: '暂无已同步仓库',
    description: '当前没有符合“已同步”状态的仓库。',
  },
  [DASHBOARD_REPO_FILTER_MODE.newChanges]: {
    lightImage: newChangesLightImage,
    darkImage: newChangesDarkImage,
    title: '所有仓库都很干净',
    description: '当前没有待拉取、待推送或正在同步的仓库。',
  },
  [DASHBOARD_REPO_FILTER_MODE.localChanges]: {
    lightImage: localChangesLightImage,
    darkImage: localChangesDarkImage,
    title: '没有未提交的本地改动',
    description: '当前工作区都很整洁，没有待提交内容。',
  },
  [DASHBOARD_REPO_FILTER_MODE.newAndLocalChanges]: {
    lightImage: newAndLocalChangesLightImage,
    darkImage: newAndLocalChangesDarkImage,
    title: '没有待处理的改动',
    description: '当前没有待拉取、待推送或本地未提交改动的仓库。',
  },
})

export function getDashboardFilterEmptyState(filterMode) {
  const normalizedFilterMode = normalizeDashboardRepoFilterMode(filterMode)
  return DASHBOARD_EMPTY_STATE_CONFIG[normalizedFilterMode]
    || DASHBOARD_EMPTY_STATE_CONFIG[DASHBOARD_REPO_FILTER_MODE.all]
}

export function getDashboardEmptyStateImage(config, resolvedTheme) {
  return resolvedTheme === 'dark' ? config.darkImage : config.lightImage
}
