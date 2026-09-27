import AppIcon from '../icons/AppIcon.jsx'
import { BOOTSTRAP_LOADING_MARK } from './bootstrapIllustrations.js'

export default function BootstrapLoadingMark({ className = '', size, style }) {
  return <AppIcon icon={BOOTSTRAP_LOADING_MARK} className={className} size={size} style={style} />
}
