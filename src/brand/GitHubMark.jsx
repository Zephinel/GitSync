import AppIcon from '../icons/AppIcon.jsx'
import { GITHUB_MARK } from './brandDefinitions.js'

export default function GitHubMark({ className = '', size, style }) {
  return <AppIcon icon={GITHUB_MARK} className={className} size={size} style={style} />
}
