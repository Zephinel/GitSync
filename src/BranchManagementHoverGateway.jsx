import { useEffect } from 'react'
import { subscribeBranchManagementOpen } from './branchManagementAppBridge.js'

export default function BranchManagementHoverGateway({ disabled = false, onOpen }) {
  useEffect(() => {
    if (disabled) return undefined
    return subscribeBranchManagementOpen((detail) => onOpen?.(detail))
  }, [disabled, onOpen])

  return null
}
