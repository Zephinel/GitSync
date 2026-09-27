import { NavChevronIcon } from './CanonicalIcons.jsx'

const ROTATIONS = Object.freeze({
  right: 0,
  down: 90,
  left: 180,
  up: 270,
})

export default function DirectionalChevronIcon({ className = '', direction = 'right' }) {
  const rotation = ROTATIONS[direction] ?? 0
  return (
    <NavChevronIcon
      className={className}
      style={{
        transform: `rotate(${rotation}deg)`,
        transformOrigin: 'center',
        transformBox: 'view-box',
      }}
    />
  )
}
