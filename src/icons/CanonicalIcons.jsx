import AppIcon from './AppIcon.jsx'
import {
  APPLY_AND_DROP_ICON,
  ARROW_DOWN_ICON,
  ARROW_UP_ICON,
  BATCH_ICON,
  BATCH_SELECT_ICON,
  BOLT_ICON,
  BRANCH_ICON,
  BRANCH_SWITCH_ICON,
  CHECK_ICON,
  CLOCK_ICON,
  CLONE_REPO_ICON,
  CLOSE_ICON,
  CODE_FILE_ICON,
  COLLAPSE_ICON,
  COMMIT_HISTORY_ICON,
  COMMIT_ICON,
  COPY_ICON,
  DASHBOARD_ICON,
  DELETE_ICON,
  DIFF_ICON,
  DIRECTION_DIVERGED_ICON,
  DIRECTION_DOWN_ICON,
  DIRECTION_REMOTE_ICON,
  DIRECTION_SYNCED_ICON,
  DIRECTION_UP_ICON,
  EDIT_ICON,
  EXPAND_ICON,
  EXTERNAL_LINK_ICON,
  FILE_ICON,
  FOLDER_ICON,
  GROUP_CHEVRON_ICON,
  IMAGE_FILE_ICON,
  INFO_ICON,
  LIST_LAYOUT_ICON,
  MASONRY_LAYOUT_ICON,
  MARKDOWN_ICON,
  MINUS_ICON,
  MISSING_REPO_WARNING_ICON,
  MONITOR_ICON,
  MOON_ICON,
  MORE_ICON,
  NAV_CHEVRON_ICON,
  PAUSE_ICON,
  PLAY_ICON,
  PLUS_ICON,
  REFRESH_ICON,
  REFRESH_SYNC_ICON,
  REVIEW_ICON,
  SEARCH_ICON,
  SELECT_CHEVRON_ICON,
  SETTINGS_ICON,
  SIDEBAR_PANEL_ICON,
  SPLIT_VIEW_ICON,
  STASH_ICON,
  SUCCESS_ICON,
  SUN_ICON,
  TERMINAL_ICON,
  USER_ICON,
  VIEW_ICON,
  WARNING_ICON,
} from './iconDefinitions.js'

function iconComponent(icon) {
  return function CanonicalIcon({ className = '', size, style }) {
    return <AppIcon icon={icon} className={className} size={size} style={style} />
  }
}

export const ApplyAndDropIcon = iconComponent(APPLY_AND_DROP_ICON)
export const ArrowDownIcon = iconComponent(ARROW_DOWN_ICON)
export const ArrowUpIcon = iconComponent(ARROW_UP_ICON)
export const BatchIcon = iconComponent(BATCH_ICON)
export const BatchSelectIcon = iconComponent(BATCH_SELECT_ICON)
export const BoltIcon = iconComponent(BOLT_ICON)
export const BranchIcon = iconComponent(BRANCH_ICON)
export const BranchSwitchIcon = iconComponent(BRANCH_SWITCH_ICON)
export const CheckIcon = iconComponent(CHECK_ICON)
export const ClockIcon = iconComponent(CLOCK_ICON)
export const CloneRepoIcon = iconComponent(CLONE_REPO_ICON)
export const CloseIcon = iconComponent(CLOSE_ICON)
export const CodeFileIcon = iconComponent(CODE_FILE_ICON)
export const CollapseIcon = iconComponent(COLLAPSE_ICON)
export const CommitHistoryIcon = iconComponent(COMMIT_HISTORY_ICON)
export const CommitIcon = iconComponent(COMMIT_ICON)
export const CopyIcon = iconComponent(COPY_ICON)
export const DashboardIcon = iconComponent(DASHBOARD_ICON)
export const DeleteIcon = iconComponent(DELETE_ICON)
export const DiffIcon = iconComponent(DIFF_ICON)
export const DirectionDivergedIcon = iconComponent(DIRECTION_DIVERGED_ICON)
export const DirectionDownIcon = iconComponent(DIRECTION_DOWN_ICON)
export const DirectionRemoteIcon = iconComponent(DIRECTION_REMOTE_ICON)
export const DirectionSyncedIcon = iconComponent(DIRECTION_SYNCED_ICON)
export const DirectionUpIcon = iconComponent(DIRECTION_UP_ICON)
export const EditIcon = iconComponent(EDIT_ICON)
export const ExpandIcon = iconComponent(EXPAND_ICON)
export const ExternalLinkIcon = iconComponent(EXTERNAL_LINK_ICON)
export const FileIcon = iconComponent(FILE_ICON)
export const FolderIcon = iconComponent(FOLDER_ICON)
export const GroupChevronIcon = iconComponent(GROUP_CHEVRON_ICON)
export const ImageFileIcon = iconComponent(IMAGE_FILE_ICON)
export const InfoIcon = iconComponent(INFO_ICON)
export const ListLayoutIcon = iconComponent(LIST_LAYOUT_ICON)
export const MasonryLayoutIcon = iconComponent(MASONRY_LAYOUT_ICON)
export const MarkdownIcon = iconComponent(MARKDOWN_ICON)
export const MinusIcon = iconComponent(MINUS_ICON)
export const MissingRepoWarningIcon = iconComponent(MISSING_REPO_WARNING_ICON)
export const MonitorIcon = iconComponent(MONITOR_ICON)
export const MoonIcon = iconComponent(MOON_ICON)
export const MoreIcon = iconComponent(MORE_ICON)
export const NavChevronIcon = iconComponent(NAV_CHEVRON_ICON)
export const PauseIcon = iconComponent(PAUSE_ICON)
export const PlayIcon = iconComponent(PLAY_ICON)
export const PlusIcon = iconComponent(PLUS_ICON)
export const RefreshIcon = iconComponent(REFRESH_ICON)
export const RefreshSyncIcon = iconComponent(REFRESH_SYNC_ICON)
export const ReviewIcon = iconComponent(REVIEW_ICON)
export const SearchIcon = iconComponent(SEARCH_ICON)
export const SelectChevronIcon = iconComponent(SELECT_CHEVRON_ICON)
export const SettingsIcon = iconComponent(SETTINGS_ICON)
export const SidebarPanelIcon = iconComponent(SIDEBAR_PANEL_ICON)
export const SplitViewIcon = iconComponent(SPLIT_VIEW_ICON)
export const StashIcon = iconComponent(STASH_ICON)
export const SuccessIcon = iconComponent(SUCCESS_ICON)
export const SunIcon = iconComponent(SUN_ICON)
export const TerminalIcon = iconComponent(TERMINAL_ICON)
export const UserIcon = iconComponent(USER_ICON)
export const ViewIcon = iconComponent(VIEW_ICON)
export const WarningIcon = iconComponent(WARNING_ICON)
