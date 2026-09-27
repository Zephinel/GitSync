import AppIcon from './icons/AppIcon.jsx'
import { BRANCH_SWITCH_ICON } from './icons/iconDefinitions.js'

export { BRANCH_SWITCH_ICON } from './icons/iconDefinitions.js'

export default function BranchSwitchIcon({ className = '' }) {
  const classes = ['branch-switch-icon', className].filter(Boolean).join(' ')
  return <AppIcon icon={BRANCH_SWITCH_ICON} className={classes} />
}
