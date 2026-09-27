export function stashOperationNeedsProjectionRefresh(result) {
  const status = String(result?.status || '')
  return Boolean(
    result?.mutated
    || result?.worktreeChanged
    || result?.needsConfirmation
    || status === 'partial'
    || status === 'conflict'
    || status === 'needs_confirmation'
    || status === 'stale'
  )
}

export function dispatchStashProjectionRefresh(onChanged, result) {
  if (typeof onChanged !== 'function') return
  try {
    void Promise.resolve(onChanged(result)).catch(() => {
      // The Git operation and repository snapshot are already authoritative.
      // Projection refresh failures must never keep a mutation dialog busy or open.
    })
  } catch {
    // Synchronous projection callbacks are isolated for the same reason.
  }
}

export function dispatchStashOperationProjectionRefresh(onChanged, result) {
  if (!stashOperationNeedsProjectionRefresh(result)) return
  dispatchStashProjectionRefresh(onChanged, result)
}
